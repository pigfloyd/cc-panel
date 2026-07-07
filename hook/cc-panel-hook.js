#!/usr/bin/env node
// cc-panel hook — invoked by Claude Code hooks: node cc-panel-hook.js <EventName>
// Zero third-party dependencies. Reads hook JSON from stdin, resolves the
// Windows Terminal window (HWND) hosting this session, and POSTs state to the
// cc-panel panel over localhost. Silently exits if the panel is not running.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const EVENTS = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "StopFailure",
  "PostToolUseFailure",
  "Notification",
]);
// Only these events pay for the ~300ms PowerShell process snapshot; the panel
// keys everything else off session_id.
const SNAPSHOT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

const PORTS = [24333, 24334, 24335, 24336, 24337];
const RUNTIME_PATH = path.join(os.homedir(), ".cc-panel", "runtime.json");
const POST_TIMEOUT_MS = 100;
const STDIN_TIMEOUT_MS = 400;

const WT_WINDOW_CLASS = "cascadia_hosting_window_class";
const WT_PROCESS_NAMES = new Set(["windowsterminal.exe", "windowsterminalpreview.exe"]);
const TERMINAL_NAMES = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "conhost.exe", "openconsole.exe", "code.exe", "alacritty.exe",
  "wezterm-gui.exe", "tabby.exe", "warp.exe", "ghostty.exe",
]);
const SYSTEM_BOUNDARY = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);

const PROMPT_MAX = 80;
const PROMPT_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}/i;

function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    let timer = null;
    const onData = (c) => chunks.push(c);
    function finish() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      let payload = {};
      try {
        const raw = Buffer.concat(chunks).toString();
        if (raw.trim()) payload = JSON.parse(raw);
      } catch {}
      resolve(payload);
    }
    process.stdin.on("data", onData);
    process.stdin.on("end", finish);
    timer = setTimeout(finish, STDIN_TIMEOUT_MS);
  });
}

// One PowerShell spawn returns both the full process table and the current
// foreground window (HWND / pid / class), so the walk below needs no further
// process queries.
const PS_SNAPSHOT_SCRIPT = `
$typeDef = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CcPanelWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
Add-Type -TypeDefinition $typeDef
$fg = [CcPanelWin32]::GetForegroundWindow()
if ($fg -ne [IntPtr]::Zero) {
  $root = [CcPanelWin32]::GetAncestor($fg, 2)
  if ($root -ne [IntPtr]::Zero) { $fg = $root }
}
$fgPid = 0
$fgClass = ""
if ($fg -ne [IntPtr]::Zero) {
  [void][CcPanelWin32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $sb = New-Object System.Text.StringBuilder 256
  [void][CcPanelWin32]::GetClassName($fg, $sb, $sb.Capacity)
  $fgClass = $sb.ToString()
}
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
[pscustomobject]@{
  processes = $processes
  foreground = [pscustomobject]@{
    hwnd = if ($fg -eq [IntPtr]::Zero) { $null } else { $fg.ToInt64().ToString() }
    pid = $fgPid
    className = $fgClass
  }
} | ConvertTo-Json -Compress -Depth 4
`;

function getSnapshot() {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_SNAPSHOT_SCRIPT],
      { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    const parsed = JSON.parse((out || "").trim());
    const list = Array.isArray(parsed.processes) ? parsed.processes : (parsed.processes ? [parsed.processes] : []);
    const procs = new Map();
    for (const p of list) {
      const pid = Number(p && p.ProcessId);
      if (!Number.isFinite(pid)) continue;
      procs.set(pid, {
        name: typeof p.Name === "string" ? p.Name.toLowerCase() : "",
        ppid: Number(p.ParentProcessId) || 0,
        commandLine: typeof p.CommandLine === "string" ? p.CommandLine : "",
      });
    }
    return { procs, foreground: parsed.foreground || null };
  } catch {
    return null;
  }
}

// Walk up from our parent to find the claude process and the hosting terminal.
// The foreground window counts as this session's WT window only if it really
// is a Windows Terminal window — the user just typed here, so at
// SessionStart/UserPromptSubmit time that inference is sound.
function resolveFromSnapshot(snapshot) {
  const result = { agent_pid: null, terminal_pid: null, wt_hwnd: null };
  if (!snapshot) return result;

  let pid = process.ppid;
  for (let i = 0; i < 10; i++) {
    const info = snapshot.procs.get(pid);
    if (!info) break;
    if (!result.agent_pid) {
      if (info.name === "claude.exe" || info.name === "codex.exe") {
        result.agent_pid = pid;
      } else if (info.name === "node.exe" &&
                 (info.commandLine.includes("claude-code") ||
                  info.commandLine.includes("@anthropic-ai") ||
                  /\bcodex\b/i.test(info.commandLine))) {
        result.agent_pid = pid;
      }
    }
    if (SYSTEM_BOUNDARY.has(info.name)) break;
    if (TERMINAL_NAMES.has(info.name)) result.terminal_pid = pid;
    if (WT_PROCESS_NAMES.has(info.name)) result.terminal_pid = pid;
    if (!info.ppid || info.ppid === pid) break;
    pid = info.ppid;
  }

  const fg = snapshot.foreground;
  if (fg && fg.hwnd && /^[1-9]\d{0,18}$/.test(String(fg.hwnd))) {
    const fgProc = snapshot.procs.get(Number(fg.pid));
    const cls = String(fg.className || "").toLowerCase();
    if (cls === WT_WINDOW_CLASS && fgProc && WT_PROCESS_NAMES.has(fgProc.name)) {
      result.wt_hwnd = String(fg.hwnd);
    }
  }
  return result;
}

function sessionIdFromPayload(payload) {
  const candidates = [
    payload.session_id,
    payload.sessionId,
    payload.thread_id,
    payload.threadId,
    payload.conversation_id,
    payload.conversationId,
    payload.run_id,
    payload.runId,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (payload.transcript_path || payload.transcriptPath) {
    return String(payload.transcript_path || payload.transcriptPath);
  }
  return `session:${process.pid}:${process.cwd()}`;
}

function toolNameFromPayload(payload) {
  const candidates = [
    payload.tool_name,
    payload.toolName,
    payload.matcher,
    payload.tool && payload.tool.name,
    payload.tool && payload.tool.type,
    payload.request && payload.request.tool_name,
    payload.request && payload.request.toolName,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractPromptLine(prompt) {
  if (typeof prompt !== "string") return null;
  for (const line of prompt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (PROMPT_SECRET_RE.test(t)) return null;
    return t.length > PROMPT_MAX ? `${t.slice(0, PROMPT_MAX - 1)}…` : t;
  }
  return null;
}

function candidatePorts() {
  const ports = [];
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
    const p = Number(raw && raw.port);
    if (PORTS.includes(p)) ports.push(p);
  } catch {}
  for (const p of PORTS) if (!ports.includes(p)) ports.push(p);
  return ports;
}

function postOnce(port, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/event",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: POST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 && res.headers["x-cc-panel"] === "1");
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

async function post(bodyObj) {
  const body = JSON.stringify(bodyObj);
  for (const port of candidatePorts()) {
    if (await postOnce(port, body)) return;
  }
}

async function main() {
  const event = process.argv[2];
  if (!EVENTS.has(event)) process.exit(0);

  // Snapshot runs while stdin is still buffering, so its cost overlaps I/O.
  const snapshot = SNAPSHOT_EVENTS.has(event) ? getSnapshot() : null;
  const payload = await readStdinJson();

  const body = {
    v: 1,
    event,
    ts: Date.now(),
    session_id: sessionIdFromPayload(payload),
    cwd: payload.cwd || payload.current_working_directory || process.cwd(),
  };
  if (payload.transcript_path) body.transcript_path = payload.transcript_path;
  if (payload.transcriptPath && !body.transcript_path) body.transcript_path = payload.transcriptPath;
  if (typeof payload.source === "string") body.source = payload.source;
  if (typeof payload.reason === "string" && !body.source) body.source = payload.reason;
  const toolName = toolNameFromPayload(payload);
  if ((event === "PreToolUse" || event === "PostToolUse" || event === "PermissionRequest") && toolName) {
    body.tool_name = toolName;
  }
  if (event === "UserPromptSubmit") {
    const line = extractPromptLine(payload.prompt || payload.user_prompt || payload.input);
    if (line) body.prompt_line = line;
  }
  if ((event === "Notification" || event === "PermissionRequest") && typeof payload.message === "string") {
    body.message = payload.message.slice(0, 200);
  }
  if (snapshot) {
    const resolved = resolveFromSnapshot(snapshot);
    if (resolved.agent_pid) body.agent_pid = resolved.agent_pid;
    if (resolved.terminal_pid) body.terminal_pid = resolved.terminal_pid;
    if (resolved.wt_hwnd) body.wt_hwnd = resolved.wt_hwnd;
  }

  await post(body);
  process.exit(0);
}

main();
