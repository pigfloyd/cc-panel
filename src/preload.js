// preload.js — safe bridge between renderer and main.
const { clipboard, contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ccPanel", {
  getState: () => ipcRenderer.invoke("get-state"),
  focusSession: (id) => ipcRenderer.invoke("focus-session", id),
  minimizeAllTerminals: () => ipcRenderer.invoke("minimize-all-terminals"),
  listTerminalApps: () => ipcRenderer.invoke("list-terminal-apps"),
  setTerminalExecutable: (executable) => ipcRenderer.invoke("set-terminal-executable", executable),
  selectTerminalExecutable: () => ipcRenderer.invoke("select-terminal-executable"),
  openTerminal: (command, directory) => ipcRenderer.invoke("open-terminal", command, directory),
  openVSCode: (directory) => ipcRenderer.invoke("open-vscode", directory),
  installHooks: () => ipcRenderer.invoke("install-hooks"),
  inspectHooks: () => ipcRenderer.invoke("inspect-hooks"),
  runOnboardingChecks: () => ipcRenderer.invoke("run-onboarding-checks"),
  completeOnboarding: () => ipcRenderer.invoke("complete-onboarding"),
  uninstallHooks: () => ipcRenderer.invoke("uninstall-hooks"),
  copyHooksCommand: () => clipboard.writeText("/hooks"),
  setConfig: (patch) => ipcRenderer.invoke("set-config", patch),
  onSessions: (cb) => {
    ipcRenderer.on("sessions", (_e, snapshot) => cb(snapshot));
  },
  onRevealSession: (cb) => {
    ipcRenderer.on("reveal-session", (_e, id) => cb(id));
  },
  onHookInstallStatus: (cb) => {
    ipcRenderer.on("hook-install-status", (_e, status) => cb(status));
  },
});
