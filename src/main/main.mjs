// @ts-check
/**
 * The window around the lab.
 *
 * Everything a member does happens in `@biolibs/bionet-client`, which knows nothing of Electron, and
 * everything drawn comes from `@biolibs/bionet-panels`. This file adds the three things only the
 * desktop can: the device's key kept sealed by the operating system's
 * keychain, a window, and the narrow door between that window and the lab.
 *
 * The window is given no powers. It cannot read files, reach the network or see the key; it can ask
 * for the lab's state and ask for one of a fixed list of things to be done, and that is all.
 */
import { BrowserWindow, app, clipboard, dialog, ipcMain, nativeTheme, safeStorage } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Lab, perform } from "@biolibs/bionet-client";
import { sqliteStore } from "@biolibs/bionet-client/sqlite";
import { COLOURS } from "@biolibs/bionet-theme";

const here = fileURLToPath(new URL(".", import.meta.url));
const flag = (/** @type {string} */ name) => process.argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

// A window run from a script is often behind another one, and a window that cannot be seen stops
// drawing. Its pictures would then be of an earlier moment, so a scripted window keeps drawing.
if (flag("script") !== null) {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}

// A profile is a separate device on the same machine: its own key, its own copy of the lab. It is
// how two members are tried out side by side, and nothing a lab needs day to day.
const profile = flag("profile");
if (profile !== null) app.setPath("userData", join(app.getPath("appData"), "bionet-desktop", "profiles", profile.replace(/[^A-Za-z0-9_-]/g, "")));

// The app follows the system's light or dark theme. This is for looking at the other one.
const theme = flag("theme");
if (theme === "light" || theme === "dark") nativeTheme.themeSource = theme;
const icon = join(here, "../../assets/icon.png");

/** The device's key, sealed by the keychain. It is never written anywhere unsealed. */
const keys = {
  path: () => join(app.getPath("userData"), "device.key"),
  async load() {
    if (!existsSync(keys.path())) return null;
    return (await safeStorage.decryptStringAsync(readFileSync(keys.path()))).result;
  },
  async save(/** @type {string} */ exported) {
    writeFileSync(keys.path(), await safeStorage.encryptStringAsync(exported), { mode: 0o600 });
  },
};

/**
 * Put a lab built elsewhere into this profile, key and all.
 *
 * A device's key is sealed by the keychain of the machine it is on, so a lab that travels carries
 * its key unsealed and has to be let in by the app itself: sealing it anywhere else seals it under
 * another name, and this app would not be able to open it. It is refused onto a profile that
 * already holds a lab, since that lab is somebody's.
 *
 * @param from - The folder holding `lab.db` and the unsealed `device.key` that founded it.
 * @param into - The profile folder to put them in.
 */
async function loadLab(from, into) {
  for (const needed of ["lab.db", "device.key"]) {
    if (!existsSync(join(from, needed))) throw new Error(`There is no ${needed} in ${from}.`);
  }
  if (existsSync(join(into, "lab.db"))) throw new Error(`${into} already holds a lab. Use another --profile.`);
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, "device.key"), await safeStorage.encryptStringAsync(readFileSync(join(from, "device.key"), "utf8").trim()), { mode: 0o600 });
  for (const one of ["lab.db", "lab.db-wal", "lab.db-shm"]) {
    if (existsSync(join(from, one))) copyFileSync(join(from, one), join(into, one));
  }
}

app.whenReady().then(async () => {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    dialog.showErrorBox("No keychain", "This device has nowhere safe to keep its key, so the app will not make one.");
    app.exit(1);
    return;
  }
  if (app.dock) app.dock.setIcon(icon);
  const bringing = flag("load-lab");
  if (bringing !== null) {
    try {
      await loadLab(resolve(bringing), app.getPath("userData"));
      console.log(`loaded the lab from ${resolve(bringing)}`);
    } catch (cause) {
      dialog.showErrorBox("That lab could not be loaded", cause instanceof Error ? cause.message : String(cause));
      app.exit(1);
      return;
    }
  }
  const lab = await new Lab({ store: sqliteStore(app.getPath("userData")), keys }).open();

  // The door between the window and the lab. `perform` does only what is on the client's own list.
  /** @param {string} action @param {unknown} payload */
  const act = (action, payload) => perform(lab, action, payload);
  ipcMain.handle("bionet:state", () => lab.snapshot());
  ipcMain.handle("bionet:do", (_event, action, payload) => act(String(action), payload));
  ipcMain.handle("bionet:copy", (_event, words) => clipboard.writeText(String(words).slice(0, 5_000)));

  // Handing over a file, such as the sealed key. The person chooses where it goes; the window only
  // ever supplies a name to suggest and the text, and learns whether it was saved.
  const saveTo = flag("save-to");
  ipcMain.handle("bionet:save", async (_event, name, text) => {
    const suggested = String(name).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120) || "bionet.json";
    // For trying the app without a person: a folder to save into, in place of asking.
    const chosen = saveTo !== null ? { canceled: false, filePath: join(saveTo, suggested) }
      : await dialog.showSaveDialog(window, { title: "Save", defaultPath: join(app.getPath("documents"), suggested) });
    if (chosen.canceled || chosen.filePath === undefined || chosen.filePath === "") return false;
    writeFileSync(chosen.filePath, String(text).slice(0, 100_000_000), { mode: 0o600 });
    return true;
  });

  const window = new BrowserWindow({
    width: 1100, height: 780, minWidth: 720, minHeight: 520, title: "Bionet",
    backgroundColor: COLOURS[nativeTheme.shouldUseDarkColors ? "dark" : "light"].ground,
    icon,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // This window shows the lab and nothing else: it does not follow links or open other windows.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  lab.subscribe(() => { if (!window.isDestroyed()) window.webContents.send("bionet:state", lab.snapshot()); });
  await window.loadFile(join(here, "../../dist/renderer/index.html"), { hash: flag("tab") ?? "" });

  // For trying the app out without a person at it: do a list of things, then take a picture and quit.
  const script = flag("script");
  if (script !== null) {
    for (const [action, written] of JSON.parse(readFileSync(script, "utf8"))) {
      // A script may pause, for a sync to finish before the next thing depends on it.
      if (action === "wait") { await new Promise((done) => setTimeout(done, Number(written))); continue; }
      // A script may also work the window as a person would, so that what is tried is what is used:
      // press a point, run a line in the page (to choose from a list, or press a button by its
      // words), or take a picture on the way.
      // A point may be given as a line to run in the page that answers with one, for something whose
      // place is not known until it is drawn. `move` only moves the pointer there, to try what hovering does.
      if (action === "click" || action === "move") {
        const [x, y] = typeof written === "string" ? await window.webContents.executeJavaScript(written, true) : written;
        if (action === "move") { window.webContents.sendInputEvent({ type: "mouseMove", x, y }); continue; }
        for (const type of /** @type {const} */ (["mouseDown", "mouseUp"])) window.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
        continue;
      }
      if (action === "ui") { console.log(`ui: ${JSON.stringify(await window.webContents.executeJavaScript(String(written), true))}`); continue; }
      if (action === "shot") { writeFileSync(String(written), (await window.webContents.capturePage()).toPNG()); continue; }
      // A script cannot know a checksum, an item's ID or a place's in advance, so it may name them by position.
      const payload = JSON.parse(JSON.stringify(written ?? null)
        .replace(/\{\{part(\d+)\}\}/g, (_all, at) => lab.snapshot().lab?.parts[Number(at)]?.checksum ?? "")
        .replace(/\{\{item(\d+)\}\}/g, (_all, at) => lab.snapshot().lab?.items[Number(at)]?.item ?? "")
        .replace(/\{\{place(\d+)\}\}/g, (_all, at) => lab.snapshot().lab?.places[Number(at)]?.place ?? ""));
      const answer = await act(action, payload);
      console.log(`${action}: ${answer.ok ? "ok" : answer.error}`);
    }
  }
  const picture = flag("screenshot");
  if (picture !== null) {
    await new Promise((done) => setTimeout(done, Number(flag("wait") ?? 2500)));
    writeFileSync(picture, (await window.webContents.capturePage()).toPNG());
    const seen = lab.snapshot();
    console.log(`state: ${JSON.stringify({ key: seen.device.key, labId: seen.lab?.id ?? null, invite: seen.peer.invite, person: seen.device.person,
                                           lab: seen.lab?.name ?? null, member: seen.lab?.member ?? false,
                                           items: seen.lab?.items.map((one) => one.amount) ?? [], peer: seen.peer.status })}`);
    lab.close();
    app.exit(0);
  }

  app.on("window-all-closed", () => { lab.close(); app.quit(); });
});
