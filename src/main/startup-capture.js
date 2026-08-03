// Detect agent CLIs that were already running before just-agent-deck was opened.
const { execFile } = require("child_process");
const win32Snapshot = require("./win32-snapshot");

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
  const exactHwndPids = new Set();
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
    exactHwndPids.add(Number(window.pid));
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
      window_mapping: hwnd ? (exactHwndPids.has(Number(terminalPid)) ? "exact" : "fallback") : null,
      cwd: process.cwd || "",
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

// Fallback snapshotter, used only when the in-process koffi snapshot
// (win32-snapshot.js) is unavailable.
const SNAPSHOT_SCRIPT = `
# PowerShell 5 uses the active console code page for redirected stdout. The
# caller decodes stdout as UTF-8, so make the encoding explicit before emitting
# JSON (otherwise Chinese working-directory names become mojibake).
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CcPanelStartupCapture {
  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder title, int maxCount);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr bytesRead);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsWow64Process(IntPtr process, out bool wow64Process);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(
    IntPtr process, int informationClass, ref PROCESS_BASIC_INFORMATION information,
    int informationLength, out int returnLength);
  [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")]
  private static extern int NtQueryWow64Information(
    IntPtr process, int informationClass, out IntPtr information,
    int informationLength, out int returnLength);

  public static string GetProcessCurrentDirectory(uint processId) {
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint PROCESS_VM_READ = 0x0010;
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, processId);
    if (process == IntPtr.Zero) return null;

    try {
      bool target32Bit = IntPtr.Size == 4;
      IntPtr pebAddress;

      if (IntPtr.Size == 8) {
        bool wow64;
        if (!IsWow64Process(process, out wow64)) return null;
        target32Bit = wow64;
        if (wow64) {
          int returned;
          if (NtQueryWow64Information(process, 26, out pebAddress, IntPtr.Size, out returned) != 0 ||
              pebAddress == IntPtr.Zero) return null;
        } else {
          PROCESS_BASIC_INFORMATION basic = new PROCESS_BASIC_INFORMATION();
          int returned;
          if (NtQueryInformationProcess(process, 0, ref basic, Marshal.SizeOf(basic), out returned) != 0)
            return null;
          pebAddress = basic.PebBaseAddress;
        }
      } else {
        PROCESS_BASIC_INFORMATION basic = new PROCESS_BASIC_INFORMATION();
        int returned;
        if (NtQueryInformationProcess(process, 0, ref basic, Marshal.SizeOf(basic), out returned) != 0)
          return null;
        pebAddress = basic.PebBaseAddress;
      }

      int processParametersOffset = target32Bit ? 0x10 : 0x20;
      IntPtr processParameters = ReadPointer(process, Add(pebAddress, processParametersOffset), target32Bit);
      if (processParameters == IntPtr.Zero) return null;

      int currentDirectoryOffset = target32Bit ? 0x24 : 0x38;
      IntPtr directoryString = Add(processParameters, currentDirectoryOffset);
      byte[] lengthBytes = Read(process, directoryString, 2);
      if (lengthBytes == null) return null;
      int length = BitConverter.ToUInt16(lengthBytes, 0);
      if (length <= 0 || length > 65534 || (length & 1) != 0) return null;

      IntPtr buffer = ReadPointer(process, Add(directoryString, target32Bit ? 4 : 8), target32Bit);
      if (buffer == IntPtr.Zero) return null;
      byte[] directoryBytes = Read(process, buffer, length);
      return directoryBytes == null ? null : Encoding.Unicode.GetString(directoryBytes);
    } catch {
      return null;
    } finally {
      CloseHandle(process);
    }
  }

  private static IntPtr Add(IntPtr address, int offset) {
    return new IntPtr(address.ToInt64() + offset);
  }

  private static byte[] Read(IntPtr process, IntPtr address, int size) {
    byte[] buffer = new byte[size];
    IntPtr bytesRead;
    if (!ReadProcessMemory(process, address, buffer, size, out bytesRead) || bytesRead.ToInt64() != size)
      return null;
    return buffer;
  }

  private static IntPtr ReadPointer(IntPtr process, IntPtr address, bool target32Bit) {
    byte[] bytes = Read(process, address, target32Bit ? 4 : 8);
    if (bytes == null) return IntPtr.Zero;
    return target32Bit
      ? new IntPtr(unchecked((long)BitConverter.ToUInt32(bytes, 0)))
      : new IntPtr(BitConverter.ToInt64(bytes, 0));
  }
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
      $title = New-Object System.Text.StringBuilder 1024
      [void][CcPanelStartupCapture]::GetWindowText($hwnd, $title, $title.Capacity)
      $rootOwner = [CcPanelStartupCapture]::GetAncestor($hwnd, 3)
      [void]$windows.Add([pscustomobject]@{
        hwnd = $hwnd.ToInt64().ToString()
        pid = $windowProcessId
        className = $className.ToString()
        title = $title.ToString()
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
      cwd = if ($includeCommandLine) {
        [CcPanelStartupCapture]::GetProcessCurrentDirectory([uint32]$_.ProcessId)
      } else { $null }
    }
  })
  windows = [object[]]$windows
} | ConvertTo-Json -Compress -Depth 3
`;

function captureRunningSessions(store, onSnapshot = null) {
  if (process.platform !== "win32") return Promise.resolve([]);

  // Preferred path: koffi snapshot runs in-process (a few ms per poll instead
  // of spawning PowerShell, recompiling the C# P/Invoke and querying WMI).
  const snapshot = win32Snapshot.snapshot();
  if (snapshot) {
    try {
      publishSnapshot(onSnapshot, snapshot);
      const sessions = capturedSessions(snapshot.processes, snapshot.windows);
      for (const session of sessions) store.handleEvent(session);
      return Promise.resolve(sessions);
    } catch (error) {
      console.error("[cc-panel] startup capture failed:", compactError(error.message));
      return Promise.resolve([]);
    }
  }
  return captureWithPowerShell(store, onSnapshot);
}

function captureWithPowerShell(store, onSnapshot) {
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
        publishSnapshot(onSnapshot, snapshot);
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

function publishSnapshot(callback, snapshot) {
  if (typeof callback !== "function") return;
  try {
    callback(snapshot);
  } catch (error) {
    console.error("[cc-panel] snapshot observer failed:", compactError(error.message));
  }
}

function compactError(value) {
  return String(value || "unknown error").replace(/\s+/g, " ").trim().slice(0, 500);
}

module.exports = { agentClient, capturedSessions, captureRunningSessions };
