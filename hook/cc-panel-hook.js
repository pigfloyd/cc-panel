#!/usr/bin/env node
// cc-panel hook — invoked by Claude Code hooks: node cc-panel-hook.js <EventName>
// Zero third-party dependencies. Reads hook JSON from stdin, resolves the
// Windows Terminal window (HWND) hosting this session, and POSTs state to the
// cc-panel panel over localhost. Silently exits if the panel is not running.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync, execFile } = require("child_process");

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
const RUNTIME_PATH = path.join(os.homedir(), ".just-agent-deck", "runtime.json");
const POST_TIMEOUT_MS = 100;
const STDIN_TIMEOUT_MS = 400;

const WT_WINDOW_CLASS = "cascadia_hosting_window_class";
const CONSOLE_WINDOW_CLASS = "consolewindowclass";
const WT_PROCESS_NAMES = new Set(["windowsterminal.exe", "windowsterminalpreview.exe"]);
const TERMINAL_NAMES = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "conhost.exe", "openconsole.exe", "code.exe", "alacritty.exe",
  "wezterm-gui.exe", "tabby.exe", "warp.exe", "ghostty.exe",
]);
const SYSTEM_BOUNDARY = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);

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
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
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
$windows = New-Object System.Collections.ArrayList
$callback = [CcPanelWin32+EnumWindowsProc]{ param($hwnd, $lParam)
  if ([CcPanelWin32]::IsWindowVisible($hwnd)) {
    [uint32]$windowPid = 0
    [void][CcPanelWin32]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
    $windowClass = New-Object System.Text.StringBuilder 256
    [void][CcPanelWin32]::GetClassName($hwnd, $windowClass, $windowClass.Capacity)
    $rootOwner = [CcPanelWin32]::GetAncestor($hwnd, 3)
    [void]$windows.Add([pscustomobject]@{
      hwnd = $hwnd.ToInt64().ToString()
      pid = $windowPid
      className = $windowClass.ToString()
      rootOwnerHwnd = if ($rootOwner -eq [IntPtr]::Zero) { $null } else { $rootOwner.ToInt64().ToString() }
    })
  }
  return $true
}
[void][CcPanelWin32]::EnumWindows($callback, [IntPtr]::Zero)
[pscustomobject]@{
  processes = $processes
  windows = [object[]]$windows
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
    const windows = Array.isArray(parsed.windows) ? parsed.windows : (parsed.windows ? [parsed.windows] : []);
    return { procs, windows, foreground: parsed.foreground || null };
  } catch {
    return null;
  }
}

function getSnapshotAsync() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_SNAPSHOT_SCRIPT],
      { encoding: "utf8", timeout: 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => {
        if (err) { resolve(null); return; }
        try {
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
          const windows = Array.isArray(parsed.windows) ? parsed.windows : (parsed.windows ? [parsed.windows] : []);
          resolve({ procs, windows, foreground: parsed.foreground || null });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Walk up from our parent to find the agent process and hosting terminal. The
// foreground window is accepted only when it belongs to Windows Terminal or a
// classic PowerShell/cmd console. The user just typed here, so at
// SessionStart/UserPromptSubmit time that inference is sound.
function resolveFromSnapshot(snapshot) {
  const result = { agent_pid: null, terminal_pid: null, wt_hwnd: null, window_mapping: null };
  if (!snapshot) return result;

  let pid = process.ppid;
  let foundAgent = false;
  for (let i = 0; i < 10; i++) {
    const info = snapshot.procs.get(pid);
    if (!info) break;
    if (!result.agent_pid) {
      if (info.name === "claude.exe" || info.name === "codex.exe") {
        result.agent_pid = pid;
        foundAgent = true;
      } else if (info.name === "node.exe" &&
                 (info.commandLine.includes("claude-code") ||
                  info.commandLine.includes("@anthropic-ai") ||
                  /\bcodex\b/i.test(info.commandLine))) {
        result.agent_pid = pid;
        foundAgent = true;
      }
    }
    if (SYSTEM_BOUNDARY.has(info.name)) break;
    // Hook commands themselves run inside a short-lived PowerShell process.
    // Only shells above the agent are hosting terminals; shells below it are
    // hook runners and must not replace the stable startup-capture mapping.
    if (foundAgent && pid !== result.agent_pid &&
        !result.terminal_pid && TERMINAL_NAMES.has(info.name)) {
      result.terminal_pid = pid;
    }
    if (!info.ppid || info.ppid === pid) break;
    pid = info.ppid;
  }

  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (result.terminal_pid) {
    const terminalWindows = new Set(windows.filter((window) => {
      const cls = String(window.className || "").toLowerCase();
      const proc = snapshot.procs.get(Number(window.pid));
      return cls === WT_WINDOW_CLASS && proc && WT_PROCESS_NAMES.has(proc.name);
    }).map((window) => String(window.hwnd)));
    const exact = windows.find((window) => {
      const cls = String(window.className || "").toLowerCase();
      if (Number(window.pid) !== Number(result.terminal_pid)) return false;
      if (cls === CONSOLE_WINDOW_CLASS) return true;
      return cls === "pseudoconsolewindow" && terminalWindows.has(String(window.rootOwnerHwnd || ""));
    });
    if (exact) {
      result.wt_hwnd = String(exact.rootOwnerHwnd || exact.hwnd);
      result.window_mapping = "exact";
    }
  }

  const fg = snapshot.foreground;
  if (!result.wt_hwnd && fg && fg.hwnd && /^[1-9]\d{0,18}$/.test(String(fg.hwnd))) {
    const fgProc = snapshot.procs.get(Number(fg.pid));
    const cls = String(fg.className || "").toLowerCase();
    const isWindowsTerminal = cls === WT_WINDOW_CLASS && fgProc && WT_PROCESS_NAMES.has(fgProc.name);
    const isClassicConsole = cls === CONSOLE_WINDOW_CLASS && fgProc && TERMINAL_NAMES.has(fgProc.name);
    if (isWindowsTerminal || isClassicConsole) {
      result.wt_hwnd = String(fg.hwnd);
      result.window_mapping = "foreground";
    }
  }
  return result;
}

function codexSessionIdFromTranscriptPath(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return null;
  const fileName = path.basename(transcriptPath.replace(/\\/g, "/"));
  const match = fileName.match(
    /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i
  );
  return match ? match[1] : null;
}

function sessionIdFromPayload(payload, source) {
  // Codex hook payloads can carry different session IDs for one rollout.
  // The transcript filename UUID is stable across the lifecycle events.
  if (source === "codex") {
    const transcriptId = codexSessionIdFromTranscriptPath(
      payload.transcript_path || payload.transcriptPath
    );
    if (transcriptId) return `codex:${transcriptId}`;
  }

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
    if (typeof value === "string" && value.trim()) {
      const id = value.trim();
      return source === "codex" && !id.startsWith("codex:") ? `codex:${id}` : id;
    }
  }
  if (payload.transcript_path || payload.transcriptPath) {
    const id = String(payload.transcript_path || payload.transcriptPath);
    return source === "codex" ? `codex:${id}` : id;
  }
  return `${source === "codex" ? "codex:" : ""}session:${process.pid}:${process.cwd()}`;
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

function notificationTypeFromPayload(payload) {
  const value = payload.notification_type || payload.notificationType;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function runtimePort() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
    const port = Number(raw && raw.port);
    return PORTS.includes(port) ? port : null;
  } catch {
    return null;
  }
}

function requestOnce(port, options) {
  return new Promise((resolve) => {
    const body = options.body || "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method || "GET",
        headers: body ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        } : undefined,
        timeout: options.timeoutMs || POST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300 && res.headers["x-just-agent-deck"] === "1",
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
        }));
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    req.on("error", () => resolve({ ok: false }));
    req.end(body);
  });
}

function postOnce(port, body) {
  return requestOnce(port, { method: "POST", path: "/event", body })
    .then((result) => result.ok);
}

async function post(bodyObj) {
  const body = JSON.stringify(bodyObj);
  for (const port of candidatePorts()) {
    if (await postOnce(port, body)) return;
  }
}

async function main() {
  const event = process.argv[2];
  const source = process.argv[3] || "unknown";
  if (!EVENTS.has(event)) process.exit(0);
  // Async hooks can finish out of order, especially UserPromptSubmit because
  // it also waits for the process/window snapshot. Timestamp the lifecycle
  // event before doing any asynchronous work so SessionStore can reject a
  // delayed event that belongs before a newer Stop or tool event.
  const eventTs = Date.now();

  // Run snapshot and stdin read in parallel so their costs overlap.
  const [snapshot, payload] = await Promise.all([
    SNAPSHOT_EVENTS.has(event) ? getSnapshotAsync() : Promise.resolve(null),
    readStdinJson(),
  ]);

  const body = {
    v: 1,
    event,
    ts: eventTs,
    client: source,
    session_id: sessionIdFromPayload(payload, source),
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
  if ((event === "Notification" || event === "PermissionRequest") && typeof payload.message === "string") {
    body.message = payload.message.slice(0, 200);
  }
  if (event === "Notification") {
    const notificationType = notificationTypeFromPayload(payload);
    if (notificationType) body.notification_type = notificationType;
  }
  if (snapshot) {
    const resolved = resolveFromSnapshot(snapshot);
    if (resolved.agent_pid) body.agent_pid = resolved.agent_pid;
    if (resolved.terminal_pid) body.terminal_pid = resolved.terminal_pid;
    if (resolved.wt_hwnd) body.wt_hwnd = resolved.wt_hwnd;
    if (resolved.window_mapping) body.window_mapping = resolved.window_mapping;
  }

  await post(body);
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}

module.exports = {
  codexSessionIdFromTranscriptPath,
  notificationTypeFromPayload,
  resolveFromSnapshot,
  sessionIdFromPayload,
};
