// @ts-check
/**
 * One person's device in one lab: its key, what it holds, and everything it can do.
 *
 * This is the whole app without a window. It has no Electron in it, so it runs under plain Node,
 * which is how it is tested: two of these and a web peer are a lab.
 *
 * Everything a member does becomes a signed entry in this device's own log, is kept on disk, and is
 * offered to the lab's web peer when there is one to offer it to. Nothing waits for the network. What
 * the lab holds is worked out from the entries each time they change, by `mergeLog`, which is why two
 * devices that have been apart agree the moment they have each other's entries.
 */
import { EventEmitter } from "node:events";
import { addItem, addPart, addToRoster, adjustItem, entryId, fetchInventory, foundLab, isMember, mergeLog,
         newItemId, nextEntry, offerPart, publicInventory, recountItem, retireItem, setField, signInventory,
         takeEntries } from "@biolibs/bionet";
import { exportSigningKey, generateSigningKey, importSigningKey, keyFingerprint } from "@biolibs/opencloning";
import { PeerLink } from "./peer-link.mjs";
import { openStore } from "./store.mjs";

/**
 * @typedef {{ load: () => Promise<string | null>, save: (exported: string) => Promise<void> }} KeyKeeper
 *   Where the device's private key lives. The app gives one backed by the operating system's keychain.
 */

/** @param {string} peer - The peer's socket address. @returns {string} The web address it serves from. */
export function originOf(peer) {
  const url = new URL(peer);
  return `${url.protocol === "ws:" ? "http:" : "https:"}//${url.host}`;
}

/**
 * Read an invitation: the peer's address, then `#`, then the lab's ID.
 * @param {string} invite - What a keeper sent.
 * @returns {{ peer: string, lab: string }} Where the lab's peer is, and which lab.
 */
export function readInvite(invite) {
  const [peer, lab] = invite.trim().split("#");
  if (peer === undefined || lab === undefined || !/^[0-9a-f]{64}$/.test(lab)) {
    throw new Error("That is not an invitation. One looks like wss://a-lab.example/sync#, followed by 64 letters and digits.");
  }
  const url = new URL(peer);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("An invitation's address starts with wss://.");
  return { peer, lab };
}

export class Lab extends EventEmitter {
  /**
   * @param {{ dir: string, keys: KeyKeeper, fetch?: typeof globalThis.fetch }} options - Where to keep
   *   things, where the key lives, and (for tests) something to fetch the published inventory with.
   */
  constructor({ dir, keys, fetch }) {
    super();
    this.dir = dir; this.keys = keys; this.fetch = fetch;
    /** @type {import("@biolibs/bionet").SignedEntry[]} */ this.held = [];
    /** @type {import("@biolibs/bionet").LabState | null} */ this.state = null;
    /** @type {PeerLink | null} */ this.link = null;
    /** @type {Map<string, string>} */ this.fingerprints = new Map();
    /** @type {Promise<unknown>} One change at a time, so two cannot both write the same place in the log. */
    this.turn = Promise.resolve();
  }

  /** Open the store, load or make the device's key, and work the lab out from what is held. */
  async open() {
    this.store = openStore(this.dir);
    let exported = await this.keys.load();
    if (exported === null) {
      exported = await exportSigningKey(await generateSigningKey());
      await this.keys.save(exported);
    }
    this.key = await importSigningKey(exported);
    this.fingerprint = await keyFingerprint(this.key.publicKey);
    this.held = this.store.entries();
    await this.remerge();
    this.connect();
    return this;
  }

  /** @returns {string | null} The lab this device is in. */
  get labId() { return this.store.setting("lab"); }

  /** Work the lab out again from what is held, and tell whoever is listening. */
  async remerge() {
    const lab = this.labId;
    this.state = lab === null ? null : await mergeLog(this.held, { lab });
    for (const one of this.state?.roster ?? []) {
      if (!this.fingerprints.has(one.key)) this.fingerprints.set(one.key, await keyFingerprint(one.key));
    }
    this.emit("change");
  }

  /** Start talking to the lab's peer, if there is a lab and an address for it. */
  connect() {
    this.link?.stop();
    this.link = null;
    const lab = this.labId;
    const url = this.store.setting("peer");
    if (lab === null || url === null) return;
    this.link = new PeerLink({ url, lab, key: this.key, held: () => this.held, take: (entries) => this.take(entries) });
    this.link.on("change", () => this.emit("change"));
    this.link.start();
  }

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  inTurn(work) {
    const next = this.turn.then(work, work);
    this.turn = next.catch(() => {});
    return next;
  }

  /**
   * Take entries that arrived from somewhere else.
   * @param {unknown[]} incoming - What arrived.
   * @returns {Promise<number>} How many were kept.
   */
  take(incoming) {
    return this.inTurn(async () => {
      const lab = this.labId;
      if (lab === null) return 0;
      const { kept } = await takeEntries(lab, this.held, incoming);
      if (kept.length === 0) return 0;
      this.store.add(await Promise.all(kept.map(async (signed) => ({ id: await entryId(signed.entry), signed }))));
      this.held.push(...kept);
      await this.remerge();
      return kept.length;
    });
  }

  /**
   * Make one change: sign it into this device's log, keep it, and offer it to the peer.
   *
   * The change is tried before it is kept. A log is forever, so an entry the lab would refuse — a
   * sequence that is not one, an item that does not exist — is turned down here, with the reason,
   * and never written.
   *
   * @param {import("@biolibs/bionet").Operation} op - The change.
   */
  write(op) {
    return this.inTurn(async () => {
      if (this.state === null) throw new Error("This device is not in a lab yet.");
      if (!isMember(this.state, this.key.publicKey)) {
        throw new Error("This device's key is not on the lab's roster, so it cannot change the lab.");
      }
      const signed = await nextEntry(this.state, this.key, op, { signer: this.person });
      const id = await entryId(signed.entry);
      const tried = (await mergeLog([...this.held, signed], { lab: this.state.lab ?? undefined })).entries.find((one) => one.id === id);
      if (tried?.status !== "applied") throw new Error(tried?.reason ?? "The lab would not accept that change.");
      this.store.add([{ id, signed }]);
      this.held.push(signed);
      await this.remerge();
      this.link?.push();
    });
  }

  /** @returns {string | null} What the person at this device is called. */
  get person() { return this.store.setting("person"); }

  /** @param {string} name - What to call the person at this device. */
  async setPerson(name) {
    if (name.trim() === "") throw new Error("A name, so that the lab can see who made each change.");
    this.store.set("person", name.trim().slice(0, 200));
    this.emit("change");
  }

  /**
   * Found a lab on this device.
   * @param {{ name: string, peer?: string | null }} about - What the lab is called, and its peer's address if it has one yet.
   */
  async found({ name, peer = null }) {
    if (this.labId !== null) throw new Error("This device is already in a lab.");
    if (this.person === null) throw new Error("Say who you are first.");
    if (name.trim() === "") throw new Error("A lab needs a name.");
    if (peer !== null && peer !== "") new URL(peer);
    const founding = await foundLab(this.key, { name: name.trim().slice(0, 200), person: this.person });
    const id = await entryId(founding.entry);
    this.store.add([{ id, signed: founding }]);
    this.held.push(founding);
    this.store.set("lab", id);
    this.store.set("peer", peer === "" ? null : peer);
    await this.remerge();
    this.connect();
  }

  /**
   * Join a lab somebody else founded. Nothing arrives until a keeper has added this device's key.
   * @param {string} invite - The invitation a keeper sent.
   */
  async join(invite) {
    if (this.labId !== null) throw new Error("This device is already in a lab.");
    if (this.person === null) throw new Error("Say who you are first.");
    const { peer, lab } = readInvite(invite);
    this.store.set("lab", lab);
    this.store.set("peer", peer);
    await this.remerge();
    this.connect();
  }

  /** @param {string | null} peer - The lab's peer, or `null` to work with none. */
  async setPeer(peer) {
    if (peer !== null && peer !== "") {
      const url = new URL(peer);
      if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("A peer's address starts with wss://.");
    }
    this.store.set("peer", peer === "" ? null : peer);
    this.connect();
    this.emit("change");
  }

  /** @param {string | null} origin - The web address the lab publishes from, if it is not the peer's own. */
  async setOrigin(origin) {
    this.store.set("origin", origin === "" ? null : origin);
    this.emit("change");
  }

  /** @returns {string | null} The web address the lab's inventory is published at. */
  get origin() {
    const peer = this.store.setting("peer");
    return this.store.setting("origin") ?? (peer === null ? null : originOf(peer));
  }

  /** @returns {string | null} What to send somebody who should join. */
  get invite() {
    const peer = this.store.setting("peer");
    return this.labId === null || peer === null ? null : `${peer}#${this.labId}`;
  }

  /** @param {{ key: string, person: string, role?: "member" | "keeper" }} who */
  addMember({ key, person, role = "member" }) { return this.write(addToRoster(key.trim(), person.trim(), role)); }
  /** @param {{ name: string, sequence: string, circular?: boolean }} part */
  async addPart({ name, sequence, circular = false }) {
    const bases = sequence.replace(/\s+/g, "");
    // The library underneath accepts any letters as a sequence. A freezer should not: a part named
    // by a checksum of the wrong letters is a part nobody else will ever match.
    if (!/^[ACGTURYSWKMBDHVN]+$/i.test(bases)) {
      throw new Error("A sequence is written in the letters for bases: A, C, G, T, and the codes for an uncertain base.");
    }
    return this.write(addPart({ name: name.trim(), sequence: bases, circular }));
  }
  /** @param {{ part: string, amount: number, unit?: string | null }} item @returns {Promise<string>} The new item's ID. */
  async addItem({ part, amount, unit = null }) {
    const item = newItemId();
    await this.write(addItem({ item, part, amount, unit: unit === "" ? null : unit }));
    return item;
  }
  /** @param {{ item: string, by: number }} change */
  adjust({ item, by }) { return this.write(adjustItem(item, by)); }
  /** @param {{ item: string, amount: number }} count */
  recount({ item, amount }) { return this.write(recountItem(item, amount)); }
  /** @param {{ item: string }} which */
  retire({ item }) { return this.write(retireItem(item)); }
  /** @param {{ part: string, available: boolean }} offer */
  offer({ part, available }) { return this.write(offerPart(part, available)); }
  /** @param {{ on: "part" | "item", id: string, field: string, value: string | number | null }} change */
  setField({ on, id, field, value }) { return this.write(setField(on, id, field, value)); }

  /**
   * Publish what the lab shows the world: sign the public inventory and hand it to the peer.
   *
   * The lab keeps pointing at whichever labs its published inventory already points at.
   *
   * @returns {Promise<{ ok: boolean, reason: string | null, parts: number }>} Whether it was published.
   */
  async publish() {
    const origin = this.origin;
    if (this.state === null || this.link === null || origin === null) {
      return { ok: false, reason: "The lab has no peer to publish through.", parts: 0 };
    }
    let peers;
    try {
      peers = (await fetchInventory(origin, { timeoutMs: 6_000, ...(this.fetch === undefined ? {} : { fetch: this.fetch }) })).signed.inventory.peers;
    } catch {
      peers = undefined;       // nothing published yet, or unreachable: publish without pointers
    }
    const inventory = publicInventory(this.state, { name: this.state.name ?? "A lab", origin, contact: null, note: null },
                                      peers === undefined ? {} : { peers });
    const signed = await signInventory(inventory, this.key, { signer: this.person });
    const answer = await this.link.publish(signed);
    if (answer.ok) {
      this.store.set("published", inventory.published_at);
      this.emit("change");
    }
    return { ...answer, parts: inventory.parts.length };
  }

  /** @returns Everything a window needs to draw, as plain data. */
  snapshot() {
    const state = this.state;
    const mine = this.key.publicKey;
    const me = state?.roster.find((one) => one.key === mine && one.removed === null);
    return {
      device: { key: mine, fingerprint: this.fingerprint, person: this.person },
      lab: state === null ? null : {
        id: state.lab,
        name: state.name,
        arrived: state.roster.length > 0,
        member: me !== undefined,
        keeper: me?.role === "keeper",
        roster: state.roster.map((one) => ({ ...one, fingerprint: this.fingerprints.get(one.key) ?? "", you: one.key === mine })),
        parts: state.parts,
        items: state.items,
        overlaps: state.overlaps,
        waiting: state.waiting.length,
        entries: state.entries.map((one) => ({
          id: one.id, author: one.signed.entry.author, seq: one.signed.entry.seq, op: one.signed.entry.op,
          status: one.status, reason: one.reason, signer: one.signed.signature.signer, signed_at: one.signed.signature.signed_at,
        })),
      },
      peer: {
        url: this.store.setting("peer"),
        origin: this.origin,
        invite: this.invite,
        status: this.link?.status ?? "offline",
        problem: this.link?.problem ?? null,
        pending: this.link?.pending ?? 0,
        lastSynced: this.link?.lastSynced ?? null,
      },
      published: this.store.setting("published"),
    };
  }

  /** Stop talking to the peer and close the store. */
  close() {
    this.link?.stop();
    this.store?.close();
  }
}
