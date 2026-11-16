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

/** The Bionet packages this app has installed, which are the ones worth linking. */
const names = existsSync(installed) ? readdirSync(installed).filter((name) => name.startsWith("bionet")).sort() : [];
const linked = (/** @type {string} */ name) => lstatSync(join(installed, name)).isSymbolicLink();
const version = (/** @type {string} */ dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

const say = () => {
  for (const name of names) {
    console.log(`  ${name.padEnd(16)} ${linked(name) ? `local   ${version(join(biolibs, "packages", name))}  (${join(biolibs, "packages", name)})` : `npm     ${version(join(installed, name))}`}`);
  }
};

const what = process.argv[2];
if (what === "on") {
  if (!existsSync(join(biolibs, "packages"))) {
    console.error(`There is no biolibs checkout at ${biolibs}. Set BIOLIBS to where it is.`);
    process.exit(1);
  }
  const unbuilt = names.filter((name) => !existsSync(join(biolibs, "packages", name, "dist")));
  if (unbuilt.length > 0) {
    console.error(`These are not built yet: ${unbuilt.join(", ")}. Run "npx tsc -b" in ${biolibs} first.`);
    process.exit(1);
  }
  for (const name of names) {
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
  execFileSync("npm", ["install"], { cwd: app, stdio: "inherit", env });
  console.log("Using the published packages:");
  // npm has put the folders back, so read them afresh.
  for (const name of readdirSync(installed).filter((one) => one.startsWith("bionet")).sort()) console.log(`  ${name.padEnd(16)} npm     ${version(join(installed, name))}`);
} else {
  say();
}
