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
  Notification: "needs_input",
};

const POLL_MS = 5000;
const TRANSCRIPT_POLL_MS = 1000;
const MAX_TRANSCRIPT_READ_BYTES = 256 * 1024;
const SESSION_IDENTITY_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const SESSION_RESET_SOURCES = new Set(["clear", "new"]);

class SessionStore {
  constructor(onUpdate) {
    this.sessions = new Map();
    this.sessionAliases = new Map();
    this.onUpdate = onUpdate || (() => {});
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
        cwd: "",
        project: "",
        client: body.client || null,
        state: "idle",
        stateSince: ts,
        lastEventTs: 0,
        currentTool: null,
        lastPrompt: null,
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
        transcriptQuestionCalls: new Set(),
        transcriptQuestionSince: null,
        waitingForTranscriptQuestion: false,
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

    const next = EVENT_STATE[body.event];
    if (!next) return;

    if (body.event === "PreToolUse" || body.event === "PermissionRequest") {
      s.currentTool = body.tool_name || s.currentTool;
    } else if (body.event !== "UserPromptSubmit") {
      s.currentTool = null;
    }
    if (body.event === "UserPromptSubmit") {
      if (body.prompt_line) s.lastPrompt = body.prompt_line;
      s.message = null;
      s.currentTool = null;
      s.transcriptQuestionCalls.clear();
      s.transcriptQuestionSince = null;
      s.waitingForTranscriptQuestion = false;
    }
    if (body.event === "Notification") s.message = body.message || null;
    else if (body.event !== "PreToolUse") s.message = null;
    if (next !== s.state) this._setState(s, next, ts);

    this._emit();
  }

  focus(id, workArea) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, reason: "unknown_session" };
    if (!s.wt_hwnd) return { ok: false, reason: "no_hwnd" };
    const result = win32.focusWindow(s.wt_hwnd, workArea);
    if (result.reason === "gone") {
      s.windowAlive = false;
      this._emit();
    }
    return result;
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

    const [otherId] = match;
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

    // Process IDs are the strongest identity signals. HWND and cwd are useful
    // fallbacks when a hook runner is detached from the original process tree,
    // but only when exactly one captured card matches: Windows Terminal tabs
    // can share a window and several agents can run from the same directory.
    const match = uniqueMatch(captured, (other) => samePid(other.agent_pid, identity.agent_pid)) ||
      uniqueMatch(captured, (other) => samePid(other.terminal_pid, identity.terminal_pid)) ||
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
    this.sessions.delete(otherId);
  }

  _setState(s, state, ts) {
    s.state = state;
    s.stateSince = ts;
  }

  _trackTranscript(s, transcriptPath) {
    if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return;
    const resolved = path.resolve(transcriptPath.trim());
    if (s.transcriptPath === resolved) return;

    s.transcriptPath = resolved;
    s.transcriptOffset = transcriptSize(resolved);
    s.transcriptRemainder = "";
    s.transcriptQuestionCalls.clear();
    s.transcriptQuestionSince = null;
    s.waitingForTranscriptQuestion = false;
  }

  _pollTranscripts() {
    let changed = false;
    for (const s of this.sessions.values()) {
      if ((s.state !== "working" && s.state !== "needs_input") || !s.transcriptPath) continue;
      const wasWaitingForQuestion = s.waitingForTranscriptQuestion;
      const interruptedAt = readTranscriptInterruption(s);
      const waitingForQuestion = s.transcriptQuestionCalls.size > 0;

      if (waitingForQuestion !== wasWaitingForQuestion) {
        s.waitingForTranscriptQuestion = waitingForQuestion;
        const questionTs = Number(s.transcriptQuestionSince) || Date.now();
        if (waitingForQuestion && s.state === "working") {
          this._setState(s, "needs_input", Math.max(s.lastEventTs, questionTs));
        } else if (!waitingForQuestion && wasWaitingForQuestion && s.state === "needs_input") {
          this._setState(s, "working", Math.max(s.lastEventTs, Date.now()));
        }
        changed = true;
      }

      if (interruptedAt === null) continue;

      const ts = Math.max(interruptedAt, s.lastEventTs);
      s.lastEventTs = ts;
      s.turnStopped = true;
      s.currentTool = null;
      s.message = null;
      s.transcriptQuestionCalls.clear();
      s.transcriptQuestionSince = null;
      s.waitingForTranscriptQuestion = false;
      this._setState(s, "idle", ts);
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
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      project: s.project || "(unknown)",
      cwd: s.cwd,
      client: s.client,
      state: s.state,
      stateSince: s.stateSince,
      currentTool: s.currentTool,
      lastPrompt: s.lastPrompt,
      message: s.message,
      hasWindow: !!s.wt_hwnd && s.windowAlive !== false,
    }));
  }

  _emit() {
    this.onUpdate(this.snapshot());
  }
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

function readTranscriptInterruption(session) {
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

  let interruptedAt = null;
  for (const line of parts) {
    const parsed = parseTranscriptLine(line);
    updateTranscriptQuestionCalls(session, parsed);
    if (parsed.interruptedAt !== null) interruptedAt = parsed.interruptedAt;
  }

  // JSONL writers do not all append a final newline. Parse a complete trailing
  // object now, while retaining an incomplete object for the next poll.
  if (session.transcriptRemainder) {
    const parsed = parseTranscriptLine(session.transcriptRemainder);
    if (parsed.valid) session.transcriptRemainder = "";
    if (parsed.valid) updateTranscriptQuestionCalls(session, parsed);
    if (parsed.interruptedAt !== null) interruptedAt = parsed.interruptedAt;
  }
  return interruptedAt;
}

function transcriptInterruptionTimestamp(line) {
  return parseTranscriptLine(line).interruptedAt;
}

function parseTranscriptLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { valid: false, interruptedAt: null, questionStarted: null, questionFinished: null };
  }

  const payload = entry && entry.payload;
  const questionStarted = entry.type === "response_item" && payload &&
    payload.type === "function_call" && payload.name === "request_user_input" &&
    typeof payload.call_id === "string" ? payload.call_id : null;
  const questionFinished = entry.type === "response_item" && payload &&
    payload.type === "function_call_output" && typeof payload.call_id === "string"
    ? payload.call_id
    : null;

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
      questionStarted,
      questionFinished,
      timestamp: transcriptTimestamp(entry),
    };
  }

  return {
    valid: true,
    interruptedAt: transcriptTimestamp(entry),
    questionStarted,
    questionFinished,
    timestamp: transcriptTimestamp(entry),
  };
}

function updateTranscriptQuestionCalls(session, parsed) {
  if (parsed.questionStarted) {
    if (session.transcriptQuestionCalls.size === 0) {
      session.transcriptQuestionSince = parsed.timestamp;
    }
    session.transcriptQuestionCalls.add(parsed.questionStarted);
  }
  if (parsed.questionFinished && session.transcriptQuestionCalls.delete(parsed.questionFinished) &&
      session.transcriptQuestionCalls.size === 0) {
    session.transcriptQuestionSince = null;
  }
}

function transcriptTimestamp(entry) {
  const timestamp = Date.parse(entry && entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

module.exports = { SessionStore, transcriptInterruptionTimestamp };
