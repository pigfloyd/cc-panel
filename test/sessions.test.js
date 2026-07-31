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

test("returns Claude and Codex sessions to done when a turn stops", () => {
  for (const client of ["claude", "codex"]) {
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
    assert.equal(session.state, "done");
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

test("maps Claude notifications without treating informational events as input requests", () => {
  const cases = [
    ["permission_prompt", "needs_input", "Approve Bash"],
    ["elicitation_dialog", "needs_input", "Complete the form"],
    ["agent_needs_input", "needs_input", "Background session needs input"],
    ["idle_prompt", "done", null],
    ["elicitation_complete", "working", null],
    ["elicitation_response", "working", null],
  ];

  for (const [notificationType, expectedState, expectedMessage] of cases) {
    const store = new SessionStore();
    store.dispose();
    store.handleEvent({
      session_id: `claude:${notificationType}`,
      event: "Notification",
      client: "claude",
      notification_type: notificationType,
      message: "Notification message",
      ts: 100,
    });

    const [session] = store.snapshot();
    assert.equal(session.state, expectedState, notificationType);
    assert.equal(session.message, expectedMessage === null ? null : "Notification message", notificationType);
  }
});

test("ignores authentication, unknown, and untyped notifications", () => {
  const store = new SessionStore();
  store.dispose();

  for (const notificationType of ["auth_success", "agent_completed", "future_notification", undefined]) {
    store.handleEvent({
      session_id: "claude:notification-ignore",
      event: "Notification",
      client: "claude",
      notification_type: notificationType,
      message: "Informational notification",
      ts: 200,
    });
  }
  assert.deepEqual(store.snapshot(), []);

  store.handleEvent({
    session_id: "claude:notification-ignore",
    event: "UserPromptSubmit",
    client: "claude",
    ts: 100,
  });
  store.handleEvent({
    session_id: "claude:notification-ignore",
    event: "Notification",
    client: "claude",
    notification_type: "auth_success",
    ts: 300,
  });
  store.handleEvent({
    session_id: "claude:notification-ignore",
    event: "Stop",
    client: "claude",
    ts: 200,
  });

  assert.equal(store.snapshot()[0].state, "done");
  assert.equal(store.snapshot()[0].stateSince, 200);
});

test("does not complete an active Claude turn when a background agent finishes", () => {
  const store = new SessionStore();
  store.dispose();

  store.handleEvent({
    session_id: "claude:background-agent",
    event: "UserPromptSubmit",
    client: "claude",
    ts: 100,
  });
  store.handleEvent({
    session_id: "claude:background-agent",
    event: "Notification",
    client: "claude",
    notification_type: "agent_completed",
    ts: 200,
  });

  const [session] = store.snapshot();
  assert.equal(session.state, "working");
  assert.equal(session.stateSince, 100);
});

test("ignores a delayed async prompt hook after the turn has stopped", () => {
  const store = new SessionStore();
  store.dispose();

  store.handleEvent({
    session_id: "claude:delayed-prompt",
    event: "Stop",
    client: "claude",
    ts: 300,
  });
  store.handleEvent({
    session_id: "claude:delayed-prompt",
    event: "UserPromptSubmit",
    client: "claude",
    prompt_line: "slow snapshot",
    ts: 100,
  });

  const [session] = store.snapshot();
  assert.equal(session.state, "done");
  assert.equal(session.stateSince, 300);
  assert.equal(session.lastPrompt, null);
});

test("recognizes Codex and Claude transcript interruption records", () => {
  const codexTimestamp = transcriptInterruptionTimestamp(JSON.stringify({
    timestamp: "2026-07-17T01:25:00.441Z",
    type: "event_msg",
    payload: { type: "turn_aborted", reason: "interrupted" },
  }));

  // English locale plain interrupt
  const claudeEnTimestamp = transcriptInterruptionTimestamp(JSON.stringify({
    timestamp: "2026-07-17T01:25:01.441Z",
    type: "user",
    message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
  }));

  // French locale plain Ctrl+C interrupt (actual string from transcript)
  const claudeFrTimestamp = transcriptInterruptionTimestamp(JSON.stringify({
    timestamp: "2026-07-17T01:25:02.441Z",
    type: "user",
    message: { content: [{ type: "text", text: "[Requête   interrompue  par l'utilisateur]" }] },
  }));

  // French locale tool-use interrupt (actual string from transcript)
  const claudeToolTimestamp = transcriptInterruptionTimestamp(JSON.stringify({
    timestamp: "2026-07-17T01:25:03.441Z",
    type: "user",
    message: { content: [{ type: "text", text: "[Requête interrompue par l'utilisateur  pour  utilisation  d'outil]" }] },
  }));

  assert.equal(codexTimestamp, Date.parse("2026-07-17T01:25:00.441Z"));
  assert.equal(claudeEnTimestamp, Date.parse("2026-07-17T01:25:01.441Z"));
  assert.equal(claudeFrTimestamp, Date.parse("2026-07-17T01:25:02.441Z"));
  assert.equal(claudeToolTimestamp, Date.parse("2026-07-17T01:25:03.441Z"));
  assert.equal(transcriptInterruptionTimestamp(JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: "keep working" }] },
  })), null);
});

test("marks a Codex task_complete error as an abnormal session", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-panel-task-error-"));
  const transcript = path.join(tempDir, "codex.jsonl");

  try {
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_start" })}\n`);
    const store = new SessionStore();
    store.dispose();
    try {
      store.handleEvent({
        session_id: "codex:rate-limited",
        event: "UserPromptSubmit",
        client: "codex",
        transcript_path: transcript,
        tool_name: "exec",
        ts: 100,
      });

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-28T08:59:20.331Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          error: {
            message: "exceeded retry limit, last status: 429 Too Many Requests",
            codex_error_info: {
              response_too_many_failed_attempts: { http_status_code: 429 },
            },
          },
        },
      })}\n`);

      store._pollTranscripts();
      const [session] = store.snapshot();
      assert.equal(session.state, "error");
      assert.equal(session.stateSince, Date.parse("2026-07-28T08:59:20.331Z"));
      assert.equal(session.currentTool, null);
    } finally {
      store.dispose();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("does not apply a previous Codex task error after a newer turn starts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-panel-stale-task-error-"));
  const transcript = path.join(tempDir, "codex.jsonl");

  try {
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_start" })}\n`);
    const store = new SessionStore();
    store.dispose();
    try {
      store.handleEvent({
        session_id: "codex:recovered",
        event: "UserPromptSubmit",
        client: "codex",
        transcript_path: transcript,
        ts: 100,
      });
      fs.appendFileSync(transcript, [
        JSON.stringify({
          timestamp: "2026-07-28T08:59:20.331Z",
          type: "event_msg",
          payload: { type: "task_complete", error: { message: "rate limited" } },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T09:00:47.919Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "new-turn" },
        }),
      ].join("\n") + "\n");

      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "working");

    } finally {
      store.dispose();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("marks a Codex request_user_input call as waiting for input until answered", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-panel-question-"));
  const transcript = path.join(tempDir, "codex.jsonl");
  const callId = "call_question_1";

  try {
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_start" })}\n`);
    const store = new SessionStore();
    store.dispose();
    try {
      store.handleEvent({
        session_id: "codex:question",
        event: "UserPromptSubmit",
        client: "codex",
        transcript_path: transcript,
        ts: 100,
      });

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-17T01:25:00.441Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: callId,
        },
      })}\n`);
      store._pollTranscripts();
      let [session] = store.snapshot();
      assert.equal(session.state, "needs_input");

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-17T01:25:02.441Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: "selected",
        },
      })}\n`);
      store._pollTranscripts();
      [session] = store.snapshot();
      assert.equal(session.state, "working");
    } finally {
      store.dispose();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("marks a Codex escalated command as waiting for approval until answered", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-panel-approval-"));
  const transcript = path.join(tempDir, "codex.jsonl");
  const callId = "call_approval_1";

  try {
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_start" })}\n`);
    const store = new SessionStore();
    store.dispose();
    try {
      store.handleEvent({
        session_id: "codex:approval",
        event: "UserPromptSubmit",
        client: "codex",
        transcript_path: transcript,
        ts: 100,
      });

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-29T05:46:04.441Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: callId,
          input: 'await tools.shell_command({ command: "npm test", sandbox_permissions: "require_escalated" })',
        },
      })}\n`);
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "needs_input");

      store.handleEvent({
        session_id: "codex:approval",
        event: "PostToolUse",
        client: "codex",
        tool_name: "unrelated_tool",
        ts: Date.parse("2026-07-29T05:46:04.941Z"),
      });
      assert.equal(store.snapshot()[0].state, "needs_input");

      store.handleEvent({
        session_id: "codex:approval",
        event: "PreToolUse",
        client: "codex",
        tool_name: "shell_command",
        ts: Date.parse("2026-07-29T05:46:05.441Z"),
      });
      assert.equal(store.snapshot()[0].state, "needs_input");
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "needs_input");

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-29T05:46:06.441Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: callId,
          output: "Exit code: 0",
        },
      })}\n`);
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "working");

      const deniedCallId = "call_approval_2";
      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-29T05:46:07.441Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: deniedCallId,
          input: 'await tools.shell_command({ command: "npm test", sandbox_permissions: "require_escalated" })',
        },
      })}\n`);
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "needs_input");

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-29T05:46:08.441Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: deniedCallId,
          output: "Denied by user",
        },
      })}\n`);
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "working");

      const fastApprovalCallId = "call_approval_3";
      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-29T05:46:09.441Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: fastApprovalCallId,
          input: 'await tools.shell_command({ command: "npm test", sandbox_permissions: "require_escalated" })',
        },
      })}\n`);
      store.handleEvent({
        session_id: "codex:approval",
        event: "PreToolUse",
        client: "codex",
        tool_name: "shell_command",
        ts: Date.parse("2026-07-29T05:46:10.441Z"),
      });
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "needs_input");

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-29T05:46:11.441Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: fastApprovalCallId,
          output: "Exit code: 0",
        },
      })}\n`);
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "working");
    } finally {
      store.dispose();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("keeps waiting until all Codex approvals are answered", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-panel-multi-approval-"));
  const transcript = path.join(tempDir, "codex.jsonl");

  try {
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_start" })}\n`);
    const store = new SessionStore();
    store.dispose();
    try {
      store.handleEvent({
        session_id: "codex:multi-approval",
        event: "UserPromptSubmit",
        client: "codex",
        transcript_path: transcript,
        ts: 100,
      });

      for (const [callId, timestamp] of [
        ["call_approval_a", "2026-07-29T06:00:00.000Z"],
        ["call_approval_b", "2026-07-29T06:00:01.000Z"],
      ]) {
        fs.appendFileSync(transcript, `${JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: callId,
            input: 'await tools.shell_command({ command: "npm test", sandbox_permissions: "require_escalated" })',
          },
        })}\n`);
      }
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "needs_input");

      store.handleEvent({
        session_id: "codex:multi-approval",
        event: "PreToolUse",
        client: "codex",
        tool_name: "shell_command",
        ts: Date.parse("2026-07-29T06:00:02.000Z"),
      });
      assert.equal(store.snapshot()[0].state, "needs_input");

      store.handleEvent({
        session_id: "codex:multi-approval",
        event: "PreToolUse",
        client: "codex",
        tool_name: "shell_command",
        ts: Date.parse("2026-07-29T06:00:03.000Z"),
      });
      assert.equal(store.snapshot()[0].state, "needs_input");

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-29T06:00:04.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_approval_a",
          output: "Exit code: 0",
        },
      })}\n`);
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "needs_input");

      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-29T06:00:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_approval_b",
          output: "Denied by user",
        },
      })}\n`);
      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "working");
    } finally {
      store.dispose();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("keeps a Codex question waiting when a delayed PreToolUse hook arrives", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-panel-question-race-"));
  const transcript = path.join(tempDir, "codex.jsonl");

  try {
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session_start" })}\n`);
    const store = new SessionStore();
    store.dispose();
    try {
      store.handleEvent({
        session_id: "codex:question-race",
        event: "UserPromptSubmit",
        client: "codex",
        transcript_path: transcript,
        ts: 100,
      });
      fs.appendFileSync(transcript, `${JSON.stringify({
        timestamp: "2026-07-17T01:25:00.441Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "request_user_input",
          call_id: "call_question_race",
        },
      })}\n`);

      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "needs_input");

      store.handleEvent({
        session_id: "codex:question-race",
        event: "PreToolUse",
        client: "codex",
        tool_name: "request_user_input",
        ts: Date.parse("2026-07-17T01:25:01.441Z"),
      });
      assert.equal(store.snapshot()[0].state, "needs_input");

      store._pollTranscripts();
      assert.equal(store.snapshot()[0].state, "needs_input");
    } finally {
      store.dispose();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
        message: { content: [{ type: "text", text: "[Requête   interrompue  par l'utilisateur]" }] },
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
    const capturedCardKey = store.snapshot()[0].cardKey;
    store.handleEvent({
      session_id: "codex:real-session",
      event: "SessionStart",
      client: "codex",
      agent_pid: 42,
    });

    assert.deepEqual(store.snapshot().map((session) => session.id), ["codex:real-session"]);
    assert.equal(store.snapshot()[0].cardKey, capturedCardKey);
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

test("does not merge distinct processes when foreground inference reports the same window", () => {
  const store = new SessionStore();
  try {
    for (const [id, agentPid, terminalPid, ts] of [
      ["codex:first", 41, 201, 100],
      ["codex:second", 42, 202, 200],
    ]) {
      store.handleEvent({
        session_id: id,
        event: "SessionStart",
        client: "codex",
        agent_pid: agentPid,
        terminal_pid: terminalPid,
        wt_hwnd: "101",
        window_mapping: "foreground",
        cwd: "C:\\work\\project",
        ts,
      });
    }
    store.handleEvent({
      session_id: "codex:new-conversation",
      event: "SessionStart",
      client: "codex",
      agent_pid: 43,
      terminal_pid: 203,
      wt_hwnd: "101",
      window_mapping: "foreground",
      cwd: "C:\\work\\project",
      source: "new",
      ts: 300,
    });

    assert.deepEqual(store.snapshot().map((session) => session.id), [
      "codex:first",
      "codex:second",
      "codex:new-conversation",
    ]);
  } finally {
    store.dispose();
  }
});

test("keeps one card when exact mappings identify the same terminal window", () => {
  const store = new SessionStore();
  try {
    for (const [id, agentPid, terminalPid, ts] of [
      ["codex:first", 41, 201, 100],
      ["codex:second", 42, 202, 200],
    ]) {
      store.handleEvent({
        session_id: id,
        event: "SessionStart",
        client: "codex",
        agent_pid: agentPid,
        terminal_pid: terminalPid,
        wt_hwnd: "101",
        window_mapping: "exact",
        cwd: "C:\\work\\project",
        ts,
      });
    }

    assert.deepEqual(store.snapshot().map((session) => session.id), ["codex:second"]);
  } finally {
    store.dispose();
  }
});

test("keeps Claude and Codex cards separate when they share an exact terminal window", () => {
  const store = new SessionStore();
  try {
    store.handleEvent({
      session_id: "codex:session",
      event: "SessionStart",
      client: "codex",
      agent_pid: 41,
      terminal_pid: 201,
      wt_hwnd: "101",
      window_mapping: "exact",
      ts: 100,
    });
    store.handleEvent({
      session_id: "claude:session",
      event: "SessionStart",
      client: "claude",
      agent_pid: 42,
      terminal_pid: 202,
      wt_hwnd: "101",
      window_mapping: "exact",
      ts: 200,
    });

    assert.deepEqual(
      store.snapshot().map((session) => [session.id, session.client]),
      [["codex:session", "codex"], ["claude:session", "claude"]]
    );
  } finally {
    store.dispose();
  }
});

test("does not add a captured duplicate after a real hook session exists", () => {
  const store = new SessionStore();
  try {
    store.handleEvent({
      session_id: "claude:real-session",
      event: "UserPromptSubmit",
      client: "claude",
      agent_pid: 42,
      ts: 100,
    });
    store.handleEvent({
      session_id: "captured:claude:42",
      event: "SessionStart",
      client: "claude",
      agent_pid: 42,
      terminal_pid: 202,
      wt_hwnd: "101",
      window_mapping: "exact",
      cwd: "C:\\work\\project",
      captured: true,
      ts: 200,
    });

    assert.deepEqual(store.snapshot(), [{
      id: "claude:real-session",
      cardKey: "card:1",
      project: "project",
      cwd: "C:\\work\\project",
      client: "claude",
      state: "working",
      stateSince: 100,
      currentTool: null,
      lastPrompt: null,
      message: null,
      terminalPid: 202,
      hasWindow: true,
    }]);
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
      cardKey: "card:1",
      project: "project",
      cwd: "C:\\work\\project",
      client: "codex",
      state: "working",
      stateSince: 123,
      currentTool: null,
      lastPrompt: null,
      message: null,
      terminalPid: 7,
      hasWindow: true,
    }]);
  } finally {
    store.dispose();
  }
});

test("keeps one card when a captured Codex session is cleared in the same exact terminal", () => {
  const store = new SessionStore();
  try {
    const captured = {
      session_id: "captured:codex:42",
      event: "SessionStart",
      client: "codex",
      agent_pid: 42,
      terminal_pid: 7,
      wt_hwnd: "101",
      window_mapping: "exact",
      cwd: "C:\\work\\project",
      captured: true,
      ts: 100,
    };
    store.handleEvent(captured);
    store.handleEvent({
      session_id: "codex:new-session",
      event: "SessionStart",
      client: "codex",
      agent_pid: 43,
      terminal_pid: 8,
      wt_hwnd: "101",
      window_mapping: "exact",
      cwd: "C:\\work\\project",
      source: "clear",
      ts: 200,
    });

    assert.deepEqual(store.snapshot().map((session) => session.id), ["codex:new-session"]);

    // The periodic process scan still sees the original process identity.
    // It must enrich the real card instead of recreating the captured card.
    store.handleEvent({ ...captured, ts: 300 });
    assert.deepEqual(store.snapshot().map((session) => session.id), ["codex:new-session"]);
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

test("cycles attention sessions by input, error, then completed priority", () => {
  const store = new SessionStore();
  store.dispose();

  store.handleEvent({
    session_id: "working",
    event: "UserPromptSubmit",
    wt_hwnd: "100",
    ts: 50,
  });
  store.handleEvent({
    session_id: "error",
    event: "StopFailure",
    wt_hwnd: "101",
    ts: 100,
  });
  store.handleEvent({
    session_id: "waiting-older",
    event: "PermissionRequest",
    wt_hwnd: "102",
    ts: 200,
  });
  store.handleEvent({
    session_id: "waiting-newer",
    event: "PermissionRequest",
    wt_hwnd: "103",
    ts: 300,
  });
  store.handleEvent({
    session_id: "completed",
    event: "Stop",
    wt_hwnd: "104",
    ts: 400,
  });

  assert.equal(store.nextAttentionSession().id, "waiting-older");
  assert.equal(store.nextAttentionSession().id, "waiting-newer");
  assert.equal(store.nextAttentionSession().id, "error");
  assert.equal(store.nextAttentionSession().id, "completed");
  assert.equal(store.nextAttentionSession().id, "waiting-older");
});

test("deduplicates shared terminal windows and includes sessions without windows", () => {
  const store = new SessionStore();
  store.dispose();

  store.handleEvent({
    session_id: "shared-older",
    event: "PermissionRequest",
    wt_hwnd: "201",
    ts: 100,
  });
  store.handleEvent({
    session_id: "shared-newer",
    event: "PermissionRequest",
    wt_hwnd: "201",
    ts: 200,
  });
  store.handleEvent({
    session_id: "windowless-error",
    event: "StopFailure",
    ts: 300,
  });

  assert.equal(store.nextAttentionSession().id, "shared-older");
  const windowless = store.nextAttentionSession();
  assert.equal(windowless.id, "windowless-error");
  assert.equal(windowless.hasWindow, false);
  assert.equal(store.nextAttentionSession().id, "shared-older");
});

test("clears the attention cursor when no actionable sessions remain", () => {
  const store = new SessionStore();
  store.dispose();

  store.handleEvent({
    session_id: "waiting",
    event: "PermissionRequest",
    wt_hwnd: "301",
    ts: 100,
  });
  assert.equal(store.nextAttentionSession().id, "waiting");

  store.handleEvent({
    session_id: "waiting",
    event: "UserPromptSubmit",
    ts: 200,
  });
  assert.equal(store.nextAttentionSession(), null);

  store.handleEvent({
    session_id: "error",
    event: "StopFailure",
    wt_hwnd: "302",
    ts: 300,
  });
  assert.equal(store.nextAttentionSession().id, "error");
});

test("forwards focus options to the window activator", () => {
  const store = new SessionStore();
  store.dispose();
  const win32 = require("../src/main/win32");
  const realFocusWindow = win32.focusWindow;
  let focused = null;
  win32.focusWindow = (...args) => {
    focused = args;
    return { ok: true };
  };

  try {
    store.handleEvent({ session_id: "waiting", event: "PermissionRequest", wt_hwnd: "401" });
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const options = { reposition: false };

    assert.deepEqual(store.focus("waiting", workArea, options), { ok: true });
    assert.deepEqual(focused, ["401", workArea, options]);
  } finally {
    win32.focusWindow = realFocusWindow;
  }
});
