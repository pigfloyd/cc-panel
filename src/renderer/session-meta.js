(function initSessionMeta(root) {
  function clientLabel(session) {
    const client = String(session.client || "").toLowerCase();
    if (client === "codex" || String(session.id || "").startsWith("codex:")) return "Codex";
    if (client === "claude") return "Claude";
    return "Agent";
  }

  function compactDuration(milliseconds, language = "zh-CN") {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (language === "en") {
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.floor(hours / 24)}d`;
    }
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时`;
    return `${Math.floor(hours / 24)}天`;
  }

  function stateAgeLabel(session, now = Date.now(), language = "zh-CN") {
    const since = Number(session.stateSince);
    const age = Number.isFinite(since) ? now - since : 0;
    const duration = compactDuration(age, language);
    if (language === "en") return session.state === "working" ? `Running ${duration}` : `${duration} ago`;
    return session.state === "working" ? `运行 ${duration}` : `${duration}前`;
  }

  function sessionsWithTerminal(sessions) {
    if (!Array.isArray(sessions)) return [];
    return sessions.filter((session) => session && session.terminalPid);
  }

  const api = { clientLabel, compactDuration, stateAgeLabel, sessionsWithTerminal };
  root.sessionMeta = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
