(function initDemoData(root) {
  function createDemoSessions(now = Date.now()) {
    return [
      {
        id: "demo:cc-panel",
        client: "codex",
        project: "cc-panel",
        cwd: "C:\\workspace\\cc-panel",
        state: "working",
        stateSince: now - 38_000,
        terminalPid: 14001,
        currentTool: "Playwright · 正在验证 Demo 页面",
        lastPrompt: "为 GitHub 介绍页准备产品截图",
        hasWindow: true,
      },
      {
        id: "demo:docs-site",
        client: "claude",
        project: "docs-site",
        cwd: "C:\\workspace\\docs-site",
        state: "needs_input",
        stateSince: now - 92_000,
        terminalPid: 14002,
        message: "等待确认：允许执行 npm run build",
        lastPrompt: "更新快速开始和安装文档",
        hasWindow: true,
      },
      {
        id: "demo:api-gateway",
        client: "codex",
        project: "api-gateway",
        cwd: "C:\\workspace\\api-gateway",
        state: "done",
        stateSince: now - 4 * 60_000,
        terminalPid: 14003,
        lastPrompt: "补充鉴权缓存测试并更新变更说明",
        hasWindow: true,
      },
      {
        id: "demo:design-system",
        client: "claude",
        project: "design-system",
        cwd: "C:\\workspace\\design-system",
        state: "error",
        stateSince: now - 11 * 60_000,
        terminalPid: 14004,
        lastPrompt: "视觉回归测试发现 2 处基线差异",
        hasWindow: true,
      },
      {
        id: "demo:desktop-agent",
        client: "codex",
        project: "desktop-agent",
        cwd: "C:\\workspace\\desktop-agent",
        state: "idle",
        stateSince: now - 18 * 60_000,
        terminalPid: 14005,
        lastPrompt: "等待下一项任务",
        hasWindow: true,
      },
      {
        id: "demo:release-notes",
        client: "claude",
        project: "release-notes",
        cwd: "C:\\workspace\\release-notes",
        state: "idle",
        stateSince: now - 26 * 60_000,
        terminalPid: 14006,
        lastPrompt: "等待下一项任务",
        hasWindow: true,
      },
      {
        id: "demo:ops-toolkit",
        client: "codex",
        project: "ops-toolkit",
        cwd: "C:\\workspace\\ops-toolkit",
        state: "idle",
        stateSince: now - 41 * 60_000,
        terminalPid: 14007,
        lastPrompt: "等待下一项任务",
        hasWindow: true,
      },
    ];
  }

  const api = { createDemoSessions };
  root.demoData = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
