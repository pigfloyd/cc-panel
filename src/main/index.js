// index.js — Electron main entry for cc-panel.
const { app, BrowserWindow, ipcMain, screen, dialog, globalShortcut } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const server = require("./server");
const installer = require("./hook-installer");
const { buildHookDiagnostics } = require("./hook-diagnostics");
const { SessionStore } = require("./sessions");
const { captureRunningSessions } = require("./startup-capture");
const {
  normalizeTerminalExecutable,
  buildLaunchSpec,
} = require("./terminal-launcher");
const { detectTerminalApps } = require("./terminal-detector");
const {
  normalizeTerminalDirectory,
  normalizeTerminalHistory,
  recordTerminalDirectory,
  terminalHistoryIncludes,
  removeTerminalDirectory,
} = require("./terminal-history");
const {
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  ensureVisibleBounds,
} = require("./window-bounds");

const demoMode = process.argv.includes("--demo");
if (demoMode) {
  app.setPath("userData", `${app.getPath("userData")}-demo`);
}

let win = null;
let store = null;
let cfg = demoMode
  ? {
      alwaysOnTop: false,
      sound: false,
      autoLaunch: false,
      terminalHistory: [],
      terminalCommand: "claude",
      terminalExecutable: null,
    }
  : config.load();
const savedTerminalHistory = normalizeTerminalHistory(cfg.terminalHistory);
cfg.terminalHistory = savedTerminalHistory.length
  ? savedTerminalHistory
  : normalizeTerminalHistory([cfg.terminalDir]);
let saveBoundsTimer = null;
let hookInstallStatus = null;
let autoLaunchStatus = null;
let sessionCaptureTimer = null;
let sessionCapturePromise = null;
let hookHealthTimer = null;
let eventServiceStatus = { status: "stopped" };
let lastHookEventAt = null;
let hookAutoRepairEnabled = cfg.hooksEnabled !== false;

const TERMINAL_COMMANDS = new Set(["codex", "claude"]);
const MINIMIZE_ALL_SHORTCUT = "CommandOrControl+Shift+Z";
const SESSION_CAPTURE_INTERVAL_MS = 5000;
const HOOK_HEALTH_INTERVAL_MS = 5000;
const APP_ICON_PATH = path.join(
  __dirname,
  "..",
  "assets",
  process.platform === "win32" ? "app-icon.ico" : "app-icon.png",
);

function normalizeTerminalCommand(value) {
  return TERMINAL_COMMANDS.has(value) ? value : "claude";
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
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
  if (demoMode) {
    createWindow();
    app.on("window-all-closed", () => app.quit());
    return;
  }

  store = new SessionStore((snapshot) => {
    if (win && !win.isDestroyed()) win.webContents.send("sessions", snapshot);
  });
  try {
    const eventService = await server.start((body) => {
      lastHookEventAt = Date.now();
      store.handleEvent(body);
      publishHookInstallStatus();
    });
    eventServiceStatus = { status: "running", port: eventService.port };
  } catch (err) {
    dialog.showErrorBox("cc-panel", String(err.message || err));
    app.quit();
    return;
  }

  hookInstallStatus = hookAutoRepairEnabled ? installHooks() : inspectHooks();
  autoLaunchStatus = setAutoLaunch(cfg.autoLaunch);
  createWindow();
  registerIpc();
  registerShortcuts();
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

function registerShortcuts() {
  const registered = globalShortcut.register(MINIMIZE_ALL_SHORTCUT, () => {
    if (store) store.minimizeAll();
  });
  if (!registered) {
    console.error(`[cc-panel] shortcut unavailable: ${MINIMIZE_ALL_SHORTCUT}`);
  }
}

app.on("will-quit", () => globalShortcut.unregisterAll());

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
    const clients = {
      claude: details.claude,
      codex: details.codex,
    };
    const failures = Object.entries(clients)
      .filter(([, client]) => client.status === "failed")
      .map(([name, client]) => `${name === "claude" ? "Claude" : "Codex"}: ${client.error || "未知错误"}`);
    return {
      ok: details.ok,
      installed: Object.values(clients).every((client) => client.status === "installed"),
      claudeInstalled: clients.claude.status === "installed",
      codexInstalled: clients.codex.status === "installed",
      clients,
      error: failures.join("; ") || undefined,
      details,
    };
  } catch (err) {
    const error = String(err.message || err);
    const clients = {
      claude: { status: "failed", error },
      codex: { status: "failed", error },
    };
    return { ok: false, installed: false, clients, error };
  }
}

function inspectHooks() {
  const clients = installer.inspect();
  const failures = Object.entries(clients)
    .filter(([, client]) => client.status === "failed")
    .map(([name, client]) => `${name === "claude" ? "Claude" : "Codex"}: ${client.error || "未知错误"}`);
  return {
    ok: failures.length === 0,
    installed: Object.values(clients).every((client) => client.status === "installed"),
    claudeInstalled: clients.claude.status === "installed",
    codexInstalled: clients.codex.status === "installed",
    clients,
    error: failures.join("; ") || undefined,
  };
}

function hookStatusSnapshot(extra = {}) {
  const status = hookInstallStatus || inspectHooks();
  return {
    ...status,
    diagnostics: buildHookDiagnostics(status, eventServiceStatus, lastHookEventAt),
    ...extra,
  };
}

function publishHookInstallStatus(extra = {}) {
  const snapshot = hookStatusSnapshot(extra);
  if (win && !win.isDestroyed()) win.webContents.send("hook-install-status", snapshot);
  return snapshot;
}

function repairMissingHooks() {
  if (!hookAutoRepairEnabled) return;
  const inspected = installer.inspect();
  const needsRepair = Object.values(inspected).some((client) => (
    client.status === "not_installed" || client.status === "failed"
  ));
  const nextStatus = needsRepair
    ? installHooks()
    : {
        ok: true,
        installed: Object.values(inspected).every((client) => client.status === "installed"),
        claudeInstalled: inspected.claude.status === "installed",
        codexInstalled: inspected.codex.status === "installed",
        clients: inspected,
      };
  const previousSummary = JSON.stringify(hookInstallStatus && hookInstallStatus.clients);
  const nextSummary = JSON.stringify(nextStatus.clients);
  hookInstallStatus = nextStatus;
  if (previousSummary === nextSummary) return;
  if (Object.values(hookInstallStatus.clients).some((client) => client.status === "failed")) {
    console.error("[cc-panel] hook repair failed:", hookInstallStatus.error);
  }
  publishHookInstallStatus();
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
    hooksEnabled: cfg.hooksEnabled !== false,
    terminalCommand: normalizeTerminalCommand(cfg.terminalCommand),
    terminalExecutable: normalizeTerminalExecutable(cfg.terminalExecutable),
    terminalHistory: normalizeTerminalHistory(cfg.terminalHistory),
    ...extra,
  };
}

function persistConfig(mutator) {
  try {
    cfg = config.update(cfg, mutator);
  } catch (err) {
    const error = String(err.message || err);
    console.error("[cc-panel] config save failed:", error);
    return {
      ok: false,
      reason: "config_write_failed",
      error,
      config: configSnapshot(),
    };
  }
  return { ok: true, config: configSnapshot() };
}

function defaultBounds(displays = screen.getAllDisplays()) {
  // Prefer the secondary display; dock to its right edge.
  const primary = screen.getPrimaryDisplay();
  const secondary = displays.find((d) => d.id !== primary.id);
  const wa = (secondary || primary).workArea;
  const width = Math.min(380, wa.width);
  const height = Math.min(demoMode ? 720 : 940, wa.height);
  return { x: wa.x + wa.width - width, y: wa.y, width, height };
}

function createWindow() {
  const displays = screen.getAllDisplays();
  const bounds = ensureVisibleBounds(cfg.bounds, displays, defaultBounds(displays));
  win = new BrowserWindow({
    ...bounds,
    icon: APP_ICON_PATH,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    backgroundColor: "#e8ece8",
    ...(process.platform === "win32" ? {
      backgroundMaterial: "mica",
    } : {}),
    autoHideMenuBar: true,
    alwaysOnTop: demoMode ? false : !!cfg.alwaysOnTop,
    title: demoMode ? "cc-panel demo" : "cc-panel",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
    query: {
      demo: demoMode ? "1" : "0",
    },
  });

  const persistBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (demoMode || !win || win.isDestroyed() || win.isMinimized()) return;
      persistConfig((next) => { next.bounds = win.getBounds(); });
    }, 500);
  };
  win.on("move", persistBounds);
  win.on("resize", persistBounds);
  win.on("closed", () => { win = null; });
}

function registerIpc() {
  ipcMain.handle("get-state", () => ({
    sessions: store.snapshot(),
    hooksInstalled: hookInstallStatus ? hookInstallStatus.installed : installer.isInstalled(),
    claudeInstalled: installer.isClaudeInstalled(),
    codexInstalled: installer.isCodexInstalled(),
    hookInstallStatus: hookStatusSnapshot(),
    autoLaunchStatus,
    config: configSnapshot(),
  }));

  ipcMain.handle("focus-session", (_e, id) => {
    return store.focus(id, screen.getPrimaryDisplay().workArea);
  });

  ipcMain.handle("minimize-all-terminals", () => {
    return store.minimizeAll();
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
    return persistConfig((next) => { next.terminalExecutable = normalized; });
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

    return persistConfig((next) => { next.terminalExecutable = selection.filePaths[0]; });
  });

  ipcMain.handle("open-terminal", async (_event, terminalCommand, requestedDirectory) => {
    if (process.platform !== "win32") return { ok: false, reason: "unsupported_platform" };
    if (!TERMINAL_COMMANDS.has(terminalCommand)) {
      return { ok: false, reason: "invalid_command" };
    }

    let cwd = null;
    if (requestedDirectory !== undefined && requestedDirectory !== null) {
      cwd = normalizeTerminalDirectory(requestedDirectory);
      if (!cwd || !terminalHistoryIncludes(cfg.terminalHistory, cwd)) {
        return { ok: false, reason: "invalid_directory", config: configSnapshot() };
      }
    } else {
      const selection = await dialog.showOpenDialog(win, {
        title: "选择终端启动目录",
        defaultPath: cfg.terminalDir || app.getPath("home"),
        properties: ["openDirectory"],
      });
      if (selection.canceled || !selection.filePaths.length) {
        return { ok: false, reason: "canceled", config: configSnapshot() };
      }
      cwd = normalizeTerminalDirectory(selection.filePaths[0]);
      if (!cwd) return { ok: false, reason: "invalid_directory", config: configSnapshot() };
    }

    if (!isDirectory(cwd)) {
      const saved = persistConfig((next) => {
        next.terminalHistory = removeTerminalDirectory(next.terminalHistory, cwd);
      });
      return {
        ok: false,
        reason: "invalid_directory",
        config: saved.config,
        ...(!saved.ok ? { configSaveError: saved.error } : {}),
      };
    }

    const saved = persistConfig((next) => {
      next.terminalDir = cwd;
      next.terminalHistory = recordTerminalDirectory(next.terminalHistory, cwd);
    });
    const configSaveError = !saved.ok ? saved.error : null;

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
          finish({
            ok: true,
            cwd,
            terminalCommand,
            terminalExecutable: launch.executable,
            config: configSnapshot(),
            ...(configSaveError ? { configSaveError } : {}),
          });
        });
        child.once("error", (err) => {
          finish({
            ok: false,
            reason: "launch_failed",
            error: String(err.message || err),
            config: configSnapshot(),
          });
        });
      } catch (err) {
        resolve({
          ok: false,
          reason: "launch_failed",
          error: String(err.message || err),
          config: configSnapshot(),
        });
      }
    });
  });

  ipcMain.handle("install-hooks", () => {
    hookAutoRepairEnabled = true;
    const saved = persistConfig((next) => { next.hooksEnabled = true; });
    hookInstallStatus = installHooks();
    return publishHookInstallStatus({
      operation: {
        ok: hookInstallStatus.ok && saved.ok,
        action: "install",
        ...(!saved.ok ? { error: saved.error } : {}),
      },
    });
  });

  ipcMain.handle("inspect-hooks", () => {
    hookInstallStatus = inspectHooks();
    return publishHookInstallStatus({ operation: { ok: hookInstallStatus.ok, action: "inspect" } });
  });

  ipcMain.handle("uninstall-hooks", () => {
    try {
      const result = installer.uninstall();
      hookAutoRepairEnabled = false;
      const saved = persistConfig((next) => { next.hooksEnabled = false; });
      hookInstallStatus = inspectHooks();
      const uninstallError = result.errors.length ? result.errors.join("; ") : null;
      return publishHookInstallStatus({
        operation: {
          ok: saved.ok && !uninstallError,
          action: "uninstall",
          changed: result.changed,
          ...(!saved.ok || uninstallError ? { error: saved.error || uninstallError } : {}),
        },
      });
    } catch (err) {
      hookInstallStatus = inspectHooks();
      return publishHookInstallStatus({
        operation: { ok: false, action: "uninstall", error: String(err.message || err) },
      });
    }
  });

  ipcMain.handle("set-config", (_e, patch) => {
    if (patch && typeof patch === "object") {
      const saved = persistConfig((next) => {
        if (typeof patch.alwaysOnTop === "boolean") next.alwaysOnTop = patch.alwaysOnTop;
        if (typeof patch.sound === "boolean") next.sound = patch.sound;
        if (typeof patch.terminalCommand === "string" && TERMINAL_COMMANDS.has(patch.terminalCommand)) {
          next.terminalCommand = patch.terminalCommand;
        }
        if (typeof patch.autoLaunch === "boolean") next.autoLaunch = patch.autoLaunch;
      });
      if (!saved.ok) return saved;

      if (typeof patch.alwaysOnTop === "boolean" && win) win.setAlwaysOnTop(cfg.alwaysOnTop);
      let autoLaunchError = null;
      if (typeof patch.autoLaunch === "boolean") {
        autoLaunchStatus = setAutoLaunch(cfg.autoLaunch);
        if (!autoLaunchStatus.ok) autoLaunchError = autoLaunchStatus.error;
      }
      return {
        ok: true,
        config: configSnapshot(autoLaunchError ? { autoLaunchError } : {}),
      };
    }
    return { ok: true, config: configSnapshot() };
  });
}
