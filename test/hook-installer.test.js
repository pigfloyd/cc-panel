const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  CLAUDE_EVENTS,
  claudeEntry,
  hasAll,
  installEntries,
  summarizeInstallResults,
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

test("reports a partial client failure as an overall install failure", () => {
  const result = summarizeInstallResults(
    { status: "failed", changed: false, error: "Claude settings are locked" },
    { status: "installed", changed: true },
  );

  assert.equal(result.ok, false);
  assert.equal(result.claude.status, "failed");
  assert.equal(result.codex.status, "installed");
  assert.equal(result.changed, true);
});

test("keeps pending trust distinct from installation failure", () => {
  const result = summarizeInstallResults(
    { status: "pending_trust", changed: false, skipped: true },
    { status: "installed", changed: false },
  );

  assert.equal(result.ok, true);
  assert.equal(result.claude.status, "pending_trust");
});

test("does not report success when post-install verification is incomplete", () => {
  const result = summarizeInstallResults(
    { status: "installed", changed: false },
    { status: "not_installed", changed: false },
  );

  assert.equal(result.ok, false);
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
