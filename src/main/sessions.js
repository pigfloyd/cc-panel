// sessions.js — SessionStore: hook events in, card snapshots out.
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
const ENDED_LINGER_MS = 15000; // keep ended cards briefly so the user sees them go

class SessionStore {
  constructor(onUpdate) {
    this.sessions = new Map();
    this.onUpdate = onUpdate || (() => {});
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
  }

  dispose() {
    clearInterval(this._pollTimer);
  }

  handleEvent(body) {
    if (!body || typeof body !== "object" || !body.session_id || !body.event) return;
    const id = body.session_id;
    const ts = Number(body.ts) || Date.now();

    let s = this.sessions.get(id);
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
        windowAlive: null,
        endedAt: null,
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
      s.windowAlive = true;
    }

    // async hooks can arrive out of order — drop stale state transitions
    if (ts < s.lastEventTs) return;
    s.lastEventTs = ts;
    s.endedAt = null; // any event revives an "ended" card

    if (body.event === "SessionEnd") {
      // /clear also ends the session (source="clear"); Claude Code then opens a
      // fresh session with a NEW session_id, so ending this card is correct — the
      // replacement is handled when that SessionStart arrives (see below).
      this._setTerminalState(s, "ended", ts);
      this._emit();
      return;
    }

    // /clear opens a new session (new session_id) on the same agent process.
    // Drop the predecessor card so the fresh session replaces it in place
    // instead of showing up as a duplicate.
    if (body.event === "SessionStart" && body.source === "clear" && s.agent_pid) {
      for (const [otherId, other] of this.sessions) {
        if (otherId !== id && other.agent_pid === s.agent_pid) this.sessions.delete(otherId);
      }
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
    }
    if (body.event === "Notification") s.message = body.message || null;
    else if (body.event !== "PreToolUse") s.message = null;
    if (s.state === "dead" || next !== s.state) this._setState(s, next, ts);

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

  _replaceCapturedSession(session, body) {
    const identity = {
      client: body.client || session.client,
      agent_pid: body.agent_pid || session.agent_pid,
      terminal_pid: body.terminal_pid || session.terminal_pid,
      wt_hwnd: body.wt_hwnd || session.wt_hwnd,
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
      uniqueMatch(captured, (other) => sameWindow(other.wt_hwnd, identity.wt_hwnd)) ||
      uniqueMatch(captured, (other) => sameCwd(other.cwd, identity.cwd));
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
      session.windowAlive = other.windowAlive;
    }
    this.sessions.delete(otherId);
  }

  _setState(s, state, ts) {
    s.state = state;
    s.stateSince = ts;
  }

  _setTerminalState(s, state, ts) {
    this._setState(s, state, ts);
    s.endedAt = ts;
  }

  _poll() {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (s.endedAt && now - s.endedAt > ENDED_LINGER_MS) {
        this.sessions.delete(id);
        changed = true;
        continue;
      }
      if (s.wt_hwnd) {
        const alive = win32.isWindowAlive(s.wt_hwnd);
        if (alive !== null && alive !== s.windowAlive) {
          s.windowAlive = alive;
          changed = true;

          if (!alive) {
            // Closing a completed terminal removes its card immediately. For
            // an active session, briefly show that the process disappeared.
            if (s.state === "done") {
              this.sessions.delete(id);
              continue;
            }
            if (s.state !== "ended" && s.state !== "dead") {
              this._setTerminalState(s, "dead", now);
            }
          }
        }
      }
      if (s.terminal_pid && s.state !== "ended" && s.state !== "dead") {
        if (!pidAlive(s.terminal_pid)) {
          // PowerShell and cmd may not yield a usable HWND. Their process is
          // still a reliable lifecycle signal when the console is closed.
          if (s.state === "done") {
            this.sessions.delete(id);
            changed = true;
            continue;
          }
          this._setTerminalState(s, "dead", now);
          changed = true;
        }
      }
      if (s.agent_pid && s.state !== "ended" && s.state !== "dead") {
        if (!pidAlive(s.agent_pid)) {
          this._setTerminalState(s, "dead", now);
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

function uniqueMatch(entries, predicate) {
  const matches = entries.filter(([, session]) => predicate(session));
  return matches.length === 1 ? matches[0] : null;
}

module.exports = { SessionStore };
