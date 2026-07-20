const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  windowsHookRuntime,
  windowsHookCommand,
  install,
  SETTINGS_PATH,
} = require("../src/main/hook-installer");

test("prefers system Node over Electron for hook runtime when available", () => {
  const runtime = windowsHookRuntime();
  const systemNode = "C:\\Program Files\\nodejs\\node.exe";
  if (!fs.existsSync(systemNode)) {
    // Without a global Node install, fall back to the .cmd launcher or Electron.
    assert.ok(runtime.kind === "cmd" || runtime.electron);
    return;
  }
  assert.equal(runtime.electron, false);
  assert.equal(runtime.executable, systemNode);
});

test("Claude hook command uses the .cmd launcher when present", () => {
  const cmd = path.join(__dirname, "..", "hook", "cc-panel-hook.cmd");
  assert.equal(fs.existsSync(cmd), true);
  // install() is idempotent and rewrites settings with the preferred launcher.
  install();
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /cc-panel-hook\.cmd/);
  assert.doesNotMatch(command, /electron\.exe/i);
});
