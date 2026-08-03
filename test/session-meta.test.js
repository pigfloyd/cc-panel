const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clientLabel,
  compactDuration,
  stateAgeLabel,
  sessionsWithTerminal,
} = require("../src/renderer/session-meta");

test("labels known clients and recognizes legacy Codex session IDs", () => {
  assert.equal(clientLabel({ client: "claude", id: "abc" }), "Claude");
  assert.equal(clientLabel({ client: "codex", id: "abc" }), "Codex");
  assert.equal(clientLabel({ id: "codex:abc" }), "Codex");
});

test("formats compact state durations", () => {
  assert.equal(compactDuration(34_900), "34秒");
  assert.equal(compactDuration(120_000), "2分钟");
  assert.equal(compactDuration(7_200_000), "2小时");
});

test("formats compact state durations in English", () => {
  assert.equal(compactDuration(34_900, "en"), "34s");
  assert.equal(compactDuration(120_000, "en"), "2m");
  assert.equal(compactDuration(7_200_000, "en"), "2h");
});

test("distinguishes running duration from the age of other states", () => {
  const now = 1_000_000;
  assert.equal(stateAgeLabel({ state: "working", stateSince: now - 34_000 }, now), "运行 34秒");
  assert.equal(stateAgeLabel({ state: "done", stateSince: now - 120_000 }, now), "2分钟前");
});

test("distinguishes state age in English", () => {
  const now = 1_000_000;
  assert.equal(stateAgeLabel({ state: "working", stateSince: now - 34_000 }, now, "en"), "Running 34s");
  assert.equal(stateAgeLabel({ state: "done", stateSince: now - 120_000 }, now, "en"), "2m ago");
});

test("only shows sessions associated with a terminal process", () => {
  const sessions = [
    { id: "known-number", terminalPid: 123 },
    { id: "known-string", terminalPid: "456" },
    { id: "unknown-null", terminalPid: null },
    { id: "unknown-missing" },
  ];

  assert.deepEqual(
    sessionsWithTerminal(sessions).map((session) => session.id),
    ["known-number", "known-string"],
  );
  assert.deepEqual(sessionsWithTerminal(null), []);
});
