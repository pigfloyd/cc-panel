// index.js — Electron main entry for cc-panel.
const { app, BrowserWindow, ipcMain, screen, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const config = require("./config");
const server = require("./server");
const installer = require("./hook-installer");
const { SessionStore } = require("./sessions");
const { captureRunningSessions } = require("./startup-capture");
const {
  normalizeTerminalExecutable,
  buildLaunchSpec,
} = require("./terminal-launcher");
const { detectTerminalApps } = require("./terminal-detector");
const {
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  COMPACT_WINDOW_WIDTH,
  COMPACT_WINDOW_HEIGHT,
  compactBounds,
  ensureVisibleBounds,
} = require("./window-bounds");

let win = null;
let store = null;
let cfg = config.load();
let saveBoundsTimer = null;
let hookInstallStatus = null;
let autoLaunchStatus = null;
let sessionCaptureTimer = null;
let sessionCapturePromise = null;
let hookHealthTimer = null;

const TERMINAL_COMMANDS = new Set(["codex", "claude"]);
const SESSION_CAPTURE_INTERVAL_MS = 5000;
const HOOK_HEALTH_INTERVAL_MS = 5000;

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
  try {
    await server.start((body) => store.handleEvent(body));
  } catch (err) {
    dialog.showErrorBox("cc-panel", String(err.message || err));
    app.quit();
    return;
  }

  hookInstallStatus = installHooks();
  autoLaunchStatus = setAutoLaunch(cfg.autoLaunch);
  createWindow();
  registerIpc();
  void refreshRunningSessions();
  sessionCaptureTimer = setInterval(() => void refreshRunningSessions(), SESSION_CAPTURE_INTERVAL_MS);
  hookHealthTimer = setInterval(repairMissingHooks, HOOK_HEALTH_INTERVAL_MS);

  app.on("window-all-closed", () => {
    clearInterval(sessionCaptureTimer);
    clearInterval(hookHealthTimer);
    server.clearRuntime();
    store.dispose();
    app.quit();
  });
}

function refreshRunningSessions() {
  if (sessionCapturePromise) return sessionCapturePromise;
  sessionCapturePromise = captureRunningSessions(store)
    .catch((err) => {
      console.error("[cc-panel] session capture failed:", String(err.message || err));
      return [];
    })
    .finally(() => { sessionCapturePromise = null; });
  return sessionCapturePromise;
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

function repairMissingHooks() {
  if (installer.isInstalled()) return;
  hookInstallStatus = installHooks();
  if (!hookInstallStatus.ok) {
    console.error("[cc-panel] hook repair failed:", hookInstallStatus.error);
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
    compactMode: !!cfg.compactMode,
    alwaysOnTop: !!cfg.alwaysOnTop,
    sound: !!cfg.sound,
    autoLaunch: !!cfg.autoLaunch,
    terminalCommand: normalizeTerminalCommand(cfg.terminalCommand),
    terminalExecutable: normalizeTerminalExecutable(cfg.terminalExecutable),
    ...extra,
  };
}
function defaultBounds(displays = screen.getAllDisplays()) {
  // Prefer the secondary display; dock to its right edge.
  const primary = screen.getPrimaryDisplay();
  const secondary = displays.find((d) => d.id !== primary.id);
  const wa = (secondary || primary).workArea;
  const width = Math.min(380, wa.width);
  const height = Math.min(940, wa.height);
  return { x: wa.x + wa.width - width, y: wa.y, width, height };
}

function createWindow() {
  const displays = screen.getAllDisplays();
  const expandedBounds = ensureVisibleBounds(cfg.bounds, displays, defaultBounds(displays));
  const isCompact = !!cfg.compactMode;
  const bounds = isCompact
    ? compactBounds(expandedBounds, screen.getDisplayMatching(expandedBounds).workArea)
    : expandedBounds;
  win = new BrowserWindow({
    ...bounds,
    minWidth: isCompact ? COMPACT_WINDOW_WIDTH : MIN_WINDOW_WIDTH,
    minHeight: isCompact ? Math.min(COMPACT_WINDOW_HEIGHT, bounds.height) : MIN_WINDOW_HEIGHT,
    resizable: !isCompact,
    maximizable: !isCompact,
    backgroundColor: "#eef1f4",
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
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
    query: { compact: isCompact ? "1" : "0" },
  });

  const persistBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized() || cfg.compactMode) return;
      cfg.bounds = win.getBounds();
      config.save(cfg);
    }, 500);
  };
  win.on("move", persistBounds);
  win.on("resize", persistBounds);
  win.on("closed", () => { win = null; });
}

function setCompactMode(enabled) {
  const compact = !!enabled;
  if (!win || win.isDestroyed() || compact === !!cfg.compactMode) {
    return configSnapshot();
  }

  clearTimeout(saveBoundsTimer);
  if (compact) {
    cfg.bounds = win.getBounds();
    cfg.compactMode = true;
    const workArea = screen.getDisplayMatching(cfg.bounds).workArea;
    const bounds = compactBounds(cfg.bounds, workArea);
    win.setResizable(true);
    win.setMinimumSize(COMPACT_WINDOW_WIDTH, Math.min(COMPACT_WINDOW_HEIGHT, bounds.height));
    win.setBounds(bounds);
    win.setMaximizable(false);
    win.setResizable(false);
  } else {
    cfg.compactMode = false;
    const displays = screen.getAllDisplays();
    const bounds = ensureVisibleBounds(cfg.bounds, displays, defaultBounds(displays));
    win.setResizable(true);
    win.setMaximizable(true);
    win.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);
    win.setBounds(bounds);
  }
  config.save(cfg);
  return configSnapshot();
}

function registerIpc() {
  ipcMain.handle("get-state", () => ({
    sessions: store.snapshot(),
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

  ipcMain.handle("set-compact-mode", (_e, enabled) => {
    return setCompactMode(enabled);
  });

  ipcMain.handle("list-terminal-apps", () => ({
    ok: true,
    terminals: detectTerminalApps(),
  }));

  ipcMain.handle("set-terminal-executable", (_e, executable) => {
    const normalized = normalizeTerminalExecutable(executable);
    if (normalized && path.extname(normalized).toLowerCase() !== ".exe") {
      return { ok: false, reason: "invalid_executable", config: configSnapshot() };
    }
    cfg.terminalExecutable = normalized;
    config.save(cfg);
    return { ok: true, config: configSnapshot() };
  });

  ipcMain.handle("select-terminal-executable", async () => {
    const current = normalizeTerminalExecutable(cfg.terminalExecutable);
    const selection = await dialog.showOpenDialog(win, {
      title: "选择终端程序",
      defaultPath: current || undefined,
      properties: ["openFile"],
      filters: [{ name: "可执行程序", extensions: ["exe"] }],
    });
    if (selection.canceled || !selection.filePaths.length) {
      return { ok: false, reason: "canceled", config: configSnapshot() };
    }
    if (path.extname(selection.filePaths[0]).toLowerCase() !== ".exe") {
      return { ok: false, reason: "invalid_executable", config: configSnapshot() };
    }

    cfg.terminalExecutable = selection.filePaths[0];
    config.save(cfg);
    return { ok: true, config: configSnapshot() };
  });

  ipcMain.handle("open-terminal", async (_event, terminalCommand) => {
    if (process.platform !== "win32") return { ok: false, reason: "unsupported_platform" };
    if (!TERMINAL_COMMANDS.has(terminalCommand)) {
      return { ok: false, reason: "invalid_command" };
    }

    const selection = await dialog.showOpenDialog(win, {
      title: "选择终端启动目录",
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
        const terminalExecutable = normalizeTerminalExecutable(cfg.terminalExecutable);
        const launch = buildLaunchSpec(terminalExecutable, cwd, terminalCommand);
        const child = spawn(launch.executable, launch.args, {
          cwd: launch.cwd,
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
          finish({ ok: true, cwd, terminalCommand, terminalExecutable: launch.executable });
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
