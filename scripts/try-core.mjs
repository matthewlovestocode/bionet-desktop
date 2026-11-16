/**
 * Runs two devices and a lab's web peer, with no windows, and checks they behave as a lab.
 *
 *   npm run try-core
 *
 * The peer is the real one from ../lab-wren (build it first), started against an empty directory.
 * The devices are this app's own core. Every claim printed is checked; the first failure exits non-zero.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInventory } from "@biolibs/bionet";
import { Lab } from "../src/core/lab.mjs";

const PORT = 4011;
const LOCAL = `http://127.0.0.1:${PORT}`;
const ORIGIN = "https://lab-wren.onrender.com";
const WREN = process.env.LAB_WREN ?? new URL("../../lab-wren/", import.meta.url).pathname;
const F1 = "GGATCACAGTCTACACTGCTCACTCCAACCCCGGCCCCTGAGTCCGAGGA";

let failed = false;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail === "" ? "" : `  (${detail})`}`);
  if (!ok) failed = true;
};
const until = async (what, test, ms = 20_000) => {
  for (const started = Date.now(); Date.now() - started < ms;) {
    if (await test()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  console.log(`  (gave up waiting for: ${what})`);
  return false;
};

/** A key kept in memory, standing in for the operating system's keychain. */
const memory = () => { let held = null; return { load: async () => held, save: async (text) => { held = text; } }; };
/** Fetch the lab's published inventory from the local peer, whatever address it names. */
const local = (url, init) => fetch(String(url).replace(ORIGIN, LOCAL), init);
const device = (dir, keys) => new Lab({ dir, keys, fetch: local }).open();
const amount = (lab, item) => lab.snapshot().lab?.items.find((one) => one.item === item)?.amount;

async function startPeer(lab, data) {
  if (!existsSync(join(WREN, ".next"))) throw new Error(`build ${WREN} first: npm run build`);
  const child = spawn("node", ["server.mjs"], { cwd: WREN, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), BIONET_LAB: lab, BIONET_DATA: data, BIONET_ORIGIN: ORIGIN } });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  if (!(await until("the peer to start", () => out.includes("lab ready"), 20_000))) { child.kill(); throw new Error(out); }
  return child;
}

const adaDir = mkdtempSync(join(tmpdir(), "desk-ada-"));
const adaKeys = memory();
let ada = await device(adaDir, adaKeys);
const bob = await device(mkdtempSync(join(tmpdir(), "desk-bob-")), memory());
let peer = null;
try {
  console.log("\nAda founds the lab with no peer anywhere");
  await ada.setPerson("Ada");
  await ada.found({ name: "The Wren Lab" });
  const lab = ada.labId;
  check("the lab exists on her device alone", ada.snapshot().lab?.keeper === true && ada.snapshot().peer.status === "offline");

  console.log("\nThe lab's web peer comes up, and she points her device at it");
  peer = await startPeer(lab, mkdtempSync(join(tmpdir(), "desk-peer-")));
  await ada.setPeer(`ws://127.0.0.1:${PORT}/sync`);
  await ada.setOrigin(ORIGIN);
  check("her device syncs to a peer that held nothing", await until("Ada synced", () => ada.snapshot().peer.status === "synced"));
  check("and has nothing left to send", ada.snapshot().peer.pending === 0);

  console.log("\nBob joins with the invitation, before anybody has added him");
  await bob.setPerson("Bob");
  await bob.join(ada.invite);
  await bob.setOrigin(ORIGIN);
  check("he is told to wait, and is sent nothing", await until("Bob waiting", () => bob.snapshot().peer.status === "waiting")
        && bob.snapshot().lab.arrived === false);
  await bob.addPart({ name: "f1", sequence: F1 }).then(() => check("he cannot change the lab", false),
    (cause) => check("he cannot change the lab", /not on the lab's roster/.test(cause.message), cause.message));

  console.log("\nAda adds his key");
  await ada.addMember({ key: bob.snapshot().device.key, person: "Bob" });
  check("the lab arrives on his device without his doing anything", await until("Bob a member", () => bob.snapshot().lab.member === true));
  check("and he sees both of them on the roster", bob.snapshot().lab.roster.map((one) => one.person).join() === "Ada,Bob");

  console.log("\nAda adds a part and a tube while Bob is connected");
  await ada.addPart({ name: "f1", sequence: F1 });
  const part = ada.snapshot().lab.parts[0].checksum;
  const tube = await ada.addItem({ part, amount: 10, unit: "µL" });
  await ada.offer({ part, available: true });
  check("it reaches him live", await until("Bob sees the tube", () => amount(bob, tube) === 10));

  console.log("\nBoth go offline and each uses some");
  ada.link.stop();
  bob.link.stop();
  await ada.adjust({ item: tube, by: -1 });
  await bob.adjust({ item: tube, by: -2 });
  check("each device took the change with no network", amount(ada, tube) === 9 && amount(bob, tube) === 8);
  check("and knows it has something to send", ada.snapshot().peer.pending === 1 && bob.snapshot().peer.pending === 1,
        `Ada ${ada.snapshot().peer.pending} of ${ada.held.length} held, peer has ${JSON.stringify(Object.values(ada.link.peerHas ?? {}))}; Bob ${bob.snapshot().peer.pending} of ${bob.held.length}, peer has ${JSON.stringify(Object.values(bob.link.peerHas ?? {}))}`);
  ada.link.start();
  bob.link.start();
  check("back online, both come to seven", await until("both at 7", () => amount(ada, tube) === 7 && amount(bob, tube) === 7),
        `Ada ${amount(ada, tube)}, Bob ${amount(bob, tube)}`);
  check("with nothing left to send", await until("nothing pending", () => ada.snapshot().peer.pending === 0 && bob.snapshot().peer.pending === 0
        && ada.snapshot().peer.status === "synced" && bob.snapshot().peer.status === "synced"));

  console.log("\nChanges the lab would refuse are never written");
  const before = ada.held.length;
  await ada.addPart({ name: "nonsense", sequence: "not dna!" }).then(() => check("a part that is not a sequence is turned down", false),
    (cause) => check("a part that is not a sequence is turned down", /letters for bases/.test(cause.message), cause.message));
  await bob.addMember({ key: ada.snapshot().device.key, person: "Imposter" }).then(() => check("a member cannot change the roster", false),
    (cause) => check("a member cannot change the roster", cause.message === "Only a keeper may change the roster.", cause.message));
  await ada.adjust({ item: tube, by: 2.5 }).then(() => check("an amount that is not whole is turned down", false),
    (cause) => check("an amount that is not whole is turned down", /whole numbers/.test(cause.message), cause.message));
  check("and the logs are no longer for it", ada.held.length === before);

  console.log("\nBob publishes the lab's inventory");
  const published = await bob.publish();
  check("the peer publishes it", published.ok && published.parts === 1, published.reason ?? "");
  const served = await (await fetch(`${LOCAL}/.well-known/bionet.json`)).json();
  check("signed by him, for the lab's address", (await verifyInventory(served)).every((one) => one.ok)
        && served.signatures[0].public_key === bob.snapshot().device.key && served.inventory.lab.origin === ORIGIN);
  check("listing the part as on offer, and nothing private", JSON.stringify(served.inventory.parts.map((one) => [one.name, one.available])) === '[["f1",true]]'
        && !/µL|"amount"/.test(JSON.stringify(served.inventory)));
  check("and still pointing at the lab it pointed at before", served.inventory.peers?.[0]?.origin === "https://lab-thistle.onrender.com");

  console.log("\nAda quits and opens the app again");
  ada.close();
  ada = await device(adaDir, adaKeys);
  check("everything is still there, from disk", amount(ada, tube) === 7 && ada.snapshot().lab.name === "The Wren Lab" && ada.snapshot().device.person === "Ada");
  check("and it reconnects on its own", await until("Ada synced again", () => ada.snapshot().peer.status === "synced"));
} finally {
  ada.close();
  bob.close();
  peer?.kill();
}
console.log(failed ? "\nVERDICT: FAIL" : "\nVERDICT: PASS");
process.exit(failed ? 1 : 0);
