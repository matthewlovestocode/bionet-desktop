// @ts-check
/**
 * Use the Bionet packages from a checkout of biolibs beside this one, in place of the ones from npm.
 *
 * The app owns nothing, so nearly every change to it is really a change to a package. Publishing a
 * package to try a change is slow and leaves a trail of versions; this points the app at the
 * packages as they are on disk, so a change can be run the moment it compiles.
 *
 *   node scripts/local-packages.mjs on       link them
 *   node scripts/local-packages.mjs off      put the published ones back
 *   node scripts/local-packages.mjs          say which are in use
 *
 * It only replaces folders inside node_modules. package.json and the lockfile are not touched, so
 * nothing about it can be committed by accident, and `npm install` undoes it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const biolibs = resolve(process.env.BIOLIBS ?? join(app, "..", "biolibs"));
const installed = join(app, "node_modules", "@biolibs");

/**
 * What to link: the Bionet packages, and any other package in the checkout that is not installed
 * here at all. A linked package finds what it imports in this app, so an engine it has newly come
 * to need, and that npm has not been asked for yet, has to be linked as well.
 */
const inside = (/** @type {string} */ dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "package.json")) || lstatSync(join(dir, name)).isSymbolicLink()) : []);
const here = inside(installed);
const checkout = inside(join(biolibs, "packages"));
const names = [...new Set([...here, ...checkout].filter((name) => name.startsWith("bionet") || !here.includes(name) || lstatSync(join(installed, name)).isSymbolicLink()))].sort();
const linked = (/** @type {string} */ name) => existsSync(join(installed, name)) && lstatSync(join(installed, name)).isSymbolicLink();
const version = (/** @type {string} */ dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

const say = () => {
  for (const name of names) {
    const state = linked(name) ? `local   ${version(join(biolibs, "packages", name))}  (${join(biolibs, "packages", name)})`
      : existsSync(join(installed, name)) ? `npm     ${version(join(installed, name))}` : "not installed: it is only in the checkout";
    console.log(`  ${name.padEnd(16)} ${state}`);
  }
};

const what = process.argv[2];
if (what === "on") {
  if (!existsSync(join(biolibs, "packages"))) {
    console.error(`There is no biolibs checkout at ${biolibs}. Set BIOLIBS to where it is.`);
    process.exit(1);
  }
  const local = names.filter((name) => existsSync(join(biolibs, "packages", name)));
  const unbuilt = local.filter((name) => !existsSync(join(biolibs, "packages", name, "dist")));
  if (unbuilt.length > 0) {
    console.error(`These are not built yet: ${unbuilt.join(", ")}. Run "npx tsc -b" in ${biolibs} first.`);
    process.exit(1);
  }
  for (const name of local) {
    rmSync(join(installed, name), { recursive: true, force: true });
    symlinkSync(join(biolibs, "packages", name), join(installed, name), "dir");
  }
  console.log("Using the local packages:");
  say();
  console.log(`\nRebuild them as you work with "npx tsc -b --watch" in ${biolibs}, then "npm run dev" here.`);
} else if (what === "off") {
  for (const name of names) if (linked(name)) rmSync(join(installed, name), { recursive: true, force: true });
  // Started through "npm run", this inherits npm's settings for that run, some of which an install
  // refuses. The install is given a clean slate.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith("npm_")));
  try {
    execFileSync("npm", ["install"], { cwd: app, stdio: "inherit", env });
  } catch {
    console.error("\nThe published packages could not all be installed. If the app needs one that is not published yet,");
    console.error('it only runs linked: "npm run local" puts the links back.');
    process.exit(1);
  }
  console.log("Using the published packages:");
  // npm has put the folders back, so read them afresh.
  for (const name of inside(installed).filter((one) => one.startsWith("bionet")).sort()) console.log(`  ${name.padEnd(16)} npm     ${version(join(installed, name))}`);
} else {
  say();
}
