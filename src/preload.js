// preload.js — safe bridge between renderer and main.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ccPanel", {
  getState: () => ipcRenderer.invoke("get-state"),
  focusSession: (id) => ipcRenderer.invoke("focus-session", id),
  openTerminal: () => ipcRenderer.invoke("open-terminal"),
  installHooks: () => ipcRenderer.invoke("install-hooks"),
  uninstallHooks: () => ipcRenderer.invoke("uninstall-hooks"),
  setConfig: (patch) => ipcRenderer.invoke("set-config", patch),
  onSessions: (cb) => {
    ipcRenderer.on("sessions", (_e, snapshot) => cb(snapshot));
  },
});
