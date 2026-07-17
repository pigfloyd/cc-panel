const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SessionStore, transcriptInterruptionTimestamp } = require("../src/main/sessions");

test("removes a session immediately when its agent process exits", () => {
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
    assert.deepEqual(store.snapshot(), []);
  } finally {
    Date.now = realNow;
    process.kill = realKill;
  }
});

test("removes a session immediately on SessionEnd", () => {
  const store = new SessionStore();
  store.dispose();

  store.handleEvent({ session_id: "ended-session", event: "SessionStart" });
  store.handleEvent({ session_id: "ended-session", event: "SessionEnd" });

  assert.deepEqual(store.snapshot(), []);
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

test("returns Claude sessions to idle and Codex sessions to done when a turn stops", () => {
  for (const [client, expectedState] of [["claude", "idle"], ["codex", "done"]]) {
    const store = new SessionStore();
    store.dispose();

    store.handleEvent({
      session_id: `${client}:turn`,
      event: "UserPromptSubmit",
      client,
      prompt_line: "run the tests",
      ts: 100,
    });
    store.handleEvent({
      session_id: `${client}:turn`,
      event: "PreToolUse",
      client,
      tool_name: "Bash",
      ts: 200,
    });
    store.handleEvent({
      session_id: `${client}:turn`,
      event: "Stop",
      client,
      ts: 300,
    });

    let [session] = store.snapshot();
    assert.equal(session.state, expectedState);
    assert.equal(session.stateSince, 300);
    assert.equal(session.currentTool, null);
    assert.equal(session.message, null);

    store.handleEvent({
      session_id: `${client}:turn`,
      event: "UserPromptSubmit",
      client,
      ts: 400,
    });
    [session] = store.snapshot();
    assert.equal(session.state, "working");
    assert.equal(session.stateSince, 400);
  }
});

test("recognizes Codex and Claude transcript interruption records", () => {
  const codexTimestamp = transcriptInterruptionTimestamp(JSON.stringify({
    timestamp: "2026-07-17T01:25:00.441Z",
    type: "event_msg",
    payload: { type: "turn_aborted", reason: "interrupted" },
  }));
  const claudeTimestamp = transcriptInterruptionTimestamp(JSON.stringify({
    timestamp: "2026-07-17T01:25:01.441Z",
    type: "user",
    message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
  }));

  assert.equal(codexTimestamp, Date.parse("2026-07-17T01:25:00.441Z"));
  assert.equal(claudeTimestamp, Date.parse("2026-07-17T01:25:01.441Z"));
  assert.equal(transcriptInterruptionTimestamp(JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: "keep working" }] },
  })), null);
});

test("returns interrupted sessions to idle when the Stop hook is absent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-panel-transcript-"));
  const records = [
    {
      client: "codex",
      file: path.join(tempDir, "codex.jsonl"),
      trailingNewline: true,
      interruption: {
        timestamp: "2026-07-17T01:25:00.441Z",
        type: "event_msg",
        payload: { type: "turn_aborted", reason: "interrupted" },
      },
    },
    {
      client: "claude",
      file: path.join(tempDir, "claude.jsonl"),
      trailingNewline: false,
      interruption: {
        timestamp: "2026-07-17T01:25:01.441Z",
        type: "user",
        message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
      },
    },
  ];

  try {
    for (const record of records) {
      fs.writeFileSync(record.file, `${JSON.stringify({ type: "session_start" })}\n`);
      const store = new SessionStore();
      store.dispose();
      try {
        store.handleEvent({
          session_id: `${record.client}:interrupted`,
          event: "UserPromptSubmit",
          client: record.client,
          transcript_path: record.file,
          ts: 100,
        });
        fs.appendFileSync(
          record.file,
          `${JSON.stringify(record.interruption)}${record.trailingNewline ? "\n" : ""}`
        );
        store.handleEvent({
          session_id: `${record.client}:interrupted`,
          event: "UserPromptSubmit",
          client: record.client,
          transcript_path: record.file,
          ts: 99,
        });

        store._pollTranscripts();

        const [session] = store.snapshot();
        assert.equal(session.state, "idle");
        assert.equal(session.currentTool, null);
        assert.equal(session.message, null);
      } finally {
        store.dispose();
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("keeps one card when a restarted conversation reports multiple real session IDs", () => {
  const store = new SessionStore();
  try {
    store.handleEvent({
      session_id: "captured:codex:42",
      event: "SessionStart",
      client: "codex",
      agent_pid: 42,
      terminal_pid: 7,
      cwd: "C:\\work\\project",
      captured: true,
      ts: 100,
    });

    // After Ctrl+C, Codex can identify SessionStart and the next prompt with
    // different IDs even though both still belong to the same terminal.
    store.handleEvent({
      session_id: "codex:restart",
      event: "SessionStart",
      client: "codex",
      agent_pid: 43,
      terminal_pid: 7,
      cwd: "C:\\work\\project",
      ts: 200,
    });
    store.handleEvent({
      session_id: "codex:next-prompt",
      event: "UserPromptSubmit",
      client: "codex",
      agent_pid: 43,
      terminal_pid: 7,
      cwd: "C:\\work\\project",
      prompt_line: "continue",
      ts: 300,
    });

    assert.deepEqual(store.snapshot().map((session) => session.id), ["codex:next-prompt"]);
    assert.equal(store.snapshot()[0].state, "working");

    // A delayed event using the superseded ID is routed to the same card and
    // then rejected by the existing timestamp guard.
    store.handleEvent({
      session_id: "codex:restart",
      event: "Stop",
      client: "codex",
      ts: 250,
    });
    assert.equal(store.snapshot().length, 1);
    assert.equal(store.snapshot()[0].state, "working");
  } finally {
    store.dispose();
  }
});

test("replaces the prior card when Codex starts a /new conversation", () => {
  const store = new SessionStore();
  try {
    store.handleEvent({
      session_id: "codex:old-conversation",
      event: "SessionStart",
      client: "codex",
      agent_pid: 42,
      wt_hwnd: "101",
      cwd: "C:\\work\\project",
      ts: 100,
    });
    store.handleEvent({
      session_id: "codex:new-conversation",
      event: "SessionStart",
      client: "codex",
      agent_pid: 43,
      wt_hwnd: "101",
      cwd: "C:\\work\\project",
      source: "new",
      ts: 200,
    });

    assert.deepEqual(store.snapshot().map((session) => session.id), ["codex:new-conversation"]);

    // Hooks still emitted for the old ID must update the replacement card,
    // rather than recreating the predecessor card.
    store.handleEvent({
      session_id: "codex:old-conversation",
      event: "Stop",
      client: "codex",
      ts: 150,
    });
    assert.equal(store.snapshot().length, 1);
    assert.equal(store.snapshot()[0].id, "codex:new-conversation");
  } finally {
    store.dispose();
  }
});

test("does not merge an ambiguous /new session in a shared terminal window", () => {
  const store = new SessionStore();
  try {
    for (const [id, pid] of [["codex:first", 41], ["codex:second", 42]]) {
      store.handleEvent({
        session_id: id,
        event: "SessionStart",
        client: "codex",
        agent_pid: pid,
        wt_hwnd: "101",
        cwd: "C:\\work\\project",
      });
    }
    store.handleEvent({
      session_id: "codex:new-conversation",
      event: "SessionStart",
      client: "codex",
      agent_pid: 43,
      wt_hwnd: "101",
      cwd: "C:\\work\\project",
      source: "new",
    });

    assert.equal(store.snapshot().length, 3);
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

test("creates a restarted Codex session after the captured agent exits", () => {
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

    // The original Codex process exits, so its captured card is removed.
    store._poll();
    assert.deepEqual(store.snapshot(), []);

    // A hook can occasionally miss the new agent PID. The fresh session must
    // still be created without inheriting the old PID.
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

test("does not replace the remaining captured card when another Codex terminal restarts", () => {
  const store = new SessionStore();
  try {
    // A has already exited and its captured card has expired. B is still
    // running in the same project and Windows Terminal window.
    store.handleEvent({
      session_id: "captured:codex:42",
      event: "SessionStart",
      client: "codex",
      agent_pid: 42,
      terminal_pid: 202,
      wt_hwnd: "101",
      cwd: "C:\\work\\shared",
      captured: true,
    });

    // Restarted A has a new process and shell. Its real hook must not consume
    // B merely because B is now the only captured card with this HWND/cwd.
    store.handleEvent({
      session_id: "codex:restarted-a",
      event: "UserPromptSubmit",
      client: "codex",
      agent_pid: 43,
      terminal_pid: 201,
      wt_hwnd: "101",
      cwd: "C:\\work\\shared",
    });

    assert.deepEqual(
      store.snapshot().map((session) => session.id),
      ["captured:codex:42", "codex:restarted-a"]
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

test("removes an idle stopped session when its mapped terminal window closes", () => {
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

test("removes stopped PowerShell and cmd sessions when their terminal process exits", () => {
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

test("removes an active session when its terminal window closes", () => {
  const store = new SessionStore();
  store.dispose();
  const win32 = require("../src/main/win32");
  const realIsWindowAlive = win32.isWindowAlive;
  win32.isWindowAlive = () => false;

  try {
    store.handleEvent({ session_id: "codex:working", event: "SessionStart", wt_hwnd: "101" });
    store.handleEvent({ session_id: "codex:working", event: "UserPromptSubmit" });

    store._poll();
    assert.deepEqual(store.snapshot(), []);
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
