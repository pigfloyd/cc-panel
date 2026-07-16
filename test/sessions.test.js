const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionStore } = require("../src/main/sessions");

test("removes a dead session after the terminal-state linger period", () => {
  const realNow = Date.now;
  const realKill = process.kill;
  let now = 1_000_000;
  const store = new SessionStore();
  store.dispose();

  Date.now = () => now;
  process.kill = () => {
    const err = new Error("process not found");
    err.code = "ESRCH";
    throw err;
  };

  try {
    store.handleEvent({
      session_id: "dead-session",
      event: "SessionStart",
      agent_pid: 12345,
      ts: now,
    });

    store._poll();
    assert.equal(store.snapshot()[0].state, "dead");

    now += 15_001;
    store._poll();
    assert.deepEqual(store.snapshot(), []);
  } finally {
    Date.now = realNow;
    process.kill = realKill;
  }
});

test("includes the client and state start time in snapshots", () => {
  const store = new SessionStore();
  store.dispose();

  store.handleEvent({
    session_id: "codex:test",
    event: "UserPromptSubmit",
    client: "codex",
    ts: 123_456,
  });

  const [session] = store.snapshot();
  assert.equal(session.client, "codex");
  assert.equal(session.stateSince, 123_456);
});

test("minimizes each tracked terminal window once", () => {
  const store = new SessionStore();
  store.dispose();
  const win32 = require("../src/main/win32");
  const realMinimizeWindow = win32.minimizeWindow;
  const minimized = [];
  win32.minimizeWindow = (hwnd) => {
    minimized.push(hwnd);
    return { ok: true };
  };

  try {
    store.handleEvent({ session_id: "one", event: "SessionStart", wt_hwnd: "101" });
    store.handleEvent({ session_id: "two", event: "SessionStart", wt_hwnd: "101" });
    store.handleEvent({ session_id: "three", event: "SessionStart", wt_hwnd: "202" });

    assert.deepEqual(store.minimizeAll(), { ok: true, minimized: 2 });
    assert.deepEqual(minimized, ["101", "202"]);
  } finally {
    win32.minimizeWindow = realMinimizeWindow;
  }
});
