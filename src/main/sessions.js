// sessions.js — SessionStore: hook events in, card snapshots out.
const fs = require("fs");
const path = require("path");
const win32 = require("./win32");

const EVENT_STATE = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PermissionRequest: "needs_input",
  Stop: "done",
  StopFailure: "error",
  PostToolUseFailure: "error",
};

const NOTIFICATION_STATE = {
  permission_prompt: "needs_input",
  elicitation_dialog: "needs_input",
  agent_needs_input: "needs_input",
  idle_prompt: "done",
  elicitation_complete: "working",
  elicitation_response: "working",
};

const POLL_MS = 5000;
const TRANSCRIPT_POLL_MS = 1000;
const MAX_TRANSCRIPT_READ_BYTES = 256 * 1024;
const SESSION_IDENTITY_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const SESSION_RESET_SOURCES = new Set(["clear", "new"]);
const ATTENTION_STATES = new Set(["needs_input", "error", "done"]);
const ATTENTION_STATE_PRIORITY = { needs_input: 0, error: 1, done: 2 };

class SessionStore {
  constructor(onUpdate, onStateTransition) {
    this.sessions = new Map();
    this.sessionAliases = new Map();
    this.nextCardKey = 1;
    this.attentionCursorKey = null;
    this.onUpdate = onUpdate || (() => {});
    this.onStateTransition = onStateTransition || (() => {});
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
    this._transcriptTimer = setInterval(() => this._pollTranscripts(), TRANSCRIPT_POLL_MS);
  }

  dispose() {
    clearInterval(this._pollTimer);
    clearInterval(this._transcriptTimer);
  }

  handleEvent(body) {
    if (!body || typeof body !== "object" || !body.session_id || !body.event) return;
    const rawId = body.session_id;
    const ts = Number(body.ts) || Date.now();
    const notificationState = body.event === "Notification"
      ? NOTIFICATION_STATE[String(body.notification_type || "").toLowerCase()]
      : null;
    // Authentication and background-agent completion notifications are
    // informational and must not overwrite the main session lifecycle.
    if (body.event === "Notification" && !notificationState) return;

    // Process discovery runs repeatedly as a fallback for missing hooks. If a
    // real hook card already represents this process, enrich that card instead
    // of adding a second captured card or resetting its state to idle.
    if (body.captured) {
      const known = this._findRealSessionForCapture(body);
      if (known) {
        if (this._mergeCapturedIdentity(known, body)) this._emit();
        return;
      }
    }

    let id = this._resolveSessionId(rawId);
    let s = this.sessions.get(id);
    if (!s && !body.captured && SESSION_IDENTITY_EVENTS.has(body.event)) {
      s = this._adoptMappedSession(rawId, body, ts);
      if (s) id = s.id;
    }
    if (s && rawId !== id && ts < s.lastEventTs) return;
    if (!s) {
      // A late/out-of-order SessionEnd for a session we never tracked must not
      // resurrect a card — async hooks can deliver end before start.
      if (body.event === "SessionEnd") return;
      s = {
        id,
        cardKey: `card:${this.nextCardKey++}`,
        cwd: "",
        project: "",
        client: body.client || null,
        state: "idle",
        stateSince: ts,
        lastEventTs: 0,
        currentTool: null,
        message: null,
        agent_pid: null,
        terminal_pid: null,
        wt_hwnd: null,
        windowMapping: null,
        windowAlive: null,
        turnStopped: false,
        transcriptPath: null,
        transcriptOffset: null,
        transcriptRemainder: "",
        transcriptInputCalls: new Set(),
        transcriptInputSince: null,
        waitingForTranscriptInput: false,
      };
      this.sessions.set(id, s);
    }

    // Startup discovery has no native session ID. Once an agent emits a real
    // hook event, replace its temporary card instead of showing two cards.
    // Depending on the CLI launcher, startup capture and the hook can identify
    // different wrapper processes as the agent. Reconcile the real session
    // against the temporary card using all safe mapping signals.
    if (!body.captured) this._replaceCapturedSession(s, body);

    // Mapping fields are always merged, even from out-of-order events.
    if (body.cwd) {
      s.cwd = body.cwd;
      s.project = path.basename(body.cwd) || body.cwd;
    }
    if (body.client) s.client = body.client;
    if (body.agent_pid) s.agent_pid = body.agent_pid;
    if (body.terminal_pid) s.terminal_pid = body.terminal_pid;
    if (body.wt_hwnd) {
      s.wt_hwnd = String(body.wt_hwnd);
      s.windowMapping = mergeWindowMapping(s.windowMapping, body.window_mapping);
      s.windowAlive = true;
    }
    const transcriptPath = body.transcript_path || body.transcriptPath;
    if (transcriptPath) this._trackTranscript(s, transcriptPath);

    // async hooks can arrive out of order — drop stale state transitions
    if (ts < s.lastEventTs) return;
    s.lastEventTs = ts;
    s.turnStopped = body.event === "Stop";

    if (body.event === "SessionEnd") {
      this._deleteSession(id);
      this._emit();
      return;
    }

    // /clear and /new open a new session with a new ID. Replace its
    // predecessor rather than rendering a second card for the same terminal.
    // PID matching is preferred; a unique window/cwd match covers hook
    // snapshots that miss the new process ID during a restart.
    if (body.event === "SessionStart" &&
        SESSION_RESET_SOURCES.has(String(body.source || "").toLowerCase())) {
      this._replaceResetSession(s);
    }

    const next = notificationState || EVENT_STATE[body.event];
    if (!next) return;

    if (body.event === "PreToolUse" || body.event === "PermissionRequest") {
      s.currentTool = body.tool_name || s.currentTool;
    } else if (body.event !== "UserPromptSubmit") {
      s.currentTool = null;
    }
    if (body.event === "UserPromptSubmit") {
      s.message = null;
      s.currentTool = null;
      s.transcriptInputCalls.clear();
      s.transcriptInputSince = null;
      s.waitingForTranscriptInput = false;
    }
    if (body.event === "Notification" && next === "needs_input") s.message = body.message || null;
    else if (body.event !== "PreToolUse") s.message = null;
    const effectiveNext = next === "working" && s.transcriptInputCalls.size > 0
      ? "needs_input"
      : next;
    if (effectiveNext !== s.state) this._setState(s, effectiveNext, ts);

    this._emit();
  }

  focus(id, workArea, options) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, reason: "unknown_session" };
    if (!s.wt_hwnd) return { ok: false, reason: "no_hwnd" };
    const result = win32.focusWindow(s.wt_hwnd, workArea, options);
    if (result.reason === "gone") {
      s.windowAlive = false;
      this._emit();
    }
    return result;
  }

  nextAttentionSession() {
    const ordered = [...this.sessions.values()]
      .filter((session) => ATTENTION_STATES.has(session.state))
      .sort(compareAttentionSessions);
    const candidates = [];
    const seenTargets = new Set();

    for (const session of ordered) {
      const targetKey = attentionTargetKey(session);
      if (seenTargets.has(targetKey)) continue;
      seenTargets.add(targetKey);
      candidates.push({ session, targetKey });
    }

    if (!candidates.length) {
      this.attentionCursorKey = null;
      return null;
    }

    const currentIndex = candidates.findIndex(({ targetKey }) => (
      targetKey === this.attentionCursorKey
    ));
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % candidates.length;
    const next = candidates[nextIndex];
    this.attentionCursorKey = next.targetKey;
    return sessionSnapshot(next.session);
  }

  minimizeAll() {
    const handles = new Set();
    for (const s of this.sessions.values()) {
      if (s.wt_hwnd && s.windowAlive !== false) handles.add(s.wt_hwnd);
    }

    let minimized = 0;
    for (const hwnd of handles) {
      const result = win32.minimizeWindow(hwnd);
      if (result.ok) minimized += 1;
    }
    return { ok: true, minimized };
  }

  _resolveSessionId(id) {
    let current = id;
    const seen = new Set();
    while (this.sessionAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.sessionAliases.get(current);
    }
    return current;
  }

  _adoptMappedSession(rawId, body, ts) {
    const candidates = [...this.sessions.entries()].filter(([otherId, other]) => {
      if (otherId.startsWith("captured:")) return false;
      if (!sameClient(other.client, body.client)) return false;
      if (sameWindow(other.wt_hwnd, body.wt_hwnd) &&
          other.windowMapping === "exact" && body.window_mapping === "exact") return true;
      if (samePid(other.agent_pid, body.agent_pid)) return true;
      return samePid(other.terminal_pid, body.terminal_pid) &&
        (!other.wt_hwnd || !body.wt_hwnd || sameWindow(other.wt_hwnd, body.wt_hwnd));
    });
    if (!candidates.length) return null;

    candidates.sort((left, right) => right[1].lastEventTs - left[1].lastEventTs);
    const [primaryId, primary] = candidates[0];
    let canonicalId = primaryId;

    // A stale event from an older hook ID must not rename the current card.
    // Newer lifecycle events move the card to the latest real session ID.
    if (ts >= primary.lastEventTs && rawId !== primaryId) {
      this.sessions.delete(primaryId);
      this.sessionAliases.delete(rawId);
      this.sessionAliases.set(primaryId, rawId);
      primary.id = rawId;
      canonicalId = rawId;
      this.sessions.set(canonicalId, primary);
    } else if (rawId !== primaryId) {
      this.sessionAliases.set(rawId, primaryId);
    }

    // Collapse any duplicates already created for the same process or shell.
    // Their IDs remain aliases so late async hooks still update this card.
    for (const [otherId] of candidates.slice(1)) {
      this.sessions.delete(otherId);
      if (otherId !== canonicalId) this.sessionAliases.set(otherId, canonicalId);
    }
    return primary;
  }

  _findRealSessionForCapture(body) {
    const candidates = [...this.sessions.entries()].filter(([id, session]) =>
      !id.startsWith("captured:") && sameClient(session.client, body.client)
    );
    const match = uniqueMatch(candidates, (session) => samePid(session.agent_pid, body.agent_pid)) ||
      uniqueMatch(candidates, (session) => samePid(session.terminal_pid, body.terminal_pid)) ||
      uniqueMatch(candidates, (session) =>
        sameWindow(session.wt_hwnd, body.wt_hwnd) &&
        session.windowMapping === "exact" && body.window_mapping === "exact"
      ) ||
      uniqueMatch(candidates, (session) =>
        sameWindow(session.wt_hwnd, body.wt_hwnd) && identitiesDoNotConflict(session, body)
      ) ||
      uniqueMatch(candidates, (session) =>
        sameCwd(session.cwd, body.cwd) && identitiesDoNotConflict(session, body)
      );
    return match ? match[1] : null;
  }

  _mergeCapturedIdentity(session, body) {
    let changed = false;
    if (!session.cwd && body.cwd) {
      session.cwd = body.cwd;
      session.project = path.basename(body.cwd) || body.cwd;
      changed = true;
    }
    if (!session.client && body.client) {
      session.client = body.client;
      changed = true;
    }
    if (!session.agent_pid && body.agent_pid) {
      session.agent_pid = body.agent_pid;
      changed = true;
    }
    if (!session.terminal_pid && body.terminal_pid) {
      session.terminal_pid = body.terminal_pid;
      changed = true;
    }

    const exactUpgrade = body.wt_hwnd && body.window_mapping === "exact" &&
      session.windowMapping !== "exact";
    if (body.wt_hwnd && (!session.wt_hwnd || exactUpgrade)) {
      session.wt_hwnd = String(body.wt_hwnd);
      session.windowMapping = mergeWindowMapping(session.windowMapping, body.window_mapping);
      changed = true;
    }
    if (body.wt_hwnd && sameWindow(session.wt_hwnd, body.wt_hwnd) && session.windowAlive !== true) {
      session.windowAlive = true;
      changed = true;
    }
    return changed;
  }

  _deleteSession(id) {
    this.sessions.delete(id);
    for (const [alias] of this.sessionAliases) {
      if (alias === id || this._resolveSessionId(alias) === id) {
        this.sessionAliases.delete(alias);
      }
    }
  }

  _replaceResetSession(session) {
    const candidates = [...this.sessions.entries()].filter(([otherId, other]) => {
      if (otherId === session.id || otherId.startsWith("captured:")) return false;
      if (!sameClient(other.client, session.client)) return false;
      return samePid(other.agent_pid, session.agent_pid) ||
        samePid(other.terminal_pid, session.terminal_pid);
    });

    let match = candidates.length === 1 ? candidates[0] : null;
    if (!match) {
      match = uniqueMatch(
        [...this.sessions.entries()].filter(([otherId, other]) =>
          otherId !== session.id &&
          !otherId.startsWith("captured:") &&
          sameClient(other.client, session.client)
        ),
        (other) => sameWindow(other.wt_hwnd, session.wt_hwnd) && sameCwd(other.cwd, session.cwd)
      );
    }
    if (!match) return;

    const [otherId, other] = match;
    session.cardKey = other.cardKey;
    this.sessions.delete(otherId);
    this.sessionAliases.set(otherId, session.id);
  }

  _replaceCapturedSession(session, body) {
    const identity = {
      client: body.client || session.client,
      agent_pid: body.agent_pid || session.agent_pid,
      terminal_pid: body.terminal_pid || session.terminal_pid,
      wt_hwnd: body.wt_hwnd || session.wt_hwnd,
      window_mapping: body.window_mapping || session.windowMapping,
      cwd: body.cwd || session.cwd,
    };
    const captured = [...this.sessions.entries()].filter(([otherId, other]) =>
      otherId !== session.id &&
      otherId.startsWith("captured:") &&
      sameClient(other.client, identity.client)
    );

    // Process IDs are the strongest identity signals. An exact mapping proves
    // that both snapshots belong to the same terminal window even when hook
    // runners report different wrapper processes. Other HWND and cwd matches
    // remain conflict-checked because foreground/fallback mappings can be
    // shared by multiple agents.
    const match = uniqueMatch(captured, (other) => samePid(other.agent_pid, identity.agent_pid)) ||
      uniqueMatch(captured, (other) => samePid(other.terminal_pid, identity.terminal_pid)) ||
      uniqueMatch(captured, (other) =>
        sameWindow(other.wt_hwnd, identity.wt_hwnd) &&
        other.windowMapping === "exact" && identity.window_mapping === "exact"
      ) ||
      uniqueMatch(captured, (other) =>
        sameWindow(other.wt_hwnd, identity.wt_hwnd) &&
        identitiesDoNotConflict(other, identity, ["agent_pid", "terminal_pid"])
      ) ||
      uniqueMatch(captured, (other) =>
        sameCwd(other.cwd, identity.cwd) && identitiesDoNotConflict(other, identity)
      );
    if (!match) return;

    const [otherId, other] = match;
    // Retain startup-only mapping details if this hook snapshot could not
    // resolve every field, then remove the temporary card. An agent PID is
    // process-scoped, so only inherit it while that captured process is still
    // alive. This matters when Codex is restarted in the same terminal: the
    // new session must not be polled against the exited Codex process.
    if (!session.cwd && other.cwd) {
      session.cwd = other.cwd;
      session.project = other.project;
    }
    if (!session.client && other.client) session.client = other.client;
    if (!session.agent_pid && other.agent_pid && pidAlive(other.agent_pid)) {
      session.agent_pid = other.agent_pid;
    }
    if (!session.terminal_pid && other.terminal_pid) session.terminal_pid = other.terminal_pid;
    if (!session.wt_hwnd && other.wt_hwnd) {
      session.wt_hwnd = other.wt_hwnd;
      session.windowMapping = other.windowMapping;
      session.windowAlive = other.windowAlive;
    }
    session.cardKey = other.cardKey;
    this.sessions.delete(otherId);
  }

  _setState(s, state, ts) {
    const previousState = s.state;
    if (state === previousState) return false;
    s.state = state;
    s.stateSince = ts;
    this.onStateTransition({
      id: s.id,
      cardKey: s.cardKey,
      previousState,
      state,
      stateSince: ts,
    });
    return true;
  }

  _trackTranscript(s, transcriptPath) {
    if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return;
    const resolved = path.resolve(transcriptPath.trim());
    if (s.transcriptPath === resolved) return;

    s.transcriptPath = resolved;
    s.transcriptOffset = transcriptSize(resolved);
    s.transcriptRemainder = "";
    s.transcriptInputCalls.clear();
    s.transcriptInputSince = null;
    s.waitingForTranscriptInput = false;
  }

  _pollTranscripts() {
    let changed = false;
    for (const s of this.sessions.values()) {
      if ((s.state !== "working" && s.state !== "needs_input") || !s.transcriptPath) continue;
      const wasWaitingForInput = s.waitingForTranscriptInput;
      const terminalOutcome = readTranscriptOutcome(s);
      const waitingForInput = s.transcriptInputCalls.size > 0;

      if (waitingForInput !== wasWaitingForInput) {
        s.waitingForTranscriptInput = waitingForInput;
        changed = true;
      }

      // Hook delivery and transcript polling are asynchronous. Keep input
      // requests authoritative until their matching result reaches the
      // transcript, even if another tool hook reports that work is in progress.
      if (waitingForInput && s.state === "working") {
        const inputTs = Number(s.transcriptInputSince) || Date.now();
        this._setState(s, "needs_input", Math.max(s.lastEventTs, inputTs));
        changed = true;
      } else if (!waitingForInput && wasWaitingForInput && s.state === "needs_input") {
        this._setState(s, "working", Math.max(s.lastEventTs, Date.now()));
        changed = true;
      }

      if (terminalOutcome === null) continue;

      const ts = Math.max(terminalOutcome.timestamp, s.lastEventTs);
      s.lastEventTs = ts;
      s.turnStopped = true;
      s.currentTool = null;
      s.message = null;
      s.transcriptInputCalls.clear();
      s.transcriptInputSince = null;
      s.waitingForTranscriptInput = false;
      this._setState(s, terminalOutcome.state, ts);
      changed = true;
    }
    if (changed) this._emit();
  }

  _poll() {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (s.wt_hwnd) {
        const alive = win32.isWindowAlive(s.wt_hwnd);
        if (alive !== null && alive !== s.windowAlive) {
          s.windowAlive = alive;
          changed = true;

          if (!alive) {
            this._deleteSession(id);
            continue;
          }
        }
      }
      if (s.terminal_pid) {
        if (!pidAlive(s.terminal_pid)) {
          // PowerShell and cmd may not yield a usable HWND. Their process is
          // still a reliable lifecycle signal when the console is closed.
          this._deleteSession(id);
          changed = true;
          continue;
        }
      }
      if (s.agent_pid) {
        if (!pidAlive(s.agent_pid)) {
          this._deleteSession(id);
          changed = true;
        }
      }
    }
    if (changed) this._emit();
  }

  snapshot() {
    return [...this.sessions.values()].map(sessionSnapshot);
  }

  _emit() {
    this.onUpdate(this.snapshot());
  }
}

function compareAttentionSessions(left, right) {
  const priority = ATTENTION_STATE_PRIORITY[left.state] - ATTENTION_STATE_PRIORITY[right.state];
  if (priority !== 0) return priority;
  return Number(left.stateSince || 0) - Number(right.stateSince || 0);
}

function attentionTargetKey(session) {
  if (session.wt_hwnd && session.windowAlive !== false) return `window:${session.wt_hwnd}`;
  return `session:${session.cardKey || session.id}`;
}

function sessionSnapshot(s) {
  return {
    id: s.id,
    cardKey: s.cardKey,
    project: s.project || "(unknown)",
    cwd: s.cwd,
    client: s.client,
    state: s.state,
    stateSince: s.stateSince,
    currentTool: s.currentTool,
    message: s.message,
    terminalPid: s.terminal_pid,
    hasWindow: !!s.wt_hwnd && s.windowAlive !== false,
  };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // access denied means it exists
  }
}

function samePid(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isInteger(a) && a > 0 && Number.isInteger(b) && b > 0 && a === b;
}

function sameClient(left, right) {
  if (!left || !right) return true;
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function sameWindow(left, right) {
  if (!left || !right) return false;
  return String(left) === String(right);
}

function sameCwd(left, right) {
  const a = normalizeCwd(left);
  const b = normalizeCwd(right);
  return !!a && !!b && a === b;
}

function normalizeCwd(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const normalized = path.win32.normalize(value.trim()).toLowerCase();
  const root = path.win32.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
}

function mergeWindowMapping(current, incoming) {
  if (current === "exact" || incoming === "exact") return "exact";
  return incoming || current || null;
}

function identitiesDoNotConflict(left, right, fields = ["agent_pid", "terminal_pid", "wt_hwnd"]) {
  return fields.every((field) => {
    if (!left[field] || !right[field]) return true;
    if (field === "wt_hwnd") return sameWindow(left[field], right[field]);
    return samePid(left[field], right[field]);
  });
}

function uniqueMatch(entries, predicate) {
  const matches = entries.filter(([, session]) => predicate(session));
  return matches.length === 1 ? matches[0] : null;
}

function transcriptSize(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function readTranscriptOutcome(session) {
  const size = transcriptSize(session.transcriptPath);
  if (size === null) return null;
  if (session.transcriptOffset === null || size < session.transcriptOffset) {
    session.transcriptOffset = size;
    session.transcriptRemainder = "";
    return null;
  }
  if (size === session.transcriptOffset) return null;

  const start = Math.max(session.transcriptOffset, size - MAX_TRANSCRIPT_READ_BYTES);
  const skipped = start > session.transcriptOffset;
  const buffer = Buffer.allocUnsafe(size - start);
  let fd;
  let bytesRead = 0;
  try {
    fd = fs.openSync(session.transcriptPath, "r");
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  session.transcriptOffset = start + bytesRead;
  const text = buffer.subarray(0, bytesRead).toString("utf8");
  const parts = `${skipped ? "" : session.transcriptRemainder}${text}`.split(/\r?\n/);
  if (skipped) parts.shift();
  session.transcriptRemainder = parts.pop() || "";

  let terminalOutcome = null;
  for (const line of parts) {
    const parsed = parseTranscriptLine(line);
    updateTranscriptInputCalls(session, parsed);
    terminalOutcome = nextTranscriptOutcome(terminalOutcome, parsed);
  }

  // JSONL writers do not all append a final newline. Parse a complete trailing
  // object now, while retaining an incomplete object for the next poll.
  if (session.transcriptRemainder) {
    const parsed = parseTranscriptLine(session.transcriptRemainder);
    if (parsed.valid) session.transcriptRemainder = "";
    if (parsed.valid) updateTranscriptInputCalls(session, parsed);
    terminalOutcome = nextTranscriptOutcome(terminalOutcome, parsed);
  }
  return terminalOutcome;
}

function transcriptInterruptionTimestamp(line) {
  return parseTranscriptLine(line).interruptedAt;
}

function parseTranscriptLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return {
      valid: false,
      interruptedAt: null,
      errorAt: null,
      turnStarted: false,
      inputStarted: null,
      approvalStarted: null,
      inputFinished: null,
    };
  }

  const payload = entry && entry.payload;
  const turnStarted = entry.type === "event_msg" && payload && payload.type === "task_started";
  const taskFailed = entry.type === "event_msg" && payload &&
    payload.type === "task_complete" && !!payload.error;
  const approvalStarted = isCodexApprovalCall(payload) ? payload.call_id : null;
  const inputStarted = (isCodexInputCall(payload) || approvalStarted) ? payload.call_id : null;
  const inputFinished = entry.type === "response_item" && payload &&
    (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") &&
    typeof payload.call_id === "string" ? payload.call_id : null;

  const codexInterrupted = entry && entry.type === "event_msg" &&
    payload && payload.type === "turn_aborted";
  const claudeContent = entry && entry.type === "user" && entry.message && entry.message.content;
  // Claude Code writes two interrupt string variants depending on context:
  // 1. Plain Ctrl+C:      "[Requête   interrompue  par l'utilisateur]"
  // 2. Tool-use interrupt: "[Requête interrompue par l'utilisateur  pour  utilisation  d'outil]"
  // Older / English-locale builds used:  "[Request interrupted by user]"
  const isInterruptText = (text) =>
    text === "[Requête   interrompue  par l'utilisateur]" ||
    text === "[Requête interrompue par l'utilisateur  pour  utilisation  d'outil]" ||
    text === "[Request interrupted by user]";

  const claudeInterrupted = (Array.isArray(claudeContent) && claudeContent.some((item) =>
    item && item.type === "text" && isInterruptText(item.text)
  )) || (typeof claudeContent === "string" && isInterruptText(claudeContent));
  if (!codexInterrupted && !claudeInterrupted) {
    return {
      valid: true,
      interruptedAt: null,
      errorAt: taskFailed ? transcriptTimestamp(entry) : null,
      turnStarted,
      inputStarted,
      approvalStarted,
      inputFinished,
      timestamp: transcriptTimestamp(entry),
    };
  }

  return {
    valid: true,
    interruptedAt: transcriptTimestamp(entry),
    errorAt: null,
    turnStarted,
    inputStarted,
    approvalStarted,
    inputFinished,
    timestamp: transcriptTimestamp(entry),
  };
}

function nextTranscriptOutcome(current, parsed) {
  if (!parsed.valid) return current;
  // Polling can lag behind hooks. A newer turn start makes a terminal record
  // from the previous turn stale, so do not apply it to the active turn.
  if (parsed.turnStarted) return null;
  if (parsed.errorAt !== null) return { state: "error", timestamp: parsed.errorAt };
  if (parsed.interruptedAt !== null) return { state: "idle", timestamp: parsed.interruptedAt };
  return current;
}

function isCodexInputCall(payload) {
  if (!payload || typeof payload.call_id !== "string") return false;
  return payload.type === "function_call" && payload.name === "request_user_input";
}

function isCodexApprovalCall(payload) {
  if (!payload || typeof payload.call_id !== "string") return false;
  if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return false;

  const input = typeof payload.input === "string"
    ? payload.input
    : typeof payload.arguments === "string" ? payload.arguments : "";
  return /sandbox_permissions[\"']?\s*:\s*[\"']require_escalated[\"']/.test(input);
}

function updateTranscriptInputCalls(session, parsed) {
  if (parsed.inputStarted) {
    if (session.transcriptInputCalls.size === 0) {
      session.transcriptInputSince = parsed.timestamp;
    }
    session.transcriptInputCalls.add(parsed.inputStarted);
  }
  if (parsed.inputFinished) {
    if (session.transcriptInputCalls.delete(parsed.inputFinished) &&
        session.transcriptInputCalls.size === 0) {
      session.transcriptInputSince = null;
    }
  }
}

function transcriptTimestamp(entry) {
  const timestamp = Date.parse(entry && entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

module.exports = { SessionStore, transcriptInterruptionTimestamp };
