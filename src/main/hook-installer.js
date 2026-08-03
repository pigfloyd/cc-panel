// hook-installer.js - idempotently install just-agent-deck hooks for Claude Code and Codex CLI.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_BACKUP_PATH = CLAUDE_SETTINGS_PATH + ".cc-panel-bak";
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_HOOKS_PATH = path.join(CODEX_HOME, "hooks.json");
const CODEX_CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const CODEX_BACKUP_PATH = CODEX_HOOKS_PATH + ".cc-panel-bak";
const HOOK_SCRIPT = path.join(__dirname, "..", "..", "hook", "cc-panel-hook.js");
const HOOK_CMD = path.join(__dirname, "..", "..", "hook", "cc-panel-hook.cmd");
const MARKERS = ["cc-panel-hook.js", "cc-panel-hook.cmd", "tpanel-hook.js"];

const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "StopFailure",
  "PostToolUseFailure",
  "Notification",
  "PermissionRequest",
];

const CODEX_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
];

const CODEX_EVENT_LABELS = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
};

const CODEX_MATCHER_EVENTS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
]);

const CODEX_ADDITIONAL_CONTEXT_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
]);

const CODEX_DEFAULT_CONTEXT_LIMIT = 2500;

function nodePath() {
  // 1. Ask the shell — catches nvm, fnm, Scoop, Chocolatey, custom PATH installs.
  try {
    const out = require("child_process").execFileSync("where.exe", ["node"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const first = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith(".exe"));
    if (first) return first.trim();
  } catch {}

  // 2. Well-known MSI installer locations as a last resort.
  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

function windowsHookRuntime() {
  // Prefer a real Node binary. Electron-as-Node needs ELECTRON_RUN_AS_NODE, and
  // Claude Code has been observed launching the hook executable without the
  // PowerShell env prefix (leaving stuck Electron GUI processes).
  const node = nodePath();
  if (node) return { executable: node, electron: false, kind: "node" };

  if (fs.existsSync(HOOK_CMD)) {
    return { executable: HOOK_CMD, electron: false, kind: "cmd" };
  }

  const devElectron = path.join(__dirname, "..", "..", "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(devElectron)) return { executable: devElectron, electron: true, kind: "electron" };
  if (process.versions.electron) return { executable: process.execPath, electron: true, kind: "electron" };
  return { executable: "node.exe", electron: false, kind: "node" };
}

function windowsHookCommand(event, source, shell) {
  const runtime = windowsHookRuntime();
  if (runtime.kind === "cmd") {
    const invocation = `"${runtime.executable}" ${event} ${source}`;
    return shell === "powershell" ? `& ${invocation}` : invocation;
  }

  const invocation = `"${runtime.executable}" "${HOOK_SCRIPT}" ${event} ${source}`;
  if (!runtime.electron) return shell === "powershell" ? `& ${invocation}` : invocation;
  // Last-resort Electron-as-Node path for packaged builds without system Node.
  return shell === "powershell"
    ? `$env:ELECTRON_RUN_AS_NODE="1"; & ${invocation}`
    : `set "ELECTRON_RUN_AS_NODE=1" && ${invocation}`;
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8");
  const parsed = raw.trim() ? JSON.parse(raw) : fallback;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(file + " is not an object");
  }
  return parsed;
}

function entryHasMarker(entry) {
  return Array.isArray(entry && entry.hooks) && entry.hooks.some((h) => {
    if (!h) return false;
    const commands = [h.command, h.commandWindows, h.command_windows].filter((value) => typeof value === "string");
    return commands.some((command) => MARKERS.some((marker) => command.includes(marker)));
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalJson(value[key]);
    return result;
  }, {});
}

function normalizedCodexTimeout(event, timeout) {
  if (event === "SessionEnd") {
    return Math.min(3, Math.max(1, Number.isInteger(timeout) ? timeout : 1));
  }
  return Math.max(1, Number.isInteger(timeout) ? timeout : 600);
}

function codexHookHash(event, group, handler, platform = process.platform) {
  const eventLabel = CODEX_EVENT_LABELS[event];
  if (!eventLabel || !handler || handler.type !== "command") return null;

  const command = platform === "win32" && typeof handler.commandWindows === "string"
    ? handler.commandWindows
    : handler.command;
  if (typeof command !== "string" || !command.trim()) return null;

  const normalizedHandler = {
    type: "command",
    command,
    timeout: normalizedCodexTimeout(event, handler.timeout),
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === "string") {
    normalizedHandler.statusMessage = handler.statusMessage;
  }
  if (
    CODEX_ADDITIONAL_CONTEXT_EVENTS.has(event)
    && Number.isInteger(handler.additionalContextLimit)
    && handler.additionalContextLimit !== CODEX_DEFAULT_CONTEXT_LIMIT
  ) {
    normalizedHandler.additionalContextLimit = handler.additionalContextLimit;
  }

  const identity = {
    event_name: eventLabel,
    hooks: [normalizedHandler],
  };
  if (CODEX_MATCHER_EVENTS.has(event) && typeof group.matcher === "string") {
    identity.matcher = group.matcher;
  }
  const serialized = JSON.stringify(canonicalJson(identity));
  return `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
}

function decodeTomlString(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (!value.startsWith('"') || !value.endsWith('"')) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function parseCodexHookStates(raw) {
  const states = new Map();
  let currentKey = null;
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[\s*hooks\.state\.(.+?)\s*\]$/);
    if (header) {
      currentKey = decodeTomlString(header[1]);
      if (currentKey !== null && !states.has(currentKey)) states.set(currentKey, {});
      continue;
    }
    if (trimmed.startsWith("[")) {
      currentKey = null;
      continue;
    }
    if (currentKey === null) continue;

    const trustedHash = trimmed.match(/^trusted_hash\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (trustedHash) {
      const value = decodeTomlString(trustedHash[1]);
      if (value !== null) states.get(currentKey).trustedHash = value;
      continue;
    }
    const enabled = trimmed.match(/^enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (enabled) states.get(currentKey).enabled = enabled[1] === "true";
  }
  return states;
}

function hasTrustedCodexHooks(settings, states, hooksPath = CODEX_HOOKS_PATH, platform = process.platform) {
  const hooks = settings.hooks || {};
  return CODEX_EVENTS.every((event) => {
    const groups = hooks[event];
    if (!Array.isArray(groups)) return false;
    return groups.some((group, groupIndex) => (
      Array.isArray(group && group.hooks) && group.hooks.some((handler, handlerIndex) => {
        const commands = [handler && handler.command, handler && handler.commandWindows, handler && handler.command_windows]
          .filter((value) => typeof value === "string");
        if (!commands.some((command) => MARKERS.some((marker) => command.includes(marker)))) return false;
        const key = `${hooksPath}:${CODEX_EVENT_LABELS[event]}:${groupIndex}:${handlerIndex}`;
        const state = states.get(key);
        return !!state
          && state.enabled !== false
          && state.trustedHash === codexHookHash(event, group, handler, platform);
      })
    ));
  });
}

function readCodexHookStates() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return new Map();
  return parseCodexHookStates(fs.readFileSync(CODEX_CONFIG_PATH, "utf8"));
}

function claudeEntry(event) {
  // Permission-request interception disabled: treat all events as fire-and-forget
  // status hooks so Claude keeps its own terminal permission prompts.
  // const isPermissionRequest = event === "PermissionRequest";
  // Prefer the .cmd launcher when present: Claude Code may invoke hooks via
  // CreateProcess without evaluating PowerShell env assignment syntax.
  const command = fs.existsSync(HOOK_CMD)
    ? `"${HOOK_CMD}" ${event} claude`
    : windowsHookCommand(event, "claude", "powershell");
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        shell: "powershell",
        command: command.startsWith("& ") ? command : `& ${command}`,
        // async: !isPermissionRequest,
        // timeout: isPermissionRequest ? 300 : 5,
        async: true,
        timeout: 5,
      },
    ],
  };
}

function codexEntry(event) {
  const windowsCommand = fs.existsSync(HOOK_CMD)
    ? `"${HOOK_CMD}" ${event} codex`
    : windowsHookCommand(event, "codex", "powershell");
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `node "${HOOK_SCRIPT}" ${event} codex`,
        // Codex runs Windows hooks through PowerShell. Use the .cmd launcher so
        // ELECTRON_RUN_AS_NODE / Node path resolution stays self-contained.
        commandWindows: windowsCommand.startsWith("& ") || windowsCommand.startsWith("$env:")
          ? windowsCommand
          : `& ${windowsCommand}`,
        timeout: 5,
      },
    ],
  };
}

function installEntries(settings, events, buildEntry) {
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  let changed = false;
  for (const ev of events) {
    if (!Array.isArray(settings.hooks[ev])) settings.hooks[ev] = [];
    const desired = buildEntry(ev);
    const existing = settings.hooks[ev].filter(entryHasMarker);
    if (existing.length === 1 && JSON.stringify(existing[0]) === JSON.stringify(desired)) continue;
    settings.hooks[ev] = settings.hooks[ev].filter((e) => !entryHasMarker(e));
    settings.hooks[ev].push(desired);
    changed = true;
  }
  return changed;
}

function removeEntries(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return false;
  let changed = false;
  for (const ev of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[ev])) continue;
    const filtered = settings.hooks[ev].filter((e) => !entryHasMarker(e));
    if (filtered.length !== settings.hooks[ev].length) {
      settings.hooks[ev] = filtered;
      changed = true;
    }
  }
  return changed;
}

function writeJsonFile(file, backupFile, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && !fs.existsSync(backupFile)) {
    fs.copyFileSync(file, backupFile);
  }
  const tmp = file + `.cc-panel.${process.pid}.tmp`;
  const body = JSON.stringify(settings, null, 2);
  JSON.parse(body);
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
}

function hasAll(settings, events) {
  const hooks = settings.hooks || {};
  return events.every((ev) => Array.isArray(hooks[ev]) && hooks[ev].some(entryHasMarker));
}

function isClaudeInstalled() {
  try { return hasAll(readJsonFile(CLAUDE_SETTINGS_PATH, {}), CLAUDE_EVENTS); } catch { return false; }
}

function isCodexInstalled() {
  try {
    const settings = readJsonFile(CODEX_HOOKS_PATH, {});
    return hasAll(settings, CODEX_EVENTS) && hasTrustedCodexHooks(settings, readCodexHookStates());
  } catch { return false; }
}

function inspectClient(file, events, pendingWhenMissing = false) {
  if (!fs.existsSync(file)) {
    return { status: pendingWhenMissing ? "pending_trust" : "not_installed" };
  }
  try {
    const installed = hasAll(readJsonFile(file, {}), events);
    return { status: installed ? "installed" : "not_installed" };
  } catch (err) {
    return { status: "failed", error: String(err.message || err) };
  }
}

function inspect() {
  const codex = inspectClient(CODEX_HOOKS_PATH, CODEX_EVENTS);
  if (codex.status === "installed") {
    try {
      const settings = readJsonFile(CODEX_HOOKS_PATH, {});
      if (!hasTrustedCodexHooks(settings, readCodexHookStates())) codex.status = "pending_trust";
    } catch (err) {
      codex.status = "failed";
      codex.error = String(err.message || err);
    }
  }
  return {
    claude: inspectClient(CLAUDE_SETTINGS_PATH, CLAUDE_EVENTS, true),
    codex,
  };
}

function isInstalled() {
  const claudeReady = !fs.existsSync(CLAUDE_SETTINGS_PATH) || isClaudeInstalled();
  return claudeReady && isCodexInstalled();
}

function installCodex() {
  const settings = readJsonFile(CODEX_HOOKS_PATH, {});
  const changed = installEntries(settings, CODEX_EVENTS, codexEntry);
  if (changed) writeJsonFile(CODEX_HOOKS_PATH, CODEX_BACKUP_PATH, settings);
  return { changed, skipped: false };
}

function installClaude(force = false) {
  if (!force && !fs.existsSync(CLAUDE_SETTINGS_PATH)) return { changed: false, skipped: true };
  const settings = readJsonFile(CLAUDE_SETTINGS_PATH, {});
  const changed = installEntries(settings, CLAUDE_EVENTS, claudeEntry);
  if (changed) writeJsonFile(CLAUDE_SETTINGS_PATH, CLAUDE_BACKUP_PATH, settings);
  return { changed, skipped: false };
}

function safeStep(fn) {
  try {
    return fn();
  } catch (err) {
    return { changed: false, error: String(err.message || err) };
  }
}

function withInstallStatus(step, inspection) {
  if (step.error) return { ...step, status: "failed" };
  return { ...step, ...inspection };
}

function summarizeInstallResults(claude, codex) {
  const clients = { claude, codex };
  return {
    ok: Object.values(clients).every((client) => (
      client.status === "installed" || client.status === "pending_trust"
    )),
    changed: !!claude.changed || !!codex.changed,
    ...clients,
  };
}

function install(targets = null) {
  const selected = targets && typeof targets === "object" ? targets : null;
  const claudeStep = selected && !selected.claude
    ? { changed: false, skipped: true }
    : safeStep(() => installClaude(!!(selected && selected.claude)));
  const codexStep = selected && !selected.codex
    ? { changed: false, skipped: true }
    : safeStep(installCodex);
  const status = inspect();
  return summarizeInstallResults(
    withInstallStatus(claudeStep, status.claude),
    withInstallStatus(codexStep, status.codex),
  );
}

function uninstall() {
  let changed = false;
  const errors = [];
  for (const [file, backup] of [[CLAUDE_SETTINGS_PATH, CLAUDE_BACKUP_PATH], [CODEX_HOOKS_PATH, CODEX_BACKUP_PATH]]) {
    try {
      if (!fs.existsSync(file)) continue;
      const settings = readJsonFile(file, {});
      if (removeEntries(settings)) {
        writeJsonFile(file, backup, settings);
        changed = true;
      }
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }
  if (!changed && errors.length) throw new Error(errors.join('; '));
  return { changed, errors };
}

module.exports = {
  isInstalled,
  install,
  uninstall,
  isClaudeInstalled,
  isCodexInstalled,
  inspect,
  EVENTS: CLAUDE_EVENTS,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  SETTINGS_PATH: CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  CODEX_CONFIG_PATH,
  claudeEntry,
  codexEntry,
  codexHookHash,
  parseCodexHookStates,
  hasTrustedCodexHooks,
  hasAll,
  installEntries,
  summarizeInstallResults,
  windowsHookRuntime,
  windowsHookCommand,
};
