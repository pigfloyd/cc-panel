const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  CLAUDE_EVENTS,
  claudeEntry,
  hasAll,
  installEntries,
  windowsHookRuntime,
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
  const command = claudeEntry("SessionStart").hooks[0].command;
  assert.match(command, /cc-panel-hook\.cmd/);
  assert.doesNotMatch(command, /electron\.exe/i);
});

test("restores externally removed Claude hooks without rewriting healthy settings", () => {
  const settings = { env: { EXAMPLE: "preserved" } };

  assert.equal(installEntries(settings, CLAUDE_EVENTS, claudeEntry), true);
  assert.equal(hasAll(settings, CLAUDE_EVENTS), true);
  assert.deepEqual(settings.env, { EXAMPLE: "preserved" });
  assert.equal(installEntries(settings, CLAUDE_EVENTS, claudeEntry), false);

  delete settings.hooks.UserPromptSubmit;
  assert.equal(hasAll(settings, CLAUDE_EVENTS), false);
  assert.equal(installEntries(settings, CLAUDE_EVENTS, claudeEntry), true);
  assert.equal(hasAll(settings, CLAUDE_EVENTS), true);
});
