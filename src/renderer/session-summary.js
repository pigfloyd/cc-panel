(function initSessionSummary(root) {
  function summarizeSessions(sessions) {
    const counts = {
      total: sessions.length,
      working: 0,
      needsInput: 0,
      error: 0,
    };

    for (const session of sessions) {
      if (session.state === "working") counts.working += 1;
      if (session.state === "needs_input") counts.needsInput += 1;
      if (session.state === "error") counts.error += 1;
    }

    const attention = counts.needsInput + counts.error;
    const state = counts.error > 0
      ? "error"
      : counts.needsInput > 0
        ? "needs_input"
        : counts.working > 0
          ? "working"
          : "idle";

    const parts = [];
    if (counts.error) parts.push(`${counts.error} 个出错`);
    if (counts.needsInput) parts.push(`${counts.needsInput} 个待处理`);
    if (counts.working) parts.push(`${counts.working} 个工作中`);

    return {
      ...counts,
      attention,
      state,
      title: counts.total ? `${counts.total} 个会话` : "暂无会话",
      detail: parts.slice(0, 2).join(" · ") || (counts.total ? "当前无运行任务" : "等待会话启动"),
    };
  }

  const api = { summarizeSessions };
  root.sessionSummary = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
