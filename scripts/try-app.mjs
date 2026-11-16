/**
 * Runs the real app as two devices, Ada's and Bob's, against a local web peer, and takes pictures.
 *
 *   npm run build && node scripts/try-app.mjs [folder for the pictures]
 *
 * Each step starts the app with a profile, has it do a short list of things through the same door
 * the window uses, photographs the window and quits. The peer is the real one from ../lab-wren.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";

const PORT = 4012;
const ORIGIN = "https://lab-wren.onrender.com";
const WREN = process.env.LAB_WREN ?? new URL("../../lab-wren/", import.meta.url).pathname;
const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), "bionet-shots-"));
mkdirSync(out, { recursive: true });
const F1 = "GGATCACAGTCTACACTGCTCACTCCAACCCCGGCCCCTGAGTCCGAGGA";
const F2 = "CAACCCCGGCCCCTGAGTCCGAGGAGAGGGTGCTTCAGAGTATGTATACC";

let failed = false;
const check = (what, ok, detail = "") => { console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail === "" ? "" : `  (${detail})`}`); if (!ok) failed = true; };

/** Run the app once as one device. @returns What it printed about itself at the end, and each step's outcome. */
function run(profile, shot, steps = [], { tab = "inventory", wait = 3500 } = {}) {
  const script = join(out, `${shot}.steps.json`);
  writeFileSync(script, JSON.stringify(steps));
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [".", `--profile=${profile}`, `--script=${script}`, `--screenshot=${join(out, `${shot}.png`)}`, `--tab=${tab}`, `--wait=${wait}`],
                        { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${shot} did not finish:\n${text}`)); }, 60_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const line = text.split("\n").find((one) => one.startsWith("state: "));
      if (line === undefined) return reject(new Error(`${shot} said nothing about itself:\n${text}`));
      const said = text.split("\n").filter((one) => /^[a-zA-Z]+: /.test(one) && !one.startsWith("state: "));
      resolve({ ...JSON.parse(line.slice(7)), said });
    });
  });
}

for (const profile of ["try-ada", "try-bob"]) {
  rmSync(join(homedir(), "Library", "Application Support", "bionet-desktop", "profiles", profile), { recursive: true, force: true });
}

let peer = null;
try {
  console.log(`\npictures go to ${out}\n`);
  let ada = await run("try-ada", "1-first-run");
  check("a new device asks who is at it", ada.person === null && ada.lab === null);

  ada = await run("try-ada", "2-ada-no-lab", [["setPerson", "Ada"]]);
  ada = await run("try-ada", "3-ada-founded", [["found", { name: "The Wren Lab", peer: "" }]]);
  check("Ada founds the lab with no network", ada.lab === "The Wren Lab" && ada.member && ada.peer === "offline", JSON.stringify(ada.said));

  peer = spawn("node", ["server.mjs"], { cwd: WREN, stdio: "ignore",
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), BIONET_LAB: ada.labId, BIONET_DATA: mkdtempSync(join(tmpdir(), "app-peer-")), BIONET_ORIGIN: ORIGIN } });
  await new Promise((done) => setTimeout(done, 4000));

  let bob = await run("try-bob", "4-bob-no-lab", [["setPerson", "Bob"]]);
  ada = await run("try-ada", "5-ada-freezer", [
    ["setPeer", `ws://127.0.0.1:${PORT}/sync`], ["setOrigin", ORIGIN],
    ["addMember", { key: bob.key, person: "Bob" }],
    ["addPart", { name: "f1", sequence: F1 }], ["addPart", { name: "f2", sequence: F2 }],
    ["addItem", { part: "{{part0}}", amount: 10, unit: "µL" }], ["addItem", { part: "{{part1}}", amount: 4, unit: "tubes" }],
    ["offer", { part: "{{part0}}", available: true }],
  ]);
  check("Ada sets the lab up and reaches the peer", ada.peer === "synced" && ada.items.join() === "10,4", JSON.stringify(ada.said));

  bob = await run("try-bob", "6-bob-joined", [["setOrigin", ORIGIN], ["join", ada.invite]], { wait: 6000 });
  check("Bob joins with the invitation and the lab arrives", bob.member && bob.items.join() === "10,4", JSON.stringify(bob));

  bob = await run("try-bob", "7-bob-used", [["adjust", { item: "{{item0}}", by: -2 }]]);
  ada = await run("try-ada", "8-ada-sees-it", [["adjust", { item: "{{item0}}", by: -1 }]], { wait: 5000 });
  check("each uses some on their own device, and Ada's shows both", ada.items[0] === 7, `Ada sees ${ada.items[0]}`);

  ada = await run("try-ada", "9-people", [], { tab: "people" });
  ada = await run("try-ada", "10-history", [], { tab: "history" });
  ada = await run("try-ada", "11-sharing", [["publish", null]], { tab: "sharing", wait: 5000 });
  check("Ada publishes through the peer", ada.said.at(-1) === "publish: ok", JSON.stringify(ada.said));
  const served = await (await fetch(`http://127.0.0.1:${PORT}/.well-known/bionet.json`)).json();
  check("and the peer serves what she signed", served.signatures[0].public_key === ada.key && served.inventory.parts.length === 2,
        JSON.stringify(served.inventory.parts.map((one) => [one.name, one.available])));

  const refused = await run("try-bob", "12-refused", [["addMember", { key: ada.key, person: "Imposter" }], ["addPart", { name: "bad", sequence: "not dna" }]]);
  check("the window is told why a change was refused", refused.said.join(" | ") === "addMember: Only a keeper may change the roster. | addPart: A sequence is written in the letters for bases: A, C, G, T, and the codes for an uncertain base.", refused.said.join(" | "));
} finally {
  peer?.kill();
}
console.log(failed ? "\nVERDICT: FAIL" : "\nVERDICT: PASS");
process.exit(failed ? 1 : 0);
