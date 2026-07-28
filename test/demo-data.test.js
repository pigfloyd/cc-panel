const test = require("node:test");
const assert = require("node:assert/strict");
const { createDemoSessions } = require("../src/renderer/demo-data");

test("creates screenshot-safe demo sessions for both supported clients", () => {
  const now = 10_000_000;
  const sessions = createDemoSessions(now);

  assert.deepEqual(
    new Set(sessions.map((session) => session.client)),
    new Set(["claude", "codex"]),
  );
  assert.deepEqual(
    new Set(sessions.map((session) => session.state)),
    new Set(["working", "needs_input", "done", "error", "idle"]),
  );
  assert.ok(sessions.every((session) => session.hasWindow));
  assert.ok(sessions.every((session) => session.stateSince <= now));
  assert.ok(sessions.every((session) => !session.cwd.includes("ourchem")));
});
