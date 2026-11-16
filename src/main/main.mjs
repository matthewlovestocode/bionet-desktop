// @ts-check
/**
 * The window around the lab.
 *
 * Everything a member does happens in `../core/lab.mjs`, which knows nothing of Electron. This file
 * adds the three things only the desktop can: the device's key kept sealed by the operating system's
 * keychain, a window, and the narrow door between that window and the lab.
 *
 * The window is given no powers. It cannot read files, reach the network or see the key; it can ask
 * for the lab's state and ask for one of a fixed list of things to be done, and that is all.
 */
import { BrowserWindow, app, clipboard, dialog, ipcMain, safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Lab } from "../core/lab.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const flag = (/** @type {string} */ name) => process.argv.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

// A profile is a separate device on the same machine: its own key, its own copy of the lab. It is
// how two members are tried out side by side, and nothing a lab needs day to day.
const profile = flag("profile");
if (profile !== null) app.setPath("userData", join(app.getPath("appData"), "bionet-desktop", "profiles", profile.replace(/[^A-Za-z0-9_-]/g, "")));

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

/** What the window may ask for. Anything else is refused. */
const DOORS = /** @type {const} */ (["setPerson", "found", "join", "setPeer", "setOrigin", "addMember", "addPart", "addItem",
                                     "adjust", "recount", "retire", "offer", "setField", "publish"]);

app.whenReady().then(async () => {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    dialog.showErrorBox("No keychain", "This device has nowhere safe to keep its key, so the app will not make one.");
    app.exit(1);
    return;
  }
  const lab = await new Lab({ dir: app.getPath("userData"), keys }).open();

  /** @param {string} action @param {unknown} payload */
  const act = async (action, payload) => {
    if (!DOORS.includes(/** @type {any} */ (action))) return { ok: false, error: "That is not something this app does." };
    try {
      return { ok: true, result: await /** @type {any} */ (lab)[action](payload) };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  };
  ipcMain.handle("bionet:state", () => lab.snapshot());
  ipcMain.handle("bionet:do", (_event, action, payload) => act(String(action), payload));
  ipcMain.handle("bionet:copy", (_event, words) => clipboard.writeText(String(words).slice(0, 5_000)));

  const window = new BrowserWindow({
    width: 1100, height: 780, minWidth: 720, minHeight: 520, title: "Bionet",
    backgroundColor: "#161615",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // This window shows the lab and nothing else: it does not follow links or open other windows.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  lab.on("change", () => { if (!window.isDestroyed()) window.webContents.send("bionet:state", lab.snapshot()); });
  await window.loadFile(join(here, "../../dist/renderer/index.html"), { hash: flag("tab") ?? "" });

  // For trying the app out without a person at it: do a list of things, then take a picture and quit.
  const script = flag("script");
  if (script !== null) {
    for (const [action, written] of JSON.parse(readFileSync(script, "utf8"))) {
      // A script cannot know a checksum or an item's ID in advance, so it may name them by position.
      const payload = JSON.parse(JSON.stringify(written ?? null)
        .replace(/\{\{part(\d+)\}\}/g, (_all, at) => lab.state?.parts[Number(at)]?.checksum ?? "")
        .replace(/\{\{item(\d+)\}\}/g, (_all, at) => lab.state?.items[Number(at)]?.item ?? ""));
      const answer = await act(action, payload);
      console.log(`${action}: ${answer.ok ? "ok" : answer.error}`);
    }
  }
  const picture = flag("screenshot");
  if (picture !== null) {
    await new Promise((done) => setTimeout(done, Number(flag("wait") ?? 2500)));
    writeFileSync(picture, (await window.webContents.capturePage()).toPNG());
    console.log(`state: ${JSON.stringify({ key: lab.key.publicKey, labId: lab.labId, invite: lab.invite,
                                           person: lab.person, lab: lab.state?.name ?? null, member: lab.snapshot().lab?.member ?? false,
                                           items: lab.state?.items.map((one) => one.amount) ?? [], peer: lab.snapshot().peer.status })}`);
    lab.close();
    app.exit(0);
  }

  app.on("window-all-closed", () => { lab.close(); app.quit(); });
});
