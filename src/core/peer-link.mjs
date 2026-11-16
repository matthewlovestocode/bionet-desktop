// @ts-check
/**
 * This device's connection to the lab's web peer.
 *
 * It is allowed to fail. The app works with no peer at all; this only carries entries to and from
 * the lab's address when it can, says how that is going, and keeps trying when it cannot.
 *
 * The exchange is the one `@biolibs/bionet`'s `sync.ts` describes. The peer sends a number, this
 * signs it with the device's key, and if that key is on the lab's roster the two swap whatever the
 * other lacks. A peer that holds nothing knows no members, so on being refused this sends what it
 * holds and asks again: that is how a lab's first entries get there at all.
 */
import { EventEmitter } from "node:events";
import { entriesBeyond, haveOf, readMessage, signHello } from "@biolibs/bionet";

/** How many entries go in one message. */
const BATCH = 500;

/**
 * @typedef {"offline" | "connecting" | "waiting" | "syncing" | "synced"} LinkStatus
 *   `waiting` means the peer answered and this device's key is not on the roster it holds.
 */

export class PeerLink extends EventEmitter {
  /**
   * @param {{ url: string, lab: string, key: import("@biolibs/opencloning").SigningKey,
   *           held: () => import("@biolibs/bionet").SignedEntry[],
   *           take: (entries: unknown[]) => Promise<number> }} options - Where the peer is, which lab,
   *   this device's key, what it holds, and how to hand it what arrives.
   */
  constructor({ url, lab, key, held, take }) {
    super();
    this.url = url; this.lab = lab; this.key = key; this.held = held; this.take = take;
    /** @type {LinkStatus} */ this.status = "offline";
    /** @type {string | null} */ this.problem = null;
    /** @type {string | null} */ this.lastSynced = null;
    /** @type {import("@biolibs/bionet").Have | null} What the peer holds, as far as this knows. */
    this.peerHas = null;
    /** @type {WebSocket | null} */ this.ws = null;
    this.stopped = true;
    this.delay = 1_000;
    /** @type {ReturnType<typeof setTimeout> | null} */ this.retry = null;
    /** @type {Promise<unknown>} */ this.turn = Promise.resolve();
    /** @type {((value: { ok: boolean, reason: string | null }) => void) | null} */ this.publishing = null;
  }

  /** @returns {number} How many entries held here the peer is not known to have. */
  get pending() {
    return this.peerHas === null ? this.held().length : entriesBeyond(this.held(), this.peerHas).length;
  }

  /** Start, and keep trying. */
  start() {
    this.stopped = false;
    this.open();
  }

  /** Stop, and stop trying. */
  stop() {
    this.stopped = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    this.push = () => {};
    this.sendInventory = () => {};
    this.say("offline", null);
  }

  /** @param {LinkStatus} status @param {string | null} [problem] */
  say(status, problem = this.problem) {
    this.status = status;
    this.problem = problem;
    this.emit("change");
  }

  open() {
    if (this.stopped) return;
    this.say("connecting", null);
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (cause) {
      this.say("offline", `That is not an address a peer can be reached at: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    this.ws = ws;
    let nonce = "";
    let welcomed = false;
    let pushedEverything = false;
    const send = (/** @type {unknown} */ message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
    const sendEntries = (/** @type {import("@biolibs/bionet").SignedEntry[]} */ entries) => {
      for (let at = 0; at < entries.length; at += BATCH) send({ type: "entries", entries: entries.slice(at, at + BATCH) });
    };
    const hello = async () => send({ type: "hello", have: haveOf(this.held()), signature: await signHello(this.key, this.lab, nonce) });

    /** Send what the peer lacks. Called on welcome and whenever something is written here. */
    this.push = () => {
      // Only over a connection that is open. Counting an entry as delivered because it was written
      // into a socket that had already closed would leave it unsent and reported as sent.
      if (!welcomed || this.peerHas === null || ws.readyState !== ws.OPEN) return;
      const lacking = entriesBeyond(this.held(), this.peerHas);
      if (lacking.length === 0) return;
      this.peerHas = haveOf(this.held());         // what it will have, once it has kept these
      this.say("syncing");
      sendEntries(lacking);
    };
    /** @param {import("@biolibs/bionet").SignedInventory} signed */
    this.sendInventory = (signed) => send({ type: "inventory", signed });

    ws.addEventListener("message", (event) => {
      this.turn = this.turn.then(async () => {
        let message;
        try {
          message = readMessage(String(event.data));
        } catch {
          return;                                   // a peer that says something else is ignored, not obeyed
        }
        if (message.type === "challenge") {
          if (message.lab !== this.lab) {
            this.say("waiting", "That peer serves a different lab.");
            return;
          }
          nonce = message.nonce;
          await hello();
        } else if (message.type === "refused") {
          if (message.code === "not-a-member") {
            if (!pushedEverything && this.held().length > 0) {
              pushedEverything = true;
              sendEntries(this.held());
            } else {
              this.say("waiting", "This device's key is not on the roster the lab's peer holds yet. A keeper has to add it and sync.");
              // Ask again in a few seconds, on the same connection: the keeper may be doing it now.
              setTimeout(() => { if (this.ws === ws && !welcomed) void hello(); }, 4_000);
            }
          } else if (message.code === "bad-inventory" && this.publishing !== null) {
            this.publishing({ ok: false, reason: message.reason });
            this.publishing = null;
          } else {
            this.say(this.status, message.reason);
          }
        } else if (message.type === "welcome") {
          welcomed = true;
          this.delay = 1_000;
          this.peerHas = message.have;
          this.say("syncing", null);
          this.push();
          if (this.pending === 0) this.settled();
        } else if (message.type === "entries") {
          await this.take(message.entries);
          if (welcomed && this.peerHas !== null) {
            // Whatever the peer just sent, it has. Count it, so it is not offered straight back.
            for (const { entry } of message.entries) {
              this.peerHas[entry.author] = Math.max(this.peerHas[entry.author] ?? -1, entry.seq);
            }
            if (this.pending === 0) this.settled();
          }
        } else if (message.type === "kept") {
          if (!welcomed) await hello();             // the peer now knows the roster; ask again
          else if (this.pending === 0) this.settled();
        } else if (message.type === "published" && this.publishing !== null) {
          this.publishing({ ok: true, reason: null });
          this.publishing = null;
        }
      });
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.push = () => {};
      this.sendInventory = () => {};
      if (this.publishing !== null) { this.publishing({ ok: false, reason: "The connection to the lab's peer was lost." }); this.publishing = null; }
      if (this.stopped) return;
      this.say("offline", this.status === "waiting" ? this.problem : null);
      this.retry = setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    });
    ws.addEventListener("error", () => {});       // the close that follows is what is acted on
  }

  settled() {
    this.lastSynced = new Date().toISOString();
    this.say("synced", null);
  }

  /** Replaced while a connection is open. */
  push() {}

  /** @param {import("@biolibs/bionet").SignedInventory} _signed Replaced while a connection is open. */
  sendInventory(_signed) {}

  /**
   * Ask the peer to publish an inventory.
   * @param {import("@biolibs/bionet").SignedInventory} signed - The inventory, signed by this device.
   * @returns {Promise<{ ok: boolean, reason: string | null }>} Whether it was published, and why not.
   */
  publish(signed) {
    if (this.status !== "synced" && this.status !== "syncing") {
      return Promise.resolve({ ok: false, reason: "Not connected to the lab's peer as a member." });
    }
    return new Promise((resolve) => {
      this.publishing = resolve;
      this.sendInventory(signed);
      setTimeout(() => { if (this.publishing === resolve) { this.publishing = null; resolve({ ok: false, reason: "The lab's peer did not answer." }); } }, 15_000);
    });
  }
}
