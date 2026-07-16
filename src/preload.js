// preload.js — safe bridge between renderer and main.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ccPanel", {
  getState: () => ipcRenderer.invoke("get-state"),
  focusSession: (id) => ipcRenderer.invoke("focus-session", id),
  minimizeAllTerminals: () => ipcRenderer.invoke("minimize-all-terminals"),
  resolvePermission: (reqId, decision) => ipcRenderer.invoke("resolve-permission", reqId, decision),
  openTerminal: (command) => ipcRenderer.invoke("open-terminal", command),
  installHooks: () => ipcRenderer.invoke("install-hooks"),
  uninstallHooks: () => ipcRenderer.invoke("uninstall-hooks"),
  setConfig: (patch) => ipcRenderer.invoke("set-config", patch),
  onSessions: (cb) => {
    ipcRenderer.on("sessions", (_e, snapshot) => cb(snapshot));
  },
  onPermissions: (cb) => {
    ipcRenderer.on("permissions", (_e, snapshot) => cb(snapshot));
  },
});
