// index.js — Electron main entry for cc-panel.
const { app, BrowserWindow, ipcMain, screen, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const config = require("./config");
const server = require("./server");
const installer = require("./hook-installer");
const { SessionStore } = require("./sessions");
const { PermissionStore } = require("./permissions");

let win = null;
let store = null;
let permissionStore = null;
let cfg = config.load();
let saveBoundsTimer = null;
let hookInstallStatus = null;
let autoLaunchStatus = null;

const TERMINAL_COMMANDS = new Set(["codex", "claude"]);

function normalizeTerminalCommand(value) {
  return TERMINAL_COMMANDS.has(value) ? value : "claude";
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(main);
}

async function main() {
  store = new SessionStore((snapshot) => {
    if (win && !win.isDestroyed()) win.webContents.send("sessions", snapshot);
  });
  permissionStore = new PermissionStore((snapshot) => {
    if (win && !win.isDestroyed()) win.webContents.send("permissions", snapshot);
  });

  try {
    await server.start((body) => store.handleEvent(body), permissionStore);
  } catch (err) {
    dialog.showErrorBox("cc-panel", String(err.message || err));
    app.quit();
    return;
  }

  hookInstallStatus = installHooks();
  autoLaunchStatus = setAutoLaunch(cfg.autoLaunch);
  createWindow();
  registerIpc();

  app.on("window-all-closed", () => {
    server.clearRuntime();
    store.dispose();
    permissionStore.dispose();
    app.quit();
  });
}

function installHooks() {
  try {
    const details = installer.install();
    return {
      ok: true,
      installed: installer.isInstalled(),
      claudeInstalled: installer.isClaudeInstalled(),
      codexInstalled: installer.isCodexInstalled(),
      details,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function loginItemOptions() {
  if (process.platform !== "win32") return {};
  const options = { path: process.execPath };
  if (!app.isPackaged) options.args = [app.getAppPath()];
  return options;
}

function setAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({
      ...loginItemOptions(),
      openAtLogin: !!enabled,
    });
    return { ok: true, enabled: !!enabled };
  } catch (err) {
    return { ok: false, enabled: !!enabled, error: String(err.message || err) };
  }
}

function configSnapshot(extra = {}) {
  return {
    alwaysOnTop: !!cfg.alwaysOnTop,
    sound: !!cfg.sound,
    autoLaunch: !!cfg.autoLaunch,
    terminalCommand: normalizeTerminalCommand(cfg.terminalCommand),
    ...extra,
  };
}
function defaultBounds() {
  // Prefer the secondary display; dock to its right edge.
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const secondary = displays.find((d) => d.id !== primary.id);
  const wa = (secondary || primary).workArea;
  const width = 380;
  const height = Math.min(940, wa.height);
  return { x: wa.x + wa.width - width, y: wa.y, width, height };
}

function createWindow() {
  const bounds = cfg.bounds || defaultBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 300,
    minHeight: 400,
    backgroundColor: "#f7f5f2",
    ...(process.platform === "win32" ? {
      backgroundMaterial: "mica",
    } : {}),
    autoHideMenuBar: true,
    alwaysOnTop: !!cfg.alwaysOnTop,
    title: "cc-panel",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  const persistBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      cfg.bounds = win.getBounds();
      config.save(cfg);
    }, 500);
  };
  win.on("move", persistBounds);
  win.on("resize", persistBounds);
  win.on("closed", () => { win = null; });
}

function registerIpc() {
  ipcMain.handle("get-state", () => ({
    sessions: store.snapshot(),
    permissions: permissionStore.snapshot(),
    hooksInstalled: installer.isInstalled(),
    claudeInstalled: installer.isClaudeInstalled(),
    codexInstalled: installer.isCodexInstalled(),
    hookInstallStatus,
    autoLaunchStatus,
    config: configSnapshot(),
  }));

  ipcMain.handle("focus-session", (_e, id) => {
    return store.focus(id, screen.getPrimaryDisplay().workArea);
  });

  ipcMain.handle("minimize-all-terminals", () => {
    return store.minimizeAll();
  });

  ipcMain.handle("resolve-permission", (_e, reqId, decision) => ({
    ok: permissionStore.resolve(reqId, decision),
  }));

  ipcMain.handle("open-terminal", async (_event, terminalCommand) => {
    if (process.platform !== "win32") return { ok: false, reason: "unsupported_platform" };
    if (!TERMINAL_COMMANDS.has(terminalCommand)) {
      return { ok: false, reason: "invalid_command" };
    }

    const selection = await dialog.showOpenDialog(win, {
      title: "选择 Windows Terminal 启动目录",
      defaultPath: cfg.terminalDir || app.getPath("home"),
      properties: ["openDirectory"],
    });
    if (selection.canceled || !selection.filePaths.length) {
      return { ok: false, reason: "canceled" };
    }

    const cwd = selection.filePaths[0];
    cfg.terminalDir = cwd;
    config.save(cfg);

    return new Promise((resolve) => {
      try {
        const args = ["new-tab", "-d", cwd];
        // npm-installed agent CLIs are usually .cmd/.ps1 shims on Windows.
        // Run them through cmd.exe so Windows Terminal does not try to launch
        // the shim as a native executable and silently fall back to the shell.
        args.push("cmd.exe", "/d", "/k", terminalCommand);
        const child = spawn("wt.exe", args, {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.once("spawn", () => {
          child.unref();
          finish({ ok: true, cwd, terminalCommand });
        });
        child.once("error", (err) => {
          finish({ ok: false, error: String(err.message || err) });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err.message || err) });
      }
    });
  });

  ipcMain.handle("install-hooks", () => {
    hookInstallStatus = installHooks();
    return hookInstallStatus;
  });

  ipcMain.handle("uninstall-hooks", () => {
    try {
      installer.uninstall();
      return { ok: true, installed: installer.isInstalled() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle("set-config", (_e, patch) => {
    if (patch && typeof patch === "object") {
      if (typeof patch.alwaysOnTop === "boolean") {
        cfg.alwaysOnTop = patch.alwaysOnTop;
        if (win) win.setAlwaysOnTop(cfg.alwaysOnTop);
      }
      if (typeof patch.sound === "boolean") cfg.sound = patch.sound;
      if (typeof patch.terminalCommand === "string" && TERMINAL_COMMANDS.has(patch.terminalCommand)) {
        cfg.terminalCommand = patch.terminalCommand;
      }
      let autoLaunchError = null;
      if (typeof patch.autoLaunch === "boolean") {
        cfg.autoLaunch = patch.autoLaunch;
        const result = setAutoLaunch(cfg.autoLaunch);
        autoLaunchStatus = result;
        if (!result.ok) autoLaunchError = result.error;
      }
      config.save(cfg);
      return configSnapshot(autoLaunchError ? { autoLaunchError } : {});
    }
    return configSnapshot();
  });
}
