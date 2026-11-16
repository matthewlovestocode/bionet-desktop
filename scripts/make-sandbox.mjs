/**
 * Builds a lab to try the bench on, with the materials for every operation to work and for every
 * way it can fail.
 *
 *   node scripts/make-sandbox.mjs [folder]      # default: ./sandbox
 *
 * A real lab is somebody's, and a device's key is sealed by the keychain of the machine it was made
 * on, so neither travels. This makes a lab of its own instead: founded here, filled with ordinary
 * signed entries, and written as the two files a profile is — `lab.db` and the key that founded it.
 * The key is written unsealed, because it has to cross machines; it is worth nothing but this
 * sandbox. `scripts/load-sandbox.mjs` seals it into a profile on whatever machine it lands on.
 *
 * Everything it puts in is checked, by the same engines the tools use, against what it is for: the
 * PCR that should give one product does, the one that should give none gives none, the digest that
 * should cut twice cuts twice, the ligation that should close closes and the one that should not
 * does not. It prints what it made and exits non-zero if any of that stopped being true.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Lab } from "@biolibs/bionet-client";
import { sqliteStore } from "@biolibs/bionet-client/sqlite";
import { demoMolecules } from "@biolibs/bionet-demo";
import { cutSites, cutsOf, cutters, digestPieces, planDigest, planLigation, planPcr, primerTm } from "@biolibs/bionet-tools";

const out = resolve(process.argv[2] ?? "sandbox");
const SITES = { EcoRI: "GAATTC", BamHI: "GGATCC", PstI: "CTGCAG", HindIII: "AAGCTT" };
const AVOID = [...Object.values(SITES), "CTCGAG", "GCGGCCGC", "ACCGGT", "GGTACC", "CATATG", "CCCGGG", "AGATCT",
               "GGCGCGCC", "GTCGAC", "GCTAGC", "TCTAGA", "CCATGG", "GAGCTC", "ATCGAT", "ACGCGT", "GATATC",
               "GGGCCC", "GGTCTC", "CGTCTC", "GATC"];
const PAIR = { A: "T", T: "A", G: "C", C: "G" };
const other = (bases) => [...bases].reverse().map((base) => PAIR[base]).join("");

let seed = 7_311_207;
const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
/** @param many - How many bases. @returns That many, with none of the sites this plants itself. */
const filler = (many) => {
  const patterns = [...new Set(AVOID.flatMap((site) => [site, other(site)]))];
  let made = Array.from({ length: many }, () => "ACGT"[Math.floor(next() * 4)]).join("");
  for (let guard = 0; guard < 2000; guard++) {
    let again = false;
    for (const site of patterns) {
      const at = made.indexOf(site);
      if (at === -1) continue;
      again = true;
      made = `${made.slice(0, at + 2)}${"ACGT"[Math.floor(next() * 4)]}${made.slice(at + 3)}`;
    }
    if (!again) return made;
  }
  throw new Error("could not make filler free of the planted sites");
};

let wrong = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail === "" ? "" : `  (${detail})`}`);
  if (!ok) wrong++;
};
/** @param seq - A molecule. @param names - Enzymes. @returns Its pieces, cut for real. */
const cut = (seq, names) => {
  const whole = { sequence: seq, circular: true };
  return digestPieces(whole, names.flatMap((name) => { const one = cutsOf(whole, name); return one === null ? [] : cutSites(whole, one); }));
};

// ── what the lab will hold ────────────────────────────────────────────────────────────────────────
const good = demoMolecules();

// A plasmid with a stretch repeated, so a primer that lands in it lands twice.
const twice = filler(260);
const pRepeat = `${filler(400)}${twice}${filler(500)}${twice}${filler(300)}`;
// A plasmid none of the usual enzymes touches.
const pBlank = filler(1_400);
// A plasmid cut by one enzyme on both sides, whose pieces therefore fit each other and themselves.
const pSame = `${filler(900)}${SITES.EcoRI}${filler(700)}${SITES.EcoRI}${filler(400)}`;
// A plasmid cut by an enzyme that leaves the other kind of end, which fits nothing else here.
const pOther = `${filler(800)}${SITES.PstI}${filler(600)}${SITES.PstI}${filler(300)}`;
// A plasmid with its two sites close together, for a piece the usual gel cannot hold.
const pTiny = `${filler(1_200)}${SITES.EcoRI}${filler(110)}${SITES.BamHI}${filler(700)}`;

const sameEnds = cut(pSame, ["EcoRI"]).find((one) => one.length < 800);
const oddEnds = cut(pOther, ["PstI"]).find((one) => one.length < 700);
const tiny = cut(pTiny, ["EcoRI", "BamHI"]).find((one) => one.length < 300);
const gene = cut(good.pGene.sequence, ["EcoRI", "BamHI"]).find((one) => one.length === 786);

console.log("\nWhat the materials do\n");
const amplified = planPcr(good.pGene, good.forward.sequence, good.reverse.sequence);
check("the primers make one product from pWren1", amplified.problem === null && amplified.products[0]?.length === 502,
      amplified.problem ?? `${amplified.products[0]?.length} bp`);
const strayPrimer = filler(22);
check("a primer that is nowhere makes none", planPcr(good.pGene, good.forward.sequence, strayPrimer).problem !== null);
const repeatF = twice.slice(20, 42);
const repeatR = other(twice.slice(150, 172));
check("a primer in a repeat makes more than one", /more than one|different products/.test(planPcr({ sequence: pRepeat, circular: true }, repeatF, repeatR).problem ?? ""),
      planPcr({ sequence: pRepeat, circular: true }, repeatF, repeatR).problem ?? "none");
check("pWren1 is cut once by each of two enzymes", planDigest(good.pGene, ["EcoRI", "BamHI"]).fragments.join(",") === "926,786");
check("nothing usual cuts the blank plasmid", cutters({ sequence: pBlank, circular: true }).length === 0);
check("the gene and the backbone close into a circle", (() => {
  const made = planLigation([
    { id: "b", name: "backbone", sequence: good.backbone.sequence, ends: good.backbone.ends },
    { id: "g", name: "gene", sequence: gene.sequence, ends: gene.ends },
  ]);
  return made.problem === null && made.products.length === 1 && made.products[0].circular;
})());
check("a piece with one kind of end at both ends closes on itself", planLigation([
  { id: "s", name: "same", sequence: sameEnds.sequence, ends: sameEnds.ends }]).products[0]?.circular === true);
check("a piece with the other kind of end fits none of them", planLigation([
  { id: "b", name: "backbone", sequence: good.backbone.sequence, ends: good.backbone.ends },
  { id: "o", name: "odd", sequence: oddEnds.sequence, ends: oddEnds.ends }]).problem !== null);
check("the small piece is under what a 1% gel separates", tiny.length < 250, `${tiny.length} bp`);
check("both primers melt near each other", Math.abs(primerTm(good.forward.sequence) - primerTm(good.reverse.sequence)) <= 6);

if (wrong > 0) { console.error("\nThe materials no longer do what they are for.\n"); process.exit(1); }

// ── the lab ───────────────────────────────────────────────────────────────────────────────────────
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let exported = null;
const lab = await new Lab({
  store: sqliteStore(out),
  keys: { load: async () => exported, save: async (one) => { exported = one; } },
}).open();
await lab.setPerson("Ada");
await lab.found({ name: "The Wren Lab" });

const room = await lab.addPlace({ kind: "room", name: "Main lab" });
const bench = await lab.addPlace({ kind: "bench", name: "The bench", parent: room });
const freezer = await lab.addPlace({ kind: "freezer", name: "−80", parent: room });
const box = await lab.addPlace({ kind: "box", name: "Box 1", parent: freezer, grid: { rows: 9, columns: 9 } });
const machines = {
  pcr: await lab.addPlace({ kind: "instrument", name: "Thermocycler", parent: bench, model: "thermocycler" }),
  gel: await lab.addPlace({ kind: "instrument", name: "Gel station", parent: bench, model: "gel-station" }),
  block: await lab.addPlace({ kind: "instrument", name: "Heat block", parent: bench, model: "heat-block" }),
};

let at = { row: 0, column: 0 };
const onward = () => { at = at.column < 8 ? { row: at.row, column: at.column + 1 } : { row: at.row + 1, column: 0 }; };
/** @returns The tube's ID. */
const stock = async (what, amount = 25) => {
  await lab.addPart({ name: what.name, sequence: what.sequence, circular: what.circular === true,
                      features: what.features ?? [], ...(what.ends === undefined ? {} : { ends: what.ends }) });
  const part = lab.snapshot().lab.parts.find((one) => one.name === what.name);
  if (part === undefined) throw new Error(`the lab would not take ${what.name}`);
  const tube = await lab.addItem({ part: part.checksum, amount, unit: "µL" });
  const where = at;
  onward();
  await lab.putItem({ item: tube, place: box, slot: where });
  return tube;
};

const tubes = {};
tubes.pWren1 = await stock({ ...good.pGene, name: "pWren1" }, 30);
tubes.forward = await stock({ ...good.forward, name: "wrenA-F" }, 100);
tubes.reverse = await stock({ ...good.reverse, name: "wrenA-R" }, 100);
tubes.backbone = await stock({ ...good.backbone, name: "pWren backbone" }, 20);
tubes.stray = await stock({ name: "stray-P", sequence: strayPrimer, circular: false }, 100);
tubes.pRepeat = await stock({ name: "pRepeat", sequence: pRepeat, circular: true }, 25);
tubes.repeatF = await stock({ name: "repeat-F", sequence: repeatF, circular: false }, 100);
tubes.repeatR = await stock({ name: "repeat-R", sequence: repeatR, circular: false }, 100);
tubes.pBlank = await stock({ name: "pBlank", sequence: pBlank, circular: true }, 25);
tubes.sameEnds = await stock({ name: "same ends both sides", sequence: sameEnds.sequence, circular: false, ends: sameEnds.ends }, 20);
tubes.oddEnds = await stock({ name: "the other kind of end", sequence: oddEnds.sequence, circular: false, ends: oddEnds.ends }, 20);
tubes.blunt = await stock({ name: "a blunt piece", sequence: filler(480), circular: false }, 20);
tubes.tiny = await stock({ name: "too small for the gel", sequence: tiny.sequence, circular: false, ends: tiny.ends }, 20);
// An empty one and a retired one, so that what a tool will not offer can be seen as well.
tubes.empty = await stock({ ...good.pGene, name: "pWren1" }, 0);
const spare = await stock({ ...good.pGene, name: "pWren1" }, 15);
await lab.retire({ item: spare });

// A PCR really run, so the lab has a product whose ends ligase cannot seal, and a history to read.
const product = amplified.products[0];
await lab.recordRun({
  kind: "pcr", instrument: machines.pcr,
  inputs: [{ item: tubes.pWren1, amount: 1, role: "template" }, { item: tubes.forward, amount: 1, role: "forward primer" },
           { item: tubes.reverse, amount: 1, role: "reverse primer" }],
  outputs: [{ sequence: product.sequence, name: "wrenA check", amount: 50, unit: "µL" }],
  settings: { anneal_at_least: 18, anneal_c: 55, cycles: 30 }, note: "the gene is where it should be",
});

const held = lab.snapshot().lab;
check("every entry was taken", held.entries.every((one) => one.status === "applied"),
      held.entries.filter((one) => one.status !== "applied").map((one) => one.reason).join("; "));
check("nothing is in two places at once", held.crowded.length === 0);
lab.close?.();

// ── what travels ──────────────────────────────────────────────────────────────────────────────────
writeFileSync(join(out, "device.key"), `${exported}\n`, { mode: 0o600 });
// The entries as text as well as a database, since reading them is how anybody works out what a lab is.
try {
  const dump = execFileSync("sqlite3", [join(out, "lab.db"), ".dump"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(out, "lab.sql"), dump);
} catch {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(out, "lab.db"));
  const rows = db.prepare("select id, author, seq, json from entries order by author, seq").all();
  const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
  writeFileSync(join(out, "lab.sql"), ["begin transaction;",
    "create table if not exists entries (id text primary key, author text not null, seq integer not null, json text not null);",
    "create index if not exists entries_by_log on entries (author, seq);",
    ...rows.map((one) => `insert into entries values(${quote(one.id)},${quote(one.author)},${one.seq},${quote(one.json)});`),
    "commit;", ""].join("\n"));
  db.close();
}

console.log(`\nThe lab\n`);
console.log(`  ${held.parts.length} parts, ${held.items.length} tubes, ${held.places.length} places, ${held.runs.length} run`);
console.log(`  ${held.entries.length} entries, in ${join(out, "lab.db")}`);
console.log(`  and as text in ${join(out, "lab.sql")}`);
console.log(`\n${wrong > 0 ? "VERDICT: FAIL" : "VERDICT: PASS"}\n`);
if (wrong > 0) process.exit(1);
