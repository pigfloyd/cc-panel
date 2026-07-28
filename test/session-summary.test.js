const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeSessions } = require("../src/renderer/session-summary");

test("summarizes empty and inactive session lists", () => {
  assert.deepEqual(summarizeSessions([]), {
    total: 0,
    working: 0,
    needsInput: 0,
    error: 0,
    attention: 0,
    state: "idle",
    title: "暂无会话",
    detail: "等待会话启动",
  });

  assert.equal(summarizeSessions([{ state: "done" }]).detail, "当前无运行任务");
});

test("prioritizes errors and reports attention counts", () => {
  assert.deepEqual(summarizeSessions([
    { state: "working" },
    { state: "needs_input" },
    { state: "needs_input" },
    { state: "error" },
    { state: "idle" },
  ]), {
    total: 5,
    working: 1,
    needsInput: 2,
    error: 1,
    attention: 3,
    state: "error",
    title: "5 个会话",
    detail: "1 个出错 · 2 个待处理",
  });
});

test("uses working as the primary state when nothing needs attention", () => {
  const summary = summarizeSessions([
    { state: "working" },
    { state: "working" },
    { state: "done" },
  ]);

  assert.equal(summary.state, "working");
  assert.equal(summary.attention, 0);
  assert.equal(summary.detail, "2 个工作中");
});
