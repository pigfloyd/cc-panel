// Detect agent CLIs that were already running before cc-panel was opened.
const { execFile } = require("child_process");

const SHELL_NAMES = new Set(["cmd.exe", "powershell.exe", "pwsh.exe"]);
const WINDOWS_TERMINAL_NAMES = new Set(["windowsterminal.exe", "windowsterminalpreview.exe"]);
const WINDOWS_TERMINAL_CLASS = "cascadia_hosting_window_class";
const CLASSIC_CONSOLE_CLASS = "consolewindowclass";
const PSEUDO_CONSOLE_CLASS = "pseudoconsolewindow";
const NODE_NAMES = new Set(["node.exe", "node"]);
const CLAUDE_NODE_CLI = /[\\\\/]node_modules[\\\\/]@anthropic-ai[\\\\/]claude-code[\\\\/]/i;
const CODEX_NODE_CLI = /[\\\\/]node_modules[\\\\/]@openai[\\\\/]codex[\\\\/]/i;

function agentClient(process) {
  const name = String(process.name || "").toLowerCase();
  const commandLine = String(process.commandLine || "");
  if (name === "claude.exe" || name === "claude-code.exe") return "claude";
  if (name === "codex.exe") return "codex";
  if (!NODE_NAMES.has(name)) return null;
  if (CLAUDE_NODE_CLI.test(commandLine)) return "claude";
  if (CODEX_NODE_CLI.test(commandLine)) return "codex";
  return null;
}

function capturedSessions(processes, windows, now = Date.now()) {
  const byPid = new Map(processes.map((p) => [Number(p.pid), p]));
  const hwndByPid = new Map();
  const terminalHandles = new Set();
  for (const window of windows) {
    const pid = Number(window.pid);
    if (!isTerminalWindow(window, byPid.get(pid))) continue;
    terminalHandles.add(String(window.hwnd));
    if (hwndByPid.has(pid)) continue;
    // EnumWindows returns top-level windows in Z order. Windows Terminal uses
    // one process for multiple windows. This remains a fallback for terminals
    // whose shell does not expose a PseudoConsoleWindow relationship.
    hwndByPid.set(pid, String(window.hwnd));
  }
  for (const window of windows) {
    const className = String(window.className || "").toLowerCase();
    const rootOwnerHwnd = String(window.rootOwnerHwnd || "");
    if (className !== PSEUDO_CONSOLE_CLASS || !terminalHandles.has(rootOwnerHwnd)) continue;
    // A Windows Terminal tab's PseudoConsoleWindow belongs to the shell
    // process, while its GA_ROOTOWNER is the exact visible Terminal window.
    hwndByPid.set(Number(window.pid), rootOwnerHwnd);
  }
  const candidates = processes
    .map((process) => ({ process, client: agentClient(process) }))
    .filter((candidate) => candidate.client);
  const candidateByPid = new Map(candidates.map((candidate) => [Number(candidate.process.pid), candidate]));
  const sessions = [];

  for (const { process, client } of candidates) {
    // npm shims commonly form node.exe -> codex.exe/claude.exe. Keep the
    // innermost agent process so one CLI becomes one panel card.
    if (hasMatchingDescendant(process.pid, client, processes, candidateByPid)) continue;

    let current = process;
    let terminalPid = null;
    let hwnd = null;
    const seen = new Set();
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      const name = String(current.name || "").toLowerCase();
      if (!terminalPid && SHELL_NAMES.has(name)) terminalPid = current.pid;
      if (!hwnd && hwndByPid.has(current.pid)) hwnd = hwndByPid.get(current.pid);
      current = byPid.get(Number(current.ppid));
    }

    // The Codex desktop app also launches Node runtimes. Only surface agents
    // that actually belong to an interactive terminal process/window.
    if (!terminalPid && !hwnd) continue;

    sessions.push({
      session_id: `captured:${client}:${process.pid}`,
      event: "SessionStart",
      client,
      agent_pid: process.pid,
      terminal_pid: terminalPid,
      wt_hwnd: hwnd,
      cwd: "",
      ts: now,
      captured: true,
    });
  }
  return sessions;
}

function isTerminalWindow(window, process) {
  const className = String(window.className || "").toLowerCase();
  const processName = String(process && process.name || "").toLowerCase();

  // Keep compatibility with snapshots produced before class names were added.
  if (!className) return true;
  if (className === WINDOWS_TERMINAL_CLASS) return WINDOWS_TERMINAL_NAMES.has(processName);
  if (className === CLASSIC_CONSOLE_CLASS) return SHELL_NAMES.has(processName);
  return false;
}

function hasMatchingDescendant(pid, client, processes, candidateByPid) {
  const pending = [Number(pid)];
  const seen = new Set(pending);
  while (pending.length) {
    const parentPid = pending.pop();
    for (const child of processes) {
      if (Number(child.ppid) !== parentPid) continue;
      const childPid = Number(child.pid);
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      const candidate = candidateByPid.get(childPid);
      if (candidate && candidate.client === client) return true;
      pending.push(childPid);
    }
  }
  return false;
}

const SNAPSHOT_SCRIPT = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CcPanelStartupCapture {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
}
"@
$windows = New-Object System.Collections.ArrayList
$callback = [CcPanelStartupCapture+EnumWindowsProc]{ param($hwnd, $lParam)
  if ([CcPanelStartupCapture]::IsWindowVisible($hwnd)) {
    [uint32]$windowProcessId = 0
    [void][CcPanelStartupCapture]::GetWindowThreadProcessId($hwnd, [ref]$windowProcessId)
    if ($windowProcessId) {
      $className = New-Object System.Text.StringBuilder 256
      [void][CcPanelStartupCapture]::GetClassName($hwnd, $className, $className.Capacity)
      $rootOwner = [CcPanelStartupCapture]::GetAncestor($hwnd, 3)
      [void]$windows.Add([pscustomobject]@{
        hwnd = $hwnd.ToInt64().ToString()
        pid = $windowProcessId
        className = $className.ToString()
        rootOwnerHwnd = if ($rootOwner -eq [IntPtr]::Zero) { $null } else { $rootOwner.ToInt64().ToString() }
      })
    }
  }
  return $true
}
[void][CcPanelStartupCapture]::EnumWindows($callback, [IntPtr]::Zero)
[pscustomobject]@{
  processes = [object[]]@(Get-CimInstance Win32_Process | ForEach-Object {
    $includeCommandLine = $_.Name -ieq 'node.exe' -or $_.Name -ieq 'node' -or
      $_.Name -ieq 'codex.exe' -or $_.Name -ieq 'claude.exe' -or $_.Name -ieq 'claude-code.exe'
    [pscustomobject]@{
      pid = $_.ProcessId
      ppid = $_.ParentProcessId
      name = $_.Name
      commandLine = if ($includeCommandLine) { $_.CommandLine } else { $null }
    }
  })
  windows = [object[]]$windows
} | ConvertTo-Json -Compress -Depth 3
`;

function captureRunningSessions(store) {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SNAPSHOT_SCRIPT], {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error || !stdout) {
        const detail = error && (error.stderr || error.message);
        console.error("[cc-panel] startup capture failed:", compactError(detail || "empty snapshot"));
        return resolve([]);
      }
      try {
        const snapshot = JSON.parse(stdout);
        const sessions = capturedSessions(snapshot.processes || [], snapshot.windows || []);
        for (const session of sessions) store.handleEvent(session);
        resolve(sessions);
      } catch (error) {
        console.error("[cc-panel] startup capture parse failed:", compactError(error.message));
        resolve([]);
      }
    });
  });
}

function compactError(value) {
  return String(value || "unknown error").replace(/\s+/g, " ").trim().slice(0, 500);
}

module.exports = { agentClient, capturedSessions, captureRunningSessions };
