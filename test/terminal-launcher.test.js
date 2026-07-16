const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeTerminalExecutable,
  buildLaunchSpec,
} = require("../src/main/terminal-launcher");

test("normalizes the selected terminal executable", () => {
  assert.equal(normalizeTerminalExecutable(" C:\\Tools\\terminal.exe "), "C:\\Tools\\terminal.exe");
  assert.equal(normalizeTerminalExecutable(""), null);
  assert.equal(normalizeTerminalExecutable(undefined), null);
});

test("uses Windows Terminal when no executable has been selected", () => {
  assert.deepEqual(buildLaunchSpec(null, "C:\\work", "claude"), {
    executable: "wt.exe",
    args: ["new-tab", "-d", "C:\\work", "cmd.exe", "/d", "/k", "claude"],
    cwd: "C:\\work",
  });
});

test("builds launches for standalone Windows shells", () => {
  assert.deepEqual(buildLaunchSpec("C:\\Apps\\pwsh.exe", "C:\\repo", "codex"), {
    executable: "C:\\Apps\\pwsh.exe",
    args: ["-NoLogo", "-NoExit", "-Command", "codex"],
    cwd: "C:\\repo",
  });
  assert.deepEqual(buildLaunchSpec("C:\\Windows\\powershell.exe", "C:\\repo", "claude"), {
    executable: "C:\\Windows\\powershell.exe",
    args: ["-NoLogo", "-NoExit", "-Command", "claude"],
    cwd: "C:\\repo",
  });
  assert.deepEqual(buildLaunchSpec("C:\\Windows\\cmd.exe", "C:\\repo", "codex"), {
    executable: "C:\\Windows\\cmd.exe",
    args: ["/d", "/k", "codex"],
    cwd: "C:\\repo",
  });
});

test("passes the agent command to a custom terminal executable", () => {
  assert.deepEqual(buildLaunchSpec("D:\\Terminal\\custom.exe", "C:\\repo", "claude"), {
    executable: "D:\\Terminal\\custom.exe",
    args: ["claude"],
    cwd: "C:\\repo",
  });
});
