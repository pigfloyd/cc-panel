const test = require("node:test");
const assert = require("node:assert/strict");
const { createStableSessionOrder } = require("../src/renderer/session-order");

function ids(sessions) {
  return sessions.map((session) => session.id);
}

test("keeps sessions in their first-seen order as states change", () => {
  const orderSessions = createStableSessionOrder();

  assert.deepEqual(ids(orderSessions([
    { id: "a", state: "working" },
    { id: "b", state: "idle" },
    { id: "c", state: "done" },
  ])), ["a", "b", "c"]);

  assert.deepEqual(ids(orderSessions([
    { id: "a", state: "done" },
    { id: "b", state: "working" },
    { id: "c", state: "idle" },
  ])), ["a", "b", "c"]);
});

test("does not reorder when sessions need attention", () => {
  const orderSessions = createStableSessionOrder();
  orderSessions([
    { id: "a", state: "working" },
    { id: "b", state: "working" },
    { id: "c", state: "working" },
  ]);

  assert.deepEqual(ids(orderSessions([
    { id: "a", state: "working" },
    { id: "b", state: "needs_input" },
    { id: "c", state: "error" },
  ])), ["a", "b", "c"]);

  assert.deepEqual(ids(orderSessions([
    { id: "a", state: "done" },
    { id: "b", state: "working" },
    { id: "c", state: "working" },
  ])), ["a", "b", "c"]);
});

test("appends newly seen sessions and drops removed ones", () => {
  const orderSessions = createStableSessionOrder();

  assert.deepEqual(ids(orderSessions([
    { id: "a", state: "working" },
    { id: "b", state: "working" },
  ])), ["a", "b"]);

  assert.deepEqual(ids(orderSessions([
    { id: "b", state: "working" },
    { id: "c", state: "needs_input" },
  ])), ["b", "c"]);

  assert.deepEqual(ids(orderSessions([
    { id: "c", state: "working" },
    { id: "b", state: "error" },
    { id: "a", state: "idle" },
  ])), ["b", "c", "a"]);
});

test("keeps a startup card in place when its temporary session ID is replaced", () => {
  const orderSessions = createStableSessionOrder();

  assert.deepEqual(ids(orderSessions([
    { id: "captured:codex:41", cardKey: "card:1", state: "idle" },
    { id: "captured:codex:42", cardKey: "card:2", state: "idle" },
  ])), ["captured:codex:41", "captured:codex:42"]);

  // SessionStore appends the real session object after the remaining captured
  // card. The stable card key must retain the original visual order.
  assert.deepEqual(ids(orderSessions([
    { id: "captured:codex:42", cardKey: "card:2", state: "idle" },
    { id: "codex:real-session", cardKey: "card:1", state: "working" },
  ])), ["codex:real-session", "captured:codex:42"]);
});
