// win32.js — window focus/move via koffi FFI, with a PowerShell fallback when
// koffi cannot load (e.g. ABI mismatch). All HWNDs travel as decimal strings.
const { execFile } = require("child_process");

let user32 = null;
let fns = null;

const SW_RESTORE = 9;
const SW_MINIMIZE = 6;
const SWP_NOSIZE = 0x0001;
const SWP_SHOWWINDOW = 0x0040;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;

try {
  const koffi = require("koffi");
  user32 = koffi.load("user32.dll");
  const RECT = koffi.struct("RECT", { left: "long", top: "long", right: "long", bottom: "long" });
  fns = {
    IsWindow: user32.func("bool __stdcall IsWindow(int64_t hWnd)"),
    IsIconic: user32.func("bool __stdcall IsIconic(int64_t hWnd)"),
    ShowWindow: user32.func("bool __stdcall ShowWindow(int64_t hWnd, int nCmdShow)"),
    SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(int64_t hWnd)"),
    SetWindowPos: user32.func("bool __stdcall SetWindowPos(int64_t hWnd, int64_t hWndAfter, int x, int y, int cx, int cy, uint32_t flags)"),
    GetWindowRect: user32.func("bool __stdcall GetWindowRect(int64_t hWnd, _Out_ RECT *rect)"),
    keybd_event: user32.func("void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)"),
  };
} catch (err) {
  console.error("[cc-panel] koffi unavailable, falling back to PowerShell:", err.message);
}

function available() {
  return !!fns;
}

function isWindowAlive(hwndStr) {
  if (!fns || !hwndStr) return null; // unknown
  try {
    return !!fns.IsWindow(Number(hwndStr));
  } catch {
    return null;
  }
}

// Move the window to the center of `workArea` (Electron primary display work
// area) keeping its size, then bring it to the foreground. Returns
// {ok, reason?}.
function focusWindow(hwndStr, workArea) {
  if (!hwndStr) return { ok: false, reason: "no_hwnd" };
  if (fns) return focusWithKoffi(Number(hwndStr), workArea);
  return focusWithPowerShell(hwndStr, workArea);
}

function minimizeWindow(hwndStr) {
  if (!hwndStr) return { ok: false, reason: "no_hwnd" };
  if (fns) {
    const hwnd = Number(hwndStr);
    if (!fns.IsWindow(hwnd)) return { ok: false, reason: "gone" };
    fns.ShowWindow(hwnd, SW_MINIMIZE);
    return { ok: true };
  }
  return minimizeWithPowerShell(hwndStr);
}

function focusWithKoffi(hwnd, workArea) {
  if (!fns.IsWindow(hwnd)) return { ok: false, reason: "gone" };
  if (fns.IsIconic(hwnd)) fns.ShowWindow(hwnd, SW_RESTORE);

  const rect = {};
  let w = 1200, h = 800;
  if (fns.GetWindowRect(hwnd, rect)) {
    w = rect.right - rect.left;
    h = rect.bottom - rect.top;
  }
  w = Math.min(w, workArea.width);
  h = Math.min(h, workArea.height);
  const x = Math.round(workArea.x + (workArea.width - w) / 2);
  const y = Math.round(workArea.y + (workArea.height - h) / 2);
  fns.SetWindowPos(hwnd, 0 /* HWND_TOP */, x, y, 0, 0, SWP_NOSIZE | SWP_SHOWWINDOW);

  if (!fns.SetForegroundWindow(hwnd)) {
    // Foreground-lock workaround: a synthetic ALT press makes Windows treat
    // this process as "receiving input" so the focus handoff is permitted.
    fns.keybd_event(VK_MENU, 0, 0, 0);
    fns.SetForegroundWindow(hwnd);
    fns.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  }
  return { ok: true };
}

const PS_FOCUS_TEMPLATE = `
$typeDef = @"
using System;
using System.Runtime.InteropServices;
public class TpanelFocus {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
Add-Type -TypeDefinition $typeDef
$h = [IntPtr]::new(__HWND__)
if (-not [TpanelFocus]::IsWindow($h)) { "gone"; exit }
if ([TpanelFocus]::IsIconic($h)) { [void][TpanelFocus]::ShowWindow($h, 9) }
$r = New-Object TpanelFocus+RECT
[void][TpanelFocus]::GetWindowRect($h, [ref]$r)
$w = [Math]::Min($r.R - $r.L, __WAW__); $hh = [Math]::Min($r.B - $r.T, __WAH__)
$x = __WAX__ + [int](( __WAW__ - $w) / 2); $y = __WAY__ + [int](( __WAH__ - $hh) / 2)
[void][TpanelFocus]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, 0, 0, 0x41)
[void][TpanelFocus]::SetForegroundWindow($h)
"ok"
`;

function focusWithPowerShell(hwndStr, workArea) {
  const script = PS_FOCUS_TEMPLATE
    .replace(/__HWND__/g, String(Number(hwndStr)))
    .replace(/__WAX__/g, String(workArea.x))
    .replace(/__WAY__/g, String(workArea.y))
    .replace(/__WAW__/g, String(workArea.width))
    .replace(/__WAH__/g, String(workArea.height));
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 5000, windowsHide: true },
    () => {}
  );
  return { ok: true, reason: "ps_async" };
}

function minimizeWithPowerShell(hwndStr) {
  const hwnd = String(Number(hwndStr));
  const script = `
$typeDef = @"
using System;
using System.Runtime.InteropServices;
public class TpanelMinimize {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
Add-Type -TypeDefinition $typeDef
$h = [IntPtr]::new(${hwnd})
if (-not [TpanelMinimize]::IsWindow($h)) { "gone"; exit }
[void][TpanelMinimize]::ShowWindow($h, 6)
"ok"
`;
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 5000, windowsHide: true },
    () => {}
  );
  return { ok: true, reason: "ps_async" };
}

module.exports = { available, isWindowAlive, focusWindow, minimizeWindow };
