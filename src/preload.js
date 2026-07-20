// preload.js — safe bridge between renderer and main.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ccPanel", {
  getState: () => ipcRenderer.invoke("get-state"),
  focusSession: (id) => ipcRenderer.invoke("focus-session", id),
  minimizeAllTerminals: () => ipcRenderer.invoke("minimize-all-terminals"),
  // permission-request UI disabled
  // resolvePermission: (reqId, decision) => ipcRenderer.invoke("resolve-permission", reqId, decision),
  listTerminalApps: () => ipcRenderer.invoke("list-terminal-apps"),
  setTerminalExecutable: (executable) => ipcRenderer.invoke("set-terminal-executable", executable),
  selectTerminalExecutable: () => ipcRenderer.invoke("select-terminal-executable"),
  openTerminal: (command) => ipcRenderer.invoke("open-terminal", command),
  installHooks: () => ipcRenderer.invoke("install-hooks"),
  uninstallHooks: () => ipcRenderer.invoke("uninstall-hooks"),
  setConfig: (patch) => ipcRenderer.invoke("set-config", patch),
  onSessions: (cb) => {
    ipcRenderer.on("sessions", (_e, snapshot) => cb(snapshot));
  },
  // permission-request UI disabled
  // onPermissions: (cb) => {
  //   ipcRenderer.on("permissions", (_e, snapshot) => cb(snapshot));
  // },
});
