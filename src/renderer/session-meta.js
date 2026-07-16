(function initSessionMeta(root) {
  function clientLabel(session) {
    const client = String(session.client || "").toLowerCase();
    if (client === "codex" || String(session.id || "").startsWith("codex:")) return "Codex";
    if (client === "claude") return "Claude";
    return "Agent";
  }

  function compactDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时`;
    return `${Math.floor(hours / 24)}天`;
  }

  function stateAgeLabel(session, now = Date.now()) {
    const since = Number(session.stateSince);
    const age = Number.isFinite(since) ? now - since : 0;
    const duration = compactDuration(age);
    return session.state === "working" ? `运行 ${duration}` : `${duration}前`;
  }

  const api = { clientLabel, compactDuration, stateAgeLabel };
  root.sessionMeta = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
