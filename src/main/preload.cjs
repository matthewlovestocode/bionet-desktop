// The only things the window can do. It runs sandboxed, so it has to be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bionet", {
  /** The lab as it stands. */
  state: () => ipcRenderer.invoke("bionet:state"),
  /** Ask for one thing to be done. Resolves to { ok, result } or { ok: false, error }. */
  do: (action, payload) => ipcRenderer.invoke("bionet:do", action, payload),
  /** Be told whenever the lab changes. Returns a function that stops the telling. */
  onState: (listener) => {
    const heard = (_event, state) => listener(state);
    ipcRenderer.on("bionet:state", heard);
    return () => ipcRenderer.removeListener("bionet:state", heard);
  },
  /** Hand the person a file to keep: they choose where. Resolves to whether it was saved. */
  save: (name, text) => ipcRenderer.invoke("bionet:save", name, text),
  /**
   * The adviser's door: whether it is open, where, and what the adviser has lately done. The window
   * can open and shut it. It never sees the token; `copy` puts the way to connect on the clipboard.
   */
  adviser: {
    state: () => ipcRenderer.invoke("bionet:adviser:state"),
    turn: (on) => ipcRenderer.invoke("bionet:adviser:turn", on === true),
    copy: () => ipcRenderer.invoke("bionet:adviser:copy"),
    renew: () => ipcRenderer.invoke("bionet:adviser:renew"),
    onState: (listener) => {
      const heard = (_event, state) => listener(state);
      ipcRenderer.on("bionet:adviser", heard);
      return () => ipcRenderer.removeListener("bionet:adviser", heard);
    },
  },
  /** Put some words on the clipboard. */
  copy: (words) => ipcRenderer.invoke("bionet:copy", words),
});
