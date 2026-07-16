const test = require("node:test");
const assert = require("node:assert/strict");
const { capturedSessions } = require("../src/main/startup-capture");

test("captures running Claude and Codex CLIs with their terminal mapping", () => {
  const sessions = capturedSessions([
    { pid: 9, ppid: 20, name: "node.exe", commandLine: "node C:\\node_modules\\@openai\\codex\\bin\\codex.js" },
    { pid: 10, ppid: 9, name: "codex.exe", commandLine: "codex" },
    { pid: 20, ppid: 30, name: "cmd.exe", commandLine: "cmd.exe" },
    { pid: 30, ppid: 0, name: "WindowsTerminal.exe", commandLine: "wt.exe" },
    { pid: 40, ppid: 50, name: "node.exe", commandLine: "node C:\\Users\\me\\node_modules\\@anthropic-ai\\claude-code\\cli.js" },
    { pid: 50, ppid: 0, name: "powershell.exe", commandLine: "powershell" },
  ], [{ pid: 30, hwnd: "101" }], 123);

  assert.deepEqual(sessions, [
    { session_id: "captured:codex:10", event: "SessionStart", client: "codex", agent_pid: 10, terminal_pid: 20, wt_hwnd: "101", cwd: "", ts: 123, captured: true },
    { session_id: "captured:claude:40", event: "SessionStart", client: "claude", agent_pid: 40, terminal_pid: 50, wt_hwnd: null, cwd: "", ts: 123, captured: true },
  ]);
});

test("does not treat shell command lines as agent processes", () => {
  const sessions = capturedSessions([
    { pid: 1, ppid: 0, name: "powershell.exe", commandLine: "powershell -Command codex" },
    { pid: 2, ppid: 0, name: "cmd.exe", commandLine: "cmd /k claude" },
  ], [], 123);

  assert.deepEqual(sessions, []);
});

test("does not capture Codex desktop background runtimes", () => {
  const sessions = capturedSessions([
    { pid: 1, ppid: 2, name: "node.exe", commandLine: "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\bin\\node.exe kernel.js" },
    { pid: 2, ppid: 0, name: "codex-command-runner.exe", commandLine: "codex-command-runner.exe" },
  ], [], 123);

  assert.deepEqual(sessions, []);
});

test("maps each pseudo console to its own Windows Terminal window", () => {
  const sessions = capturedSessions([
    { pid: 10, ppid: 20, name: "codex.exe", commandLine: "codex" },
    { pid: 11, ppid: 21, name: "codex.exe", commandLine: "codex" },
    { pid: 20, ppid: 30, name: "cmd.exe", commandLine: "cmd.exe /k codex" },
    { pid: 21, ppid: 30, name: "cmd.exe", commandLine: "cmd.exe /k codex" },
    { pid: 30, ppid: 0, name: "WindowsTerminal.exe", commandLine: "wt.exe" },
  ], [
    { pid: 20, hwnd: "101", className: "PseudoConsoleWindow", rootOwnerHwnd: "202" },
    { pid: 30, hwnd: "202", className: "CASCADIA_HOSTING_WINDOW_CLASS" },
    { pid: 21, hwnd: "102", className: "PseudoConsoleWindow", rootOwnerHwnd: "303" },
    { pid: 30, hwnd: "303", className: "CASCADIA_HOSTING_WINDOW_CLASS" },
  ], 123);

  assert.deepEqual(sessions.map((session) => session.wt_hwnd), ["202", "303"]);
});
