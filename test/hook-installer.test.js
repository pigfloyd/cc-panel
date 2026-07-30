const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  CLAUDE_EVENTS,
  CODEX_EVENTS,
  claudeEntry,
  codexEntry,
  codexHookHash,
  hasAll,
  hasTrustedCodexHooks,
  installEntries,
  parseCodexHookStates,
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

test("upgrades Codex hooks with SessionEnd for immediate session cleanup", () => {
  const legacyEvents = CODEX_EVENTS.filter((event) => event !== "SessionEnd");
  const settings = {};

  assert.equal(installEntries(settings, legacyEvents, codexEntry), true);
  assert.equal(hasAll(settings, legacyEvents), true);
  assert.equal(hasAll(settings, CODEX_EVENTS), false);

  assert.equal(installEntries(settings, CODEX_EVENTS, codexEntry), true);
  assert.equal(hasAll(settings, CODEX_EVENTS), true);
  assert.match(settings.hooks.SessionEnd[0].hooks[0].commandWindows, /SessionEnd codex$/i);
  assert.equal(installEntries(settings, CODEX_EVENTS, codexEntry), false);
});

test("matches Codex's normalized hook trust hash on Windows", () => {
  const entry = codexEntry("SessionEnd");

  assert.equal(
    codexHookHash("SessionEnd", entry, entry.hooks[0], "win32"),
    "sha256:5a7749dce246636d2713d385c2a7788d23efeac72735f97fe604b3f9009206a8",
  );
});

test("requires every installed Codex hook's current hash to be trusted", () => {
  const settings = {};
  installEntries(settings, CODEX_EVENTS, codexEntry);
  const hooksPath = "C:\\Users\\test\\.codex\\hooks.json";
  const trustTables = [];

  for (const event of CODEX_EVENTS) {
    const group = settings.hooks[event][0];
    const eventLabel = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const key = `${hooksPath}:${eventLabel}:0:0`;
    const hash = codexHookHash(event, group, group.hooks[0], "win32");
    trustTables.push(`[hooks.state.'${key}']\ntrusted_hash = "${hash}"`);
  }

  const states = parseCodexHookStates(trustTables.join("\n\n"));
  assert.equal(hasTrustedCodexHooks(settings, states, hooksPath, "win32"), true);

  settings.hooks.PreToolUse[0].hooks[0].commandWindows += " changed";
  assert.equal(hasTrustedCodexHooks(settings, states, hooksPath, "win32"), false);
});
