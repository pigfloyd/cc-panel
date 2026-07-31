// win32-snapshot.js — in-process process/window snapshot via koffi.
//
// Replaces the PowerShell + C# snapshot (Add-Type P/Invoke + Get-CimInstance +
// PEB reads) that was spawned fresh on every poll, which is the heaviest
// periodic cost in the app. On a typical poll this enumerates processes and
// windows and reads the PEB of a handful of candidate processes in a few
// milliseconds, all inside the main process.
//
// Returns null when koffi cannot load or the snapshot fails; callers fall back
// to the PowerShell implementation.

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;
const GA_ROOTOWNER = 3;
const TH32CS_SNAPPROCESS = 0x00000002;
const CLASS_NAME_BUF = 256;

// Offsets inside RTL_USER_PROCESS_PARAMETERS, 64-bit / 32-bit layouts.
const RTL_USER_PROCESS_PARAMETERS = {
  64: { processParameters: 0x20, currentDirectory: 0x38, commandLine: 0x70 },
  32: { processParameters: 0x10, currentDirectory: 0x24, commandLine: 0x40 },
};
// UNICODE_STRING: USHORT Length at 0, PVOID Buffer at 4 (32-bit) or 8 (64-bit).

// Processes whose PEB is read for cwd + command line. Matches the PowerShell
// snapshot's commandLine/cwd inclusion set.
const CANDIDATE_NAMES = new Set(["node.exe", "node", "codex.exe", "claude.exe", "claude-code.exe"]);

let api = null; // null = not loaded yet, false = failed to load, object = loaded

function loadApi() {
  if (api !== null) return api;
  if (process.platform !== "win32") {
    api = false;
    return null;
  }
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const ntdll = koffi.load("ntdll.dll");

    const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)");
    const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
      dwSize: "uint32_t",
      cntUsage: "uint32_t",
      th32ProcessID: "uint32_t",
      th32DefaultHeapID: "uintptr_t",
      th32ModuleID: "uint32_t",
      cntThreads: "uint32_t",
      th32ParentProcessID: "uint32_t",
      pcPriClassBase: "long",
      dwFlags: "uint32_t",
      szExeFile: "char16_t[260]",
    });

    api = {
      EnumWindows: user32.func("bool __stdcall EnumWindows(EnumWindowsProc *callback, intptr_t lParam)"),
      GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)"),
      IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(intptr_t hwnd)"),
      GetAncestor: user32.func("intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32_t flags)"),
      GetClassNameW: user32.func("int32_t __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *className, int32_t maxCount)"),
      CreateToolhelp32Snapshot: kernel32.func("intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)"),
      Process32FirstW: kernel32.func("bool __stdcall Process32FirstW(intptr_t snapshot, _Inout_ PROCESSENTRY32W *entry)"),
      Process32NextW: kernel32.func("bool __stdcall Process32NextW(intptr_t snapshot, _Inout_ PROCESSENTRY32W *entry)"),
      CloseHandle: kernel32.func("bool __stdcall CloseHandle(intptr_t handle)"),
      OpenProcess: kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, bool inheritHandle, uint32_t pid)"),
      ReadProcessMemory: kernel32.func("bool __stdcall ReadProcessMemory(intptr_t process, intptr_t address, _Out_ uint8_t *buffer, uintptr_t size, _Out_ uintptr_t *bytesRead)"),
      IsWow64Process: kernel32.func("bool __stdcall IsWow64Process(intptr_t process, _Out_ bool *wow64)"),
      NtQueryInformationProcess: ntdll.func("int32_t __stdcall NtQueryInformationProcess(intptr_t process, uint32_t infoClass, _Out_ uint8_t *info, uint32_t infoLength, _Out_ uint32_t *returnLength)"),
      entrySize: koffi.sizeof(PROCESSENTRY32W),
      hostIs64Bit: koffi.sizeof("intptr_t") === 8,
    };
  } catch (err) {
    console.error("[cc-panel] koffi process snapshot unavailable:", String(err.message || err));
    api = false;
    return null;
  }
  return api;
}

// Returns { processes, windows } shaped like the PowerShell snapshot, or null.
function snapshot() {
  const fns = loadApi();
  if (!fns) return null;
  try {
    const processes = enumerateProcesses(fns);
    for (const process of processes) {
      if (!CANDIDATE_NAMES.has(String(process.name).toLowerCase())) continue;
      try {
        Object.assign(process, readProcessStrings(fns, process.pid));
      } catch {
        // Leave cwd/commandLine null for this process; do not fail the poll.
      }
    }
    return { processes, windows: enumerateWindows(fns) };
  } catch (err) {
    console.error("[cc-panel] process snapshot failed:", compactError(err));
    return null;
  }
}

function enumerateProcesses(fns) {
  const processes = [];
  const handle = fns.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!handle || Number(handle) === -1) throw new Error("CreateToolhelp32Snapshot failed");
  try {
    const entry = { dwSize: fns.entrySize };
    for (let ok = fns.Process32FirstW(handle, entry); ok; ok = fns.Process32NextW(handle, entry)) {
      processes.push({
        pid: entry.th32ProcessID,
        ppid: entry.th32ParentProcessID,
        name: entry.szExeFile,
        commandLine: null,
        cwd: null,
      });
    }
  } finally {
    fns.CloseHandle(handle);
  }
  return processes;
}

function enumerateWindows(fns) {
  const windows = [];
  fns.EnumWindows((hwnd) => {
    if (!fns.IsWindowVisible(hwnd)) return true;
    const pidOut = [null];
    fns.GetWindowThreadProcessId(hwnd, pidOut);
    const pid = pidOut[0];
    if (!pid) return true;
    const classNameBuf = new Uint16Array(CLASS_NAME_BUF);
    const length = fns.GetClassNameW(hwnd, classNameBuf, classNameBuf.length);
    const rootOwner = fns.GetAncestor(hwnd, GA_ROOTOWNER);
    windows.push({
      hwnd: String(hwnd),
      pid,
      className: length > 0 ? utf16ArrayToString(classNameBuf, length) : "",
      rootOwnerHwnd: rootOwner ? String(rootOwner) : null,
    });
    return true;
  }, 0);
  return windows;
}

function readProcessStrings(fns, pid) {
  const handle = fns.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid);
  if (!handle) return { cwd: null, commandLine: null };
  try {
    const target = describeTarget(fns, handle);
    if (!target) return { cwd: null, commandLine: null };
    return {
      cwd: readUnicodeString(fns, handle, target, target.params + target.offsets.currentDirectory),
      commandLine: readUnicodeString(fns, handle, target, target.params + target.offsets.commandLine),
    };
  } finally {
    fns.CloseHandle(handle);
  }
}

// Resolve the target process's PEB and RTL_USER_PROCESS_PARAMETERS, honoring
// the WoW64 case (64-bit host, 32-bit target).
function describeTarget(fns, handle) {
  const hostIs64Bit = fns.hostIs64Bit;
  let is32Bit = !hostIs64Bit;
  let peb = null;

  if (hostIs64Bit) {
    const wow64Out = [null];
    if (!fns.IsWow64Process(handle, wow64Out)) return null;
    is32Bit = !!wow64Out[0];
    // ProcessBasicInformation (0) yields a 48-byte structure; the WoW64 PEB
    // (class 26) is returned directly as a pointer.
    const out = new Uint8Array(is32Bit ? 8 : 48);
    if (fns.NtQueryInformationProcess(handle, is32Bit ? 26 : 0, out, out.length, [null]) !== 0) return null;
    peb = is32Bit ? Number(readUInt64(out, 0)) : Number(readUInt64(out, 8));
  } else {
    // 32-bit host: 24-byte PROCESS_BASIC_INFORMATION with 4-byte pointers.
    const out = new Uint8Array(24);
    if (fns.NtQueryInformationProcess(handle, 0, out, out.length, [null]) !== 0) return null;
    peb = readUInt32(out, 4);
  }
  if (!peb) return null;

  const ptrSize = is32Bit ? 4 : 8;
  const params = readPointer(fns, handle, peb + RTL_USER_PROCESS_PARAMETERS[is32Bit ? 32 : 64].processParameters, ptrSize);
  if (!params) return null;
  return { is32Bit, ptrSize, params, offsets: RTL_USER_PROCESS_PARAMETERS[is32Bit ? 32 : 64] };
}

function readUnicodeString(fns, handle, target, structAddress) {
  const lengthBytes = read(fns, handle, structAddress, 2);
  if (!lengthBytes) return null;
  const length = readUInt16(lengthBytes, 0);
  if (length <= 0 || length > 65534 || (length & 1) !== 0) return null;

  const buffer = readPointer(fns, handle, structAddress + (target.is32Bit ? 4 : 8), target.ptrSize);
  if (!buffer) return null;
  const bytes = read(fns, handle, buffer, length);
  return bytes ? utf16BytesToString(bytes) : null;
}

function readPointer(fns, handle, address, ptrSize) {
  const bytes = read(fns, handle, address, ptrSize);
  if (!bytes) return null;
  return ptrSize === 8 ? Number(readUInt64(bytes, 0)) : readUInt32(bytes, 0);
}

function read(fns, handle, address, size) {
  const buffer = new Uint8Array(size);
  const readOut = [null];
  const ok = fns.ReadProcessMemory(handle, address, buffer, buffer.length, readOut);
  if (!ok || Number(readOut[0]) !== size) return null;
  return buffer;
}

function utf16BytesToString(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return out;
}

function utf16ArrayToString(array, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(array[i]);
  return out;
}

function readUInt16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readUInt64(bytes, offset) {
  const lo = readUInt32(bytes, offset);
  const hi = readUInt32(bytes, offset + 4);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

function compactError(value) {
  return String(value && value.message || value || "unknown error").replace(/\s+/g, " ").trim().slice(0, 500);
}

module.exports = { snapshot, utf16BytesToString, utf16ArrayToString };
