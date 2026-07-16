const test = require("node:test");
const assert = require("node:assert/strict");
const { createStableSessionOrder } = require("../src/renderer/session-order");

function ids(sessions) {
  return sessions.map((session) => session.id);
}

test("keeps ordinary sessions in their first-seen order as states change", () => {
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

test("pins attention sessions and restores their stable position afterward", () => {
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
  ])), ["b", "c", "a"]);

  assert.deepEqual(ids(orderSessions([
    { id: "a", state: "done" },
    { id: "b", state: "working" },
    { id: "c", state: "working" },
  ])), ["a", "b", "c"]);
});
