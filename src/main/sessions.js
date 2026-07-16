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

module.exports = { SessionStore };
