// index.js — Electron main entry for cc-panel.
const { app, BrowserWindow, ipcMain, screen, dialog, globalShortcut } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const server = require("./server");
const installer = require("./hook-installer");
const { buildHookDiagnostics } = require("./hook-diagnostics");
const { detectClients, buildOnboardingStatus } = require("./onboarding");
const { SessionStore } = require("./sessions");
const { captureRunningSessions } = require("./startup-capture");
const {
  normalizeTerminalExecutable,
  buildLaunchSpec,
} = require("./terminal-launcher");
const { detectTerminalApps } = require("./terminal-detector");
const { isAutoFocusState, selectAttentionCandidates } = require("./attention-focus");
const {
  buildVSCodeLaunchSpec,
  directoryKey,
  findOpenDirectories,
} = require("./vscode");
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
      autoFocusAttention: false,
      openVSCodeWithTerminal: false,
      autoLaunch: false,
      onboardingCompleted: true,
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
let detectedClients = { claude: false, codex: false };
let onboardingTestEvent = { ok: false };
let attentionBatchTimer = null;
let attentionTransitionSequence = 0;
const pendingAttentionTransitions = new Map();
let detectedVSCodeDirectories = new Set();
const openingVSCodeDirectories = new Map();

const TERMINAL_COMMANDS = new Set(["codex", "claude"]);
const MINIMIZE_ALL_SHORTCUT = "Alt+Z";
const ATTENTION_SHORTCUT = "Alt+C";
const ATTENTION_BATCH_DELAY_MS = 500;
const VSCODE_OPEN_GRACE_MS = 15000;
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

  store = new SessionStore(
    publishSessions,
    queueAttentionTransition,
  );
  try {
    const eventService = await server.start((body) => {
      lastHookEventAt = Date.now();
      if (body && body.__ccPanelTest === true) {
        publishHookInstallStatus();
        return;
      }
      store.handleEvent(body);
      publishHookInstallStatus();
    });
    eventServiceStatus = { status: "running", port: eventService.port };
  } catch (err) {
    dialog.showErrorBox("cc-panel", String(err.message || err));
    app.quit();
    return;
  }

  await runOnboardingChecks(hookAutoRepairEnabled);
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
    clearAttentionBatch();
    server.clearRuntime();
    store.dispose();
    app.quit();
  });
}

function registerShortcuts() {
  registerShortcut(MINIMIZE_ALL_SHORTCUT, () => {
    if (store) store.minimizeAll();
  });
  registerShortcut(ATTENTION_SHORTCUT, focusNextAttentionSession);
}

function registerShortcut(accelerator, callback) {
  const registered = globalShortcut.register(accelerator, callback);
  if (!registered) {
    console.error(`[cc-panel] shortcut unavailable: ${accelerator}`);
  }
}

function focusNextAttentionSession() {
  if (!store) return;
  const target = store.nextAttentionSession();
  if (!target) return;

  if (!target.hasWindow) {
    revealSessionInPanel(target.id, "no_hwnd");
    return;
  }

  const result = store.focus(
    target.id,
    screen.getPrimaryDisplay().workArea,
    { reposition: false },
  );
  if (!result.ok) {
    revealSessionInPanel(target.id, result.reason);
    return;
  }

  notifySessionCard(target.id);
}

function queueAttentionTransition(transition) {
  if (!transition || !transition.cardKey) return;
  if (!isAutoFocusState(transition.state)) {
    pendingAttentionTransitions.delete(transition.cardKey);
    return;
  }
  if (!cfg.autoFocusAttention) return;

  pendingAttentionTransitions.set(transition.cardKey, {
    ...transition,
    sequence: ++attentionTransitionSequence,
  });
  if (!attentionBatchTimer) {
    attentionBatchTimer = setTimeout(flushAttentionBatch, ATTENTION_BATCH_DELAY_MS);
  }
}

function flushAttentionBatch() {
  attentionBatchTimer = null;
  const pending = [...pendingAttentionTransitions.values()];
  pendingAttentionTransitions.clear();
  if (!cfg.autoFocusAttention || !store || !pending.length) return;

  const candidates = selectAttentionCandidates(pending, store.snapshot());

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  for (const target of candidates) {
    const result = store.focus(target.id, display.workArea, { reposition: false });
    if (result.ok) return;
  }
}

function clearAttentionBatch() {
  clearTimeout(attentionBatchTimer);
  attentionBatchTimer = null;
  pendingAttentionTransitions.clear();
}

function revealSessionInPanel(id, reason) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();

  notifySessionCard(id, reason);
}

function notifySessionCard(id, reason) {
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (win && !win.isDestroyed()) win.webContents.send("reveal-session", { id, reason });
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", send);
  else send();
}

app.on("will-quit", () => globalShortcut.unregisterAll());

function refreshRunningSessions() {
  if (sessionCapturePromise) return sessionCapturePromise;
  sessionCapturePromise = captureRunningSessions(store, updateVSCodeStatus)
    .catch((err) => {
      console.error("[cc-panel] session capture failed:", String(err.message || err));
      return [];
    })
    .finally(() => { sessionCapturePromise = null; });
  return sessionCapturePromise;
}

function activeVSCodeDirectories(now = Date.now()) {
  const active = new Set(detectedVSCodeDirectories);
  for (const [key, expiresAt] of openingVSCodeDirectories) {
    if (expiresAt <= now) openingVSCodeDirectories.delete(key);
    else active.add(key);
  }
  return active;
}

function sessionSnapshotWithVSCode(snapshot = store ? store.snapshot() : []) {
  const openDirectories = activeVSCodeDirectories();
  return snapshot.map((session) => ({
    ...session,
    vscodeOpen: !!directoryKey(session.cwd) && openDirectories.has(directoryKey(session.cwd)),
  }));
}

function publishSessions(snapshot = store ? store.snapshot() : []) {
  const enriched = sessionSnapshotWithVSCode(snapshot);
  if (win && !win.isDestroyed()) win.webContents.send("sessions", enriched);
  return enriched;
}

function updateVSCodeStatus(systemSnapshot) {
  detectedVSCodeDirectories = findOpenDirectories(store ? store.snapshot() : [], systemSnapshot);
  for (const key of detectedVSCodeDirectories) openingVSCodeDirectories.delete(key);
  publishSessions();
}

function launchVSCodeDirectory(directory) {
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: false, reason: "unsupported_platform" });
  }
  const key = directoryKey(directory);
  if (!key || !isDirectory(directory)) {
    return Promise.resolve({ ok: false, reason: "invalid_directory" });
  }
  if (activeVSCodeDirectories().has(key)) {
    return Promise.resolve({ ok: true, cwd: directory, vscodeOpen: true, alreadyOpen: true });
  }

  const launch = buildVSCodeLaunchSpec(directory);
  if (!launch) return Promise.resolve({ ok: false, reason: "vscode_not_found" });

  return new Promise((resolve) => {
    try {
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
        openingVSCodeDirectories.set(key, Date.now() + VSCODE_OPEN_GRACE_MS);
        publishSessions();
        setTimeout(() => publishSessions(), VSCODE_OPEN_GRACE_MS + 100);
        finish({ ok: true, cwd: directory, vscodeOpen: true });
      });
      child.once("error", (err) => {
        finish({
          ok: false,
          reason: err && err.code === "ENOENT" ? "vscode_not_found" : "launch_failed",
          error: String(err && err.message || err),
        });
      });
    } catch (err) {
      resolve({
        ok: false,
        reason: "launch_failed",
        error: String(err.message || err),
      });
    }
  });
}

function installHooks(targets = null) {
  try {
    const details = installer.install(targets);
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

function onboardingStatusSnapshot() {
  return buildOnboardingStatus({
    detected: detectedClients,
    hookStatus: hookStatusSnapshot(),
    testEvent: onboardingTestEvent,
    completed: cfg.onboardingCompleted === true,
  });
}

async function runOnboardingChecks(install = false) {
  detectedClients = detectClients();
  hookInstallStatus = install ? installHooks() : inspectHooks();
  if (install && detectedClients.claude && hookInstallStatus.clients.claude.status === "pending_trust") {
    hookInstallStatus = installHooks({ claude: true, codex: false });
  }
  if (eventServiceStatus.status === "running" && eventServiceStatus.port) {
    onboardingTestEvent = await server.sendTestEvent(eventServiceStatus.port);
  } else {
    onboardingTestEvent = { ok: false, error: "event service is not running", testedAt: Date.now() };
  }
  return onboardingStatusSnapshot();
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
    autoFocusAttention: !!cfg.autoFocusAttention,
    openVSCodeWithTerminal: !!cfg.openVSCodeWithTerminal,
    language: cfg.language === "en" ? "en" : "zh-CN",
    autoLaunch: !!cfg.autoLaunch,
    hooksEnabled: cfg.hooksEnabled !== false,
    onboardingCompleted: cfg.onboardingCompleted === true,
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
    sessions: sessionSnapshotWithVSCode(),
    hooksInstalled: hookInstallStatus ? hookInstallStatus.installed : installer.isInstalled(),
    claudeInstalled: installer.isClaudeInstalled(),
    codexInstalled: installer.isCodexInstalled(),
    hookInstallStatus: hookStatusSnapshot(),
    onboarding: onboardingStatusSnapshot(),
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
          const terminalResult = {
            ok: true,
            cwd,
            terminalCommand,
            terminalExecutable: launch.executable,
            config: configSnapshot(),
            ...(configSaveError ? { configSaveError } : {}),
          };
          if (!cfg.openVSCodeWithTerminal) {
            finish(terminalResult);
            return;
          }
          void launchVSCodeDirectory(cwd).then((vscode) => {
            finish({ ...terminalResult, vscode });
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

  ipcMain.handle("open-vscode", async (_event, requestedDirectory) => {
    const requestedKey = directoryKey(requestedDirectory);
    const session = requestedKey && store.snapshot()
      .find((candidate) => directoryKey(candidate.cwd) === requestedKey);
    if (!session || !isDirectory(session.cwd)) {
      return { ok: false, reason: "invalid_directory" };
    }
    return launchVSCodeDirectory(session.cwd);
  });

  ipcMain.handle("inspect-hooks", () => {
    hookInstallStatus = inspectHooks();
    return publishHookInstallStatus({ operation: { ok: hookInstallStatus.ok, action: "inspect" } });
  });

  ipcMain.handle("run-onboarding-checks", async () => {
    if (!hookAutoRepairEnabled) {
      hookAutoRepairEnabled = true;
      persistConfig((next) => { next.hooksEnabled = true; });
    }
    const status = await runOnboardingChecks(true);
    publishHookInstallStatus();
    return status;
  });

  ipcMain.handle("complete-onboarding", () => {
    const status = onboardingStatusSnapshot();
    if (!status.ready) return { ok: false, reason: "checks_incomplete", onboarding: status };
    const saved = persistConfig((next) => { next.onboardingCompleted = true; });
    return { ok: saved.ok, ...(!saved.ok ? { reason: saved.reason } : {}), onboarding: onboardingStatusSnapshot() };
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
        if (typeof patch.autoFocusAttention === "boolean") {
          next.autoFocusAttention = patch.autoFocusAttention;
        }
        if (typeof patch.openVSCodeWithTerminal === "boolean") {
          next.openVSCodeWithTerminal = patch.openVSCodeWithTerminal;
        }
        if (patch.language === "zh-CN" || patch.language === "en") next.language = patch.language;
        if (typeof patch.terminalCommand === "string" && TERMINAL_COMMANDS.has(patch.terminalCommand)) {
          next.terminalCommand = patch.terminalCommand;
        }
        if (typeof patch.autoLaunch === "boolean") next.autoLaunch = patch.autoLaunch;
      });
      if (!saved.ok) return saved;

      if (typeof patch.alwaysOnTop === "boolean" && win) win.setAlwaysOnTop(cfg.alwaysOnTop);
      if (patch.autoFocusAttention === false) clearAttentionBatch();
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
