const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveFromSnapshot } = require("../hook/cc-panel-hook");

for (const [name, terminalPid] of [["powershell.exe", 900_001], ["cmd.exe", 900_002]]) {
  test(`maps a ${name} console window and terminal process`, () => {
    const snapshot = {
      procs: new Map([
        [process.ppid, { name: "codex.exe", ppid: terminalPid, commandLine: "codex" }],
        [terminalPid, { name, ppid: 0, commandLine: name }],
      ]),
      foreground: {
        hwnd: String(800_000 + terminalPid),
        pid: terminalPid,
        className: "ConsoleWindowClass",
      },
    };

    assert.deepEqual(resolveFromSnapshot(snapshot), {
      agent_pid: process.ppid,
      terminal_pid: terminalPid,
      wt_hwnd: String(800_000 + terminalPid),
    });
  });
}

test("tracks the nearest terminal when shells are nested", () => {
  const cmdPid = 900_010;
  const powershellPid = 900_011;
  const snapshot = {
    procs: new Map([
      [process.ppid, { name: "codex.exe", ppid: cmdPid, commandLine: "codex" }],
      [cmdPid, { name: "cmd.exe", ppid: powershellPid, commandLine: "cmd.exe" }],
      [powershellPid, { name: "powershell.exe", ppid: 0, commandLine: "powershell.exe" }],
    ]),
    foreground: null,
  };

  assert.equal(resolveFromSnapshot(snapshot).terminal_pid, cmdPid);
});
