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

test("replaces a startup-captured card when its real hook session arrives", () => {
  const store = new SessionStore();
  try {
    store.handleEvent({
      session_id: "captured:codex:42",
      event: "SessionStart",
      client: "codex",
      agent_pid: 42,
      captured: true,
    });
    store.handleEvent({
      session_id: "codex:real-session",
      event: "SessionStart",
      client: "codex",
      agent_pid: 42,
    });

    assert.deepEqual(store.snapshot().map((session) => session.id), ["codex:real-session"]);
  } finally {
    store.dispose();
  }
});

test("replaces a startup-captured card when wrapper agent PIDs differ", () => {
  const store = new SessionStore();
  try {
    store.handleEvent({
      session_id: "captured:codex:42",
      event: "SessionStart",
      client: "codex",
      agent_pid: 42,
      terminal_pid: 7,
      wt_hwnd: "101",
      cwd: "C:\\work\\project",
      captured: true,
    });
    store.handleEvent({
      session_id: "codex:real-session",
      event: "UserPromptSubmit",
      client: "codex",
      agent_pid: 43,
      terminal_pid: 7,
      ts: 123,
    });

    assert.deepEqual(store.snapshot(), [{
      id: "codex:real-session",
      project: "project",
      cwd: "C:\\work\\project",
      client: "codex",
      state: "working",
      stateSince: 123,
      currentTool: null,
      lastPrompt: null,
      message: null,
      hasWindow: true,
    }]);
  } finally {
    store.dispose();
  }
});

test("keeps a restarted Codex session working when the captured agent exited", () => {
  const store = new SessionStore();
  store.dispose();
  const realKill = process.kill;
  const exitedAgentPid = 42;
  process.kill = (pid) => {
    if (pid !== exitedAgentPid) return;
    const err = new Error("process not found");
    err.code = "ESRCH";
    throw err;
  };

  try {
    store.handleEvent({
      session_id: "captured:codex:42",
      event: "SessionStart",
      client: "codex",
      agent_pid: exitedAgentPid,
      terminal_pid: 7,
      cwd: "C:\\work\\project",
      captured: true,
    });

    // The original Codex process exits, but its terminal remains open.
    store._poll();
    assert.equal(store.snapshot()[0].state, "dead");

    // A hook can occasionally miss the new agent PID. Matching the stable
    // terminal must replace the captured card without inheriting the old PID.
    store.handleEvent({
      session_id: "codex:new-session",
      event: "UserPromptSubmit",
      client: "codex",
      terminal_pid: 7,
      cwd: "C:\\work\\project",
    });
    store._poll();
    store._poll();

    const sessions = store.snapshot();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "codex:new-session");
    assert.equal(sessions[0].state, "working");
  } finally {
    process.kill = realKill;
  }
});

test("keeps the captured card count when only the terminal window matches", () => {
  const store = new SessionStore();
  try {
    for (const [pid, hwnd] of [
      [41, "101"],
      [42, "202"],
      [43, "303"],
    ]) {
      store.handleEvent({
        session_id: `captured:codex:${pid}`,
        event: "SessionStart",
        client: "codex",
        agent_pid: pid,
        wt_hwnd: hwnd,
        cwd: "C:\\work\\shared",
        captured: true,
      });
    }

    store.handleEvent({
      session_id: "codex:real-session",
      event: "UserPromptSubmit",
      client: "codex",
      wt_hwnd: "202",
      cwd: "C:\\work\\shared\\",
    });

    assert.deepEqual(
      store.snapshot().map((session) => session.id),
      ["captured:codex:41", "captured:codex:43", "codex:real-session"]
    );
  } finally {
    store.dispose();
  }
});

test("uses cwd only when it identifies one captured card", () => {
  const store = new SessionStore();
  try {
    store.handleEvent({
      session_id: "captured:codex:41",
      event: "SessionStart",
      client: "codex",
      cwd: "C:\\work\\one",
      captured: true,
    });
    store.handleEvent({
      session_id: "captured:codex:42",
      event: "SessionStart",
      client: "codex",
      cwd: "C:\\work\\two",
      captured: true,
    });
    store.handleEvent({
      session_id: "codex:real-session",
      event: "UserPromptSubmit",
      client: "codex",
      cwd: "c:\\WORK\\two\\",
    });

    assert.deepEqual(
      store.snapshot().map((session) => session.id),
      ["captured:codex:41", "codex:real-session"]
    );
  } finally {
    store.dispose();
  }
});

test("does not collapse ambiguous cards that share a window and cwd", () => {
  const store = new SessionStore();
  try {
    for (const pid of [41, 42]) {
      store.handleEvent({
        session_id: `captured:codex:${pid}`,
        event: "SessionStart",
        client: "codex",
        agent_pid: pid,
        wt_hwnd: "101",
        cwd: "C:\\work\\shared",
        captured: true,
      });
    }
    store.handleEvent({
      session_id: "codex:real-session",
      event: "UserPromptSubmit",
      client: "codex",
      wt_hwnd: "101",
      cwd: "C:\\work\\shared",
    });

    assert.deepEqual(
      store.snapshot().map((session) => session.id),
      ["captured:codex:41", "captured:codex:42", "codex:real-session"]
    );
  } finally {
    store.dispose();
  }
});

test("does not replace another client's captured card on a shared terminal PID", () => {
  const store = new SessionStore();
  try {
    store.handleEvent({
      session_id: "captured:claude:42",
      event: "SessionStart",
      client: "claude",
      agent_pid: 42,
      terminal_pid: 7,
      captured: true,
    });
    store.handleEvent({
      session_id: "codex:real-session",
      event: "UserPromptSubmit",
      client: "codex",
      agent_pid: 43,
      terminal_pid: 7,
    });

    assert.deepEqual(
      store.snapshot().map((session) => session.id),
      ["captured:claude:42", "codex:real-session"]
    );
  } finally {
    store.dispose();
  }
});

test("removes a completed session when its mapped terminal window closes", () => {
  const store = new SessionStore();
  store.dispose();
  const win32 = require("../src/main/win32");
  const realIsWindowAlive = win32.isWindowAlive;
  win32.isWindowAlive = () => false;

  try {
    store.handleEvent({ session_id: "codex:done", event: "SessionStart", wt_hwnd: "101" });
    store.handleEvent({ session_id: "codex:done", event: "Stop" });

    store._poll();
    assert.deepEqual(store.snapshot(), []);
  } finally {
    win32.isWindowAlive = realIsWindowAlive;
  }
});

test("removes completed PowerShell and cmd sessions when their terminal process exits", () => {
  const store = new SessionStore();
  store.dispose();
  const realKill = process.kill;
  const exitedTerminalPids = new Set([201, 202]);
  process.kill = (pid) => {
    if (!exitedTerminalPids.has(pid)) return;
    const err = new Error("process not found");
    err.code = "ESRCH";
    throw err;
  };

  try {
    store.handleEvent({
      session_id: "codex:powershell",
      event: "SessionStart",
      agent_pid: 301,
      terminal_pid: 201,
    });
    store.handleEvent({ session_id: "codex:powershell", event: "Stop" });
    store.handleEvent({
      session_id: "codex:cmd",
      event: "SessionStart",
      agent_pid: 302,
      terminal_pid: 202,
    });
    store.handleEvent({ session_id: "codex:cmd", event: "Stop" });

    store._poll();
    assert.deepEqual(store.snapshot(), []);
  } finally {
    process.kill = realKill;
  }
});

test("marks an active session dead when its terminal window closes", () => {
  const store = new SessionStore();
  store.dispose();
  const win32 = require("../src/main/win32");
  const realIsWindowAlive = win32.isWindowAlive;
  win32.isWindowAlive = () => false;

  try {
    store.handleEvent({ session_id: "codex:working", event: "SessionStart", wt_hwnd: "101" });
    store.handleEvent({ session_id: "codex:working", event: "UserPromptSubmit" });

    store._poll();
    assert.equal(store.snapshot()[0].state, "dead");
  } finally {
    win32.isWindowAlive = realIsWindowAlive;
  }
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
