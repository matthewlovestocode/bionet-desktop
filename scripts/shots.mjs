// @ts-check
/**
 * Photographs the bench tools, for the page about them on bionet.libs.bio.
 *
 *   npm run build && node scripts/shots.mjs [folder for the pictures]
 *
 * A picture of a tool on a website is a claim about what the tool does, and a picture is the
 * easiest kind of claim to make loosely: pose the window, crop the awkward part, keep it after the
 * tool has moved on. So this does not pose anything. It loads a lab built by `make-sandbox.mjs` —
 * whose materials are checked, by the engines the tools use, against what they are for — works the
 * window as a person would, and then **reads back what is on the screen and checks it**. A picture
 * is only written if what it shows is what this says it shows.
 *
 * What comes out is the pictures and `shots.json` beside them, which carries, for each tool: the
 * name the app itself gives it, the machine it is used at, what was done to reach the state, what
 * was checked, and the versions of the packages that drew it. The site reads that file, so the
 * page cannot name a tool the app does not have, and cannot show a picture with nothing said about
 * it.
 *
 * The whole window is photographed, three-dimensional room and all, because that is what a person
 * at this app sees. The tools are drawn beside the room on purpose: one camera travels from one
 * machine to the next as the tool changes.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electron from "electron";

const app = new URL("..", import.meta.url).pathname;
const out = resolve(process.argv[2] ?? join(tmpdir(), "bionet-tool-shots"));
const sandbox = join(out, "sandbox");
mkdirSync(out, { recursive: true });

let failed = false;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail === "" ? "" : `  (${detail})`}`);
  if (!ok) failed = true;
};

// ---------------------------------------------------------------- working the window

/** Press one of the tool tabs by the words on it. */
const press = (name) => ["ui", `(() => {
  const found = [...document.querySelectorAll('[role="tab"]')].find((one) => one.textContent === ${JSON.stringify(name)});
  if (found === undefined) return "there is no tab called " + ${JSON.stringify(name)};
  found.click();
  return "pressed " + ${JSON.stringify(name)};
})()`];

/** Press any button by the words on it, within the tools area. */
const button = (words) => ["ui", `(() => {
  const found = [...document.querySelectorAll(".tools button")].find((one) => one.textContent.trim() === ${JSON.stringify(words)});
  if (found === undefined) return "no button says " + ${JSON.stringify(words)} + "; they say: " + [...document.querySelectorAll(".tools button")].map((one) => one.textContent.trim()).join(" | ");
  found.click();
  return "pressed " + ${JSON.stringify(words)};
})()`];

/**
 * Choose from a list, by the words above it and a word in the option.
 *
 * React does not hear a value assigned to a `select`, so it goes through the native setter and then
 * a change event, which is what a person's choice looks like from the inside.
 */
const choose = (label, wanted) => ["ui", `(() => {
  const named = (sel) => { const lab = sel.closest("label"); return lab === null ? "" : [...lab.childNodes].filter((one) => one.nodeType === 3).map((one) => one.textContent.trim()).join(" ").trim(); };
  const lists = [...document.querySelectorAll(".tools select")];
  const found = lists.find((one) => named(one) === ${JSON.stringify(label)});
  if (found === undefined) return "no list is called " + ${JSON.stringify(label)} + "; they are: " + lists.map(named).join(" | ");
  const option = [...found.options].find((one) => one.textContent.includes(${JSON.stringify(wanted)}));
  if (option === undefined) return "no option in " + ${JSON.stringify(label)} + " says " + ${JSON.stringify(wanted)};
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(found, option.value);
  found.dispatchEvent(new Event("change", { bubbles: true }));
  return "chose " + option.textContent.split(" · ")[0];
})()`];

/** Tick a box, by the words beside it. */
const tick = (words) => ["ui", `(() => {
  const boxes = [...document.querySelectorAll('.tools input[type="checkbox"]')];
  const named = (box) => (box.closest("label")?.textContent ?? "").trim();
  const found = boxes.find((one) => named(one).startsWith(${JSON.stringify(words)}));
  if (found === undefined) return "no box says " + ${JSON.stringify(words)} + "; they say: " + boxes.map(named).join(" | ");
  if (!found.checked) found.click();
  return "ticked " + named(found);
})()`];

/** What a tool is offering, for working out what to tell it. */
const offers = ["ui", `(() => {
  const named = (one) => { const lab = one.closest("label"); return lab === null ? "(no label)" : [...lab.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent.trim()).join(" ").trim() || lab.textContent.trim().slice(0, 40); };
  return { boxes: [...document.querySelectorAll(".tools input")].map((one) => one.type + ": " + named(one)),
           lists: [...document.querySelectorAll(".tools select")].map(named),
           buttons: [...document.querySelectorAll(".tools button")].map((one) => one.textContent.trim()) };
})()`];

/** Type into a box, by the words above it. */
const type = (label, text) => ["ui", `(() => {
  const named = (box) => { const lab = box.closest("label"); return lab === null ? "" : [...lab.childNodes].filter((one) => one.nodeType === 3).map((one) => one.textContent.trim()).join(" ").trim(); };
  const boxes = [...document.querySelectorAll(".tools input")];
  const found = boxes.find((one) => named(one) === ${JSON.stringify(label)});
  if (found === undefined) return "no box is called " + ${JSON.stringify(label)} + "; they are: " + boxes.map(named).join(" | ");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(found, ${JSON.stringify(text)});
  found.dispatchEvent(new Event("input", { bubbles: true }));
  return "typed " + ${JSON.stringify(text)};
})()`];

/** Everything the tools area says, which is what the checks are made against. */
const reading = ["ui", `document.querySelector(".tools").innerText`];

/** Every tool the window offers, in its order, so the site's list is the app's own. */
const everyTool = ["ui", `[...document.querySelectorAll('[role="tab"]')].map((one) => one.textContent)`];

/**
 * Run the app once, with the sandbox lab in a profile of its own, and answer with what it said.
 *
 * @param name - What to call the picture and the profile it is taken in.
 * @param steps - What to do to the window, in `main.mjs`'s own script language.
 * @param options - `size` opens the window at a width and height, as "1400x1000".
 * @returns Everything the window answered, and the last of it, which is the screen as text.
 */
function run(name, steps, { size = "1400x1000" } = {}) {
  const profile = `shots-${name}`;
  rmSync(join(homedir(), "Library", "Application Support", "bionet-desktop", "profiles", profile), { recursive: true, force: true });
  const script = join(out, `${name}.steps.json`);
  writeFileSync(script, JSON.stringify(steps));
  /** Electron's default export is the path to its binary, which its types do not say. */
  const binary = /** @type {string} */ (/** @type {unknown} */ (electron));
  return new Promise((resolve_, reject) => {
    const child = spawn(binary, [".", `--profile=${profile}`, `--load-lab=${sandbox}`, `--script=${script}`,
                                 `--screenshot=${join(out, `${name}.png`)}`, `--tab=tools`, `--size=${size}`, "--wait=1200"],
                        { cwd: app, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout?.on("data", (chunk) => { text += chunk; });
    child.stderr?.on("data", (chunk) => { text += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} did not finish:\n${text}`)); }, 120_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const said = text.split("\n").filter((one) => one.startsWith("ui: ")).map((one) => JSON.parse(one.slice(4)));
      if (said.length === 0) return reject(new Error(`${name} said nothing:\n${text}`));
      resolve_({ said, screen: String(said.at(-1) ?? "") });
    });
  });
}

// ---------------------------------------------------------------- the tools photographed

/**
 * Each tool, what is done to reach the state worth seeing, and what has to be on the screen for the
 * picture to be worth keeping.
 *
 * `wants` is the whole of the claim. Anything the page says about a picture should be in here, so
 * that the page cannot say it once the app has stopped doing it.
 */
const SHOTS = [
  {
    id: "sequences",
    tab: "Sequences",
    at: null,
    did: "Opened the lab's own sequences, and looked at one of its plasmids.",
    steps: [["wait", 2600]],
    wants: ["pWren1", "1,712", "circular"],
  },
  {
    id: "pcr",
    tab: "PCR",
    at: "thermocycler",
    did: "Took a template and two primers off the shelf, as tubes the lab holds, and let the thermocycler work out what they would give.",
    steps: [["wait", 2600],
            choose("Template", "pWren1"), ["wait", 500],
            choose("Forward primer", "wrenA-F"), ["wait", 500],
            choose("Reverse primer", "wrenA-R"), ["wait", 2200]],
    wants: ["Thermocycler", "pWren1", "wrenA-F", "wrenA-R"],
  },
  {
    id: "digest",
    tab: "Digest and gel",
    at: "gel-station",
    did: "Cut a plasmid with two enzymes and ran the pieces out on a gel, from the tube the lab has.",
    steps: [choose("Tube", "pWren1"), ["wait", 900], tick("EcoRI"), ["wait", 600], tick("SpeI"), ["wait", 1500],
            // The gel box is what the station shows first; this is the lane after it has run.
            button("The gel, run"), ["wait", 2500]],
    // The two pieces are the whole claim: 1,453 and 259 are the plasmid's 1,712 bases, cut in two.
    wants: ["Gel station", "pWren1", "EcoRI", "SpeI", "1,453", "259"],
  },
  {
    id: "reading",
    tab: "Reading",
    at: "spectrophotometer",
    did: "Typed in a number read off a spectrophotometer, which is the one tool here that predicts nothing and can only say what a reading means.",
    steps: [choose("Tube", "pWren1"), ["wait", 800], type("What it showed", "0.62"), ["wait", 1500],
            // The last view is the one that is the point: the reading set against the range it has to be in.
            button("What it means"), ["wait", 2000]],
    wants: ["Spectrophotometer", "0.62", "pWren1", "31 ng/µL"],
  },
];

// ---------------------------------------------------------------- doing it

if (!existsSync(join(app, "dist", "renderer", "index.html"))) {
  console.error('The app is not built. Run "npm run build" first.');
  process.exit(1);
}
if (!existsSync(join(sandbox, "lab.db"))) {
  console.log(`building a lab to photograph in ${sandbox}\n`);
  const made = spawn(process.execPath, [join(app, "scripts", "make-sandbox.mjs"), sandbox], { cwd: app, stdio: "inherit" });
  await new Promise((done, stop) => made.on("exit", (code) => (code === 0 ? done(undefined) : stop(new Error("the sandbox lab could not be built")))));
}

/** The versions that drew these pictures, so the page can say which build of the app they are of. */
const versions = Object.fromEntries(["bionet", "bionet-client", "bionet-panels", "bionet-scene", "bionet-tools", "bionet-theme"].map((name) => {
  const where = join(app, "node_modules", "@biolibs", name, "package.json");
  return [name, existsSync(where) ? JSON.parse(readFileSync(where, "utf8")).version : "not installed"];
}));

console.log(`\npictures go to ${out}\n`);
/**
 * One picture, once it has been taken: what it was taken of, and what was made of it afterwards.
 *
 * @typedef {{ id: string; tab: string; at: string | null; did: string; shows: string[]; file: string;
 *             web?: string; width?: number; height?: number }} Taken
 */

/** @type {Taken[]} */
const taken = [];
/** @type {string[]} */
let every = [];
for (const shot of SHOTS) {
  // The window is given a moment to draw before it is told anything, since a tab that is not there
  // yet cannot be pressed.
  const { said, screen } = await run(shot.id, [["wait", 2600], press(shot.tab), ["wait", 1200], ...shot.steps, everyTool, reading]);
  const listed = said.find((one) => Array.isArray(one));
  if (listed !== undefined) every = listed;
  // What a tool offered, when the step list asked, which is how a new tool's steps get written.
  for (const one of said) if (one !== null && typeof one === "object" && !Array.isArray(one)) console.log(`  ${shot.tab} offers ${JSON.stringify(one)}`);
  const trouble = said.filter((one) => typeof one === "string" && /^(there is no|no button|no list|no option|no box)/.test(one));
  check(`${shot.tab}: the window did what it was told`, trouble.length === 0, trouble.join(" / "));
  const missing = shot.wants.filter((want) => !screen.includes(want));
  check(`${shot.tab}: the picture shows ${shot.wants.join(", ") || "the tool"}`, missing.length === 0, missing.length === 0 ? "" : `missing: ${missing.join(", ")}`);
  taken.push({ id: shot.id, tab: shot.tab, at: shot.at, did: shot.did, shows: shot.wants, file: `${shot.id}.png` });
}

/**
 * A copy of each picture at the width a page wants it.
 *
 * The window is photographed at twice its size, which is right for a screen and far too heavy for a
 * page. `cwebp` is not part of macOS, so if it is not here the pictures are still written and this
 * says what is missing rather than quietly shipping a megabyte.
 */
const WIDE = 1600;
const webp = spawnSync("cwebp", ["-version"], { stdio: "ignore" }).status === 0;
check("cwebp is here to make the pictures a page can carry", webp, webp ? "" : "install it with: brew install webp");
if (webp) {
  for (const shot of taken) {
    const made = spawnSync("cwebp", ["-quiet", "-q", "82", "-resize", String(WIDE), "0", join(out, shot.file), "-o", join(out, `${shot.id}.webp`)]);
    check(`${shot.tab}: a picture at ${WIDE} wide`, made.status === 0, String(made.stderr ?? ""));
    shot.web = `${shot.id}.webp`;
    // The size is read back rather than worked out, so a page can keep the room for it and nothing
    // jumps as it loads.
    const said = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(out, shot.web)], { encoding: "utf8" }).stdout ?? "";
    shot.width = Number(/pixelWidth: (\d+)/.exec(said)?.[1] ?? 0);
    shot.height = Number(/pixelHeight: (\d+)/.exec(said)?.[1] ?? 0);
    check(`${shot.tab}: the picture's size is known`, shot.width > 0 && shot.height > 0);
  }
}

writeFileSync(join(out, "shots.json"), `${JSON.stringify({
  took: new Date().toISOString().slice(0, 10),
  app: "bionet-desktop",
  versions,
  // The tools the app has, as the window itself lists them, so the site's list is the app's list.
  tools: every,
  shots: taken.map(({ id, tab, at, did, shows, file, web, width, height }) => ({ id, tab, at, did, shows, file, web, width, height })),
}, null, 2)}\n`);

console.log(`\n${taken.length} pictures and shots.json in ${out}`);
console.log(failed ? "\nVERDICT: FAIL" : "\nVERDICT: PASS");
process.exit(failed ? 1 : 0);
