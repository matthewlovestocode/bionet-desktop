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
  /** Put some words on the clipboard. */
  copy: (words) => ipcRenderer.invoke("bionet:copy", words),
});
