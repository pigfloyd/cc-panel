const test = require("node:test");
const assert = require("node:assert/strict");

const { detectTerminalApps } = require("../src/main/terminal-detector");

test("detects supported Windows terminals in a stable order", () => {
  const existing = new Set([
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
    "D:\\bin\\pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\System32\\cmd.exe",
  ].map((value) => value.toLowerCase()));
  const terminals = detectTerminalApps({
    platform: "win32",
    env: {
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      Path: "D:\\bin;C:\\Windows\\System32",
    },
    fileExists: (file) => existing.has(file.toLowerCase()),
  });

  assert.deepEqual(terminals, [
    {
      id: "windows-terminal",
      name: "Windows Terminal",
      executable: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
    },
    { id: "powershell-7", name: "PowerShell 7", executable: "D:\\bin\\pwsh.exe" },
    {
      id: "windows-powershell",
      name: "Windows PowerShell",
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    },
    {
      id: "command-prompt",
      name: "命令提示符",
      executable: "C:\\Windows\\System32\\cmd.exe",
    },
  ]);
});

test("returns no terminal apps outside Windows", () => {
  assert.deepEqual(detectTerminalApps({ platform: "linux" }), []);
});

test("omits executables that do not exist", () => {
  assert.deepEqual(detectTerminalApps({
    platform: "win32",
    env: {},
    fileExists: () => false,
  }), []);
});
