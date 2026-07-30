const test = require("node:test");
const assert = require("node:assert/strict");
const { buildHookDiagnostics } = require("../src/main/hook-diagnostics");

test("reports real-time hook mode when every client is ready", () => {
  const diagnostics = buildHookDiagnostics({
    clients: { claude: { status: "installed" }, codex: { status: "installed" } },
  }, { status: "running", port: 24333 }, 1234);

  assert.deepEqual(diagnostics, {
    lastEventAt: 1234,
    eventService: { status: "running", port: 24333 },
    mode: "hook",
  });
});

test("reports hybrid mode while Codex is waiting for trust", () => {
  const diagnostics = buildHookDiagnostics({
    clients: { claude: { status: "installed" }, codex: { status: "pending_trust" } },
  }, { status: "running" }, null);

  assert.equal(diagnostics.mode, "hybrid");
  assert.equal(diagnostics.lastEventAt, null);
});

test("reports process scan fallback when no hook client is ready", () => {
  const diagnostics = buildHookDiagnostics({
    clients: { claude: { status: "not_installed" }, codex: { status: "failed" } },
  }, { status: "stopped", port: 24333 }, undefined);

  assert.deepEqual(diagnostics.eventService, { status: "stopped", port: 24333 });
  assert.equal(diagnostics.mode, "process_scan");
});
