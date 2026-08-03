const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isAutoFocusState,
  selectAttentionCandidates,
} = require("../src/main/attention-focus");

test("auto-focus only reacts to input and error states", () => {
  assert.equal(isAutoFocusState("needs_input"), true);
  assert.equal(isAutoFocusState("error"), true);
  assert.equal(isAutoFocusState("done"), false);
  assert.equal(isAutoFocusState("working"), false);
});

test("attention candidates prioritize input and then the latest transition", () => {
  const sessions = [
    { id: "error", cardKey: "card:error", state: "error", stateSince: 300, hasWindow: true },
    { id: "input-old", cardKey: "card:input-old", state: "needs_input", stateSince: 100, hasWindow: true },
    { id: "input-new", cardKey: "card:input-new", state: "needs_input", stateSince: 200, hasWindow: true },
  ];
  const transitions = [
    { cardKey: "card:error", state: "error", stateSince: 300, sequence: 3 },
    { cardKey: "card:input-old", state: "needs_input", stateSince: 100, sequence: 1 },
    { cardKey: "card:input-new", state: "needs_input", stateSince: 200, sequence: 2 },
  ];

  assert.deepEqual(
    selectAttentionCandidates(transitions, sessions).map((session) => session.id),
    ["input-new", "input-old", "error"],
  );
});

test("attention candidates discard stale transitions and sessions without windows", () => {
  const sessions = [
    { id: "changed", cardKey: "card:changed", state: "working", stateSince: 400, hasWindow: true },
    { id: "newer", cardKey: "card:newer", state: "error", stateSince: 500, hasWindow: true },
    { id: "windowless", cardKey: "card:windowless", state: "needs_input", stateSince: 300, hasWindow: false },
  ];
  const transitions = [
    { cardKey: "card:changed", state: "needs_input", stateSince: 100, sequence: 1 },
    { cardKey: "card:newer", state: "error", stateSince: 200, sequence: 2 },
    { cardKey: "card:windowless", state: "needs_input", stateSince: 300, sequence: 3 },
  ];

  assert.deepEqual(selectAttentionCandidates(transitions, sessions), []);
});
