// hook-installer.js - idempotently install cc-panel hooks for Claude Code and Codex CLI.
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_BACKUP_PATH = CLAUDE_SETTINGS_PATH + ".cc-panel-bak";
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_HOOKS_PATH = path.join(CODEX_HOME, "hooks.json");
const CODEX_BACKUP_PATH = CODEX_HOOKS_PATH + ".cc-panel-bak";
const HOOK_SCRIPT = path.join(__dirname, "..", "..", "hook", "cc-panel-hook.js");
const HOOK_CMD = path.join(__dirname, "..", "..", "hook", "cc-panel-hook.cmd");
const MARKERS = ["cc-panel-hook.js", "cc-panel-hook.cmd", "tpanel-hook.js"];

const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "Stop",
  "StopFailure",
  "PostToolUseFailure",
  "Notification",
  "PermissionRequest",
];

const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
];

function nodePath() {
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
  try { return hasAll(readJsonFile(CODEX_HOOKS_PATH, {}), CODEX_EVENTS); } catch { return false; }
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

function installClaude() {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return { changed: false, skipped: true };
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

function install() {
  const claude = safeStep(installClaude);
  const codex = safeStep(installCodex);
  if (claude.error && codex.error) {
    throw new Error(`Claude hooks failed: ${claude.error}; Codex hooks failed: ${codex.error}`);
  }
  return { changed: !!claude.changed || !!codex.changed, claude, codex };
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
  EVENTS: CLAUDE_EVENTS,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  SETTINGS_PATH: CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  codexEntry,
  windowsHookRuntime,
  windowsHookCommand,
};
