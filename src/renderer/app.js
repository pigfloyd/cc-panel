// app.js — renderer: render session cards, handle clicks and settings.
// transitions worth interrupting the user for
const NOTIFY_STATES = new Set(["needs_input", "done", "error"]);
const STATE_LABELS = {
  working: "进行中",
  needs_input: "待输入",
  done: "已完成",
  error: "异常",
  idle: "空闲",
};
const orderSessions = createStableSessionOrder();
const { clientLabel, stateAgeLabel } = sessionMeta;
const query = new URLSearchParams(window.location.search);
const isDemoMode = query.get("demo") === "1";
const IDLE_STACK_COLLAPSE_DELAY_MS = 3000;
const WORKING_LIGHT_CYCLE_MS = 2400;
document.body.classList.toggle("demo-mode", isDemoMode);

const els = {
  cards: document.getElementById("cards"),
  empty: document.getElementById("empty"),
  toast: document.getElementById("toast"),
  newTerminalControl: document.querySelector(".new-terminal-control"),
  terminalHistoryMenu: document.getElementById("terminal-history-menu"),
  btnClaudeTerminal: document.getElementById("btn-claude-terminal"),
  btnCodexTerminal: document.getElementById("btn-codex-terminal"),
  btnCollapseTerminals: document.getElementById("btn-collapse-terminals"),
  btnSettings: document.getElementById("btn-settings"),
  settingsPanel: document.getElementById("settings-panel"),
  settingAlwaysOnTop: document.getElementById("setting-always-on-top"),
  settingSound: document.getElementById("setting-sound"),
  settingPromptSummary: document.getElementById("setting-prompt-summary"),
  settingAutoLaunch: document.getElementById("setting-auto-launch"),
  settingTerminalExecutable: document.getElementById("setting-terminal-executable"),
  hookLastEvent: document.getElementById("hook-last-event"),
  hookEventService: document.getElementById("hook-event-service"),
  claudeHookStatus: document.getElementById("claude-hook-status"),
  codexHookStatus: document.getElementById("codex-hook-status"),
  codexTrustStatus: document.getElementById("codex-trust-status"),
  hookFallbackMode: document.getElementById("hook-fallback-mode"),
  btnHookInspect: document.getElementById("btn-hook-inspect"),
  btnHookInstall: document.getElementById("btn-hook-install"),
  btnHookHelp: document.getElementById("btn-hook-help"),
  btnHookUninstall: document.getElementById("btn-hook-uninstall"),
  hookResolution: document.getElementById("hook-resolution"),
  hookResolutionTitle: document.getElementById("hook-resolution-title"),
  hookResolutionMessage: document.getElementById("hook-resolution-message"),
  codexTrustActions: document.getElementById("codex-trust-actions"),
  btnOpenCodexTrust: document.getElementById("btn-open-codex-trust"),
  btnCopyHooksCommand: document.getElementById("btn-copy-hooks-command"),
  btnCheckCodexTrust: document.getElementById("btn-check-codex-trust"),
  onboarding: document.getElementById("onboarding"),
  onboardingStepDiscover: document.getElementById("onboarding-step-discover"),
  onboardingStepHooks: document.getElementById("onboarding-step-hooks"),
  onboardingStepTrust: document.getElementById("onboarding-step-trust"),
  onboardingStepTest: document.getElementById("onboarding-step-test"),
  onboardingDiscoverDetail: document.getElementById("onboarding-discover-detail"),
  onboardingHooksDetail: document.getElementById("onboarding-hooks-detail"),
  onboardingTrustDetail: document.getElementById("onboarding-trust-detail"),
  onboardingTestDetail: document.getElementById("onboarding-test-detail"),
  onboardingTrustHelp: document.getElementById("onboarding-trust-help"),
  onboardingFinish: document.getElementById("onboarding-finish"),
  btnOnboardingOpenCodex: document.getElementById("btn-onboarding-open-codex"),
  btnOnboardingCopyHooks: document.getElementById("btn-onboarding-copy-hooks"),
  btnOnboardingRetry: document.getElementById("btn-onboarding-retry"),
  btnOnboardingClose: document.getElementById("btn-onboarding-close"),
};

let sessions = [];
let prevStates = new Map();
let cfg = {
  alwaysOnTop: true,
  sound: false,
  showPromptSummary: true,
  autoLaunch: true,
  terminalCommand: "claude",
  terminalExecutable: null,
  terminalHistory: [],
};
let toastTimer = null;
let terminalApps = [];
let terminalScanPromise = null;
let terminalHistoryCommand = null;
let terminalHistoryCloseTimer = null;
let idleStackCollapseTimer = null;
let idleStackExpanded = false;
let idleStackInitialized = false;
let hookInstallStatus = null;
let hookHelpOpen = false;
let hookOperationPending = false;
let onboardingPending = false;
let onboardingPollTimer = null;
const BROWSE_TERMINAL_VALUE = "__browse__";

let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === "closed") _audioCtx = new AudioContext();
  return _audioCtx;
}

function beep() {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain).connect(ctx.destination);
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  osc.start();
  osc.stop(ctx.currentTime + 0.35);
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2500);
}

function applyConfigResult(result) {
  if (result && result.config) cfg = result.config;
  refreshConfigButtons();
  if (result && result.ok) return true;
  showToast(result && result.reason === "config_write_failed"
    ? "设置未保存，请检查磁盘权限或文件占用"
    : "设置未保存，请重试");
  return false;
}

async function saveSetting(patch) {
  try {
    return applyConfigResult(await window.ccPanel.setConfig(patch));
  } catch {
    refreshConfigButtons();
    showToast("设置未保存，请重试");
    return false;
  }
}

function detailText(s) {
  if (s.state === "needs_input" && s.message) return s.message;
  if (s.state === "working" && s.currentTool) return `工具：${s.currentTool}`;
  if (cfg.showPromptSummary !== false && s.lastPrompt) return s.lastPrompt;
  return "";
}

function onboardingClientNames(detected) {
  const names = [];
  if (detected && detected.claude) names.push("Claude");
  if (detected && detected.codex) names.push("Codex");
  return names;
}

function setOnboardingStep(element, number, ok, pending = false) {
  element.dataset.state = pending ? "pending" : ok ? "done" : "attention";
  element.querySelector(".onboarding-step-marker").textContent = ok ? "\u2713" : String(number);
}

function scheduleOnboardingPoll(status) {
  clearTimeout(onboardingPollTimer);
  onboardingPollTimer = null;
  if (els.onboarding.classList.contains("hidden") || status.ready || onboardingPending) return;
  onboardingPollTimer = setTimeout(() => void runOnboardingChecks(true), 3000);
}

function renderOnboarding(status) {
  if (!status) return;
  const steps = status.steps || {};
  const detectedNames = onboardingClientNames(status.detected);
  setOnboardingStep(els.onboardingStepDiscover, 1, !!(steps.discover && steps.discover.ok));
  setOnboardingStep(els.onboardingStepHooks, 2, !!(steps.hooks && steps.hooks.ok));
  setOnboardingStep(els.onboardingStepTrust, 3, !!(steps.trust && steps.trust.ok));
  setOnboardingStep(els.onboardingStepTest, 4, !!(steps.test && steps.test.ok));
  els.onboardingDiscoverDetail.textContent = detectedNames.length
    ? `已发现 ${detectedNames.join("、")}`
    : "未发现 Claude 或 Codex 命令";
  els.onboardingHooksDetail.textContent = steps.hooks && steps.hooks.ok
    ? "已为发现的客户端安装"
    : "Hook 未安装完整，将自动重试";
  const trustRequired = !!(steps.trust && steps.trust.required);
  els.onboardingTrustDetail.textContent = !trustRequired
    ? "未发现 Codex，已跳过"
    : steps.trust.ok ? "Codex Hook 已信任" : "等待在 Codex 中确认信任";
  els.onboardingTestDetail.textContent = steps.test && steps.test.ok
    ? "本地事件已成功送达"
    : "测试事件未送达，将自动重试";
  els.onboardingTrustHelp.classList.toggle("hidden", !trustRequired || !!steps.trust.ok);
  els.onboardingFinish.classList.toggle("hidden", !status.ready);
  els.btnOnboardingClose.disabled = !status.ready || onboardingPending;
  scheduleOnboardingPoll(status);
}

function setOnboardingOpen(open) {
  els.onboarding.classList.toggle("hidden", !open);
  document.body.classList.toggle("onboarding-open", open);
  if (!open) {
    clearTimeout(onboardingPollTimer);
    onboardingPollTimer = null;
  }
}

async function runOnboardingChecks(silent = false) {
  if (onboardingPending || isDemoMode) return;
  onboardingPending = true;
  els.btnOnboardingRetry.disabled = true;
  els.btnOnboardingRetry.textContent = "检查中...";
  let status = null;
  try {
    status = await window.ccPanel.runOnboardingChecks();
  } catch {
    if (!silent) showToast("自动检查失败，请重试");
  } finally {
    onboardingPending = false;
    els.btnOnboardingRetry.disabled = false;
    els.btnOnboardingRetry.textContent = "重新检查";
    if (status) renderOnboarding(status);
  }
}

const HOOK_STATUS_LABELS = {
  installed: "已安装",
  not_installed: "未安装",
  failed: "失败",
  pending_trust: "待信任",
};

const HOOK_MODE_LABELS = {
  hook: "未降级",
  hybrid: "部分降级",
  process_scan: "进程扫描",
};

function formatHookEventTime(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === "") return "尚未收到";
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return "尚未收到";
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function hookResolutionContent(status) {
  const clients = status && status.clients ? status.clients : {};
  const diagnostics = status && status.diagnostics ? status.diagnostics : {};
  if (diagnostics.eventService && diagnostics.eventService.status !== "running") {
    return {
      title: "事件服务未运行",
      message: "重启 cc-panel；若仍未恢复，请检查本机 24333-24337 端口是否被占用。",
    };
  }
  if (clients.codex && clients.codex.status === "pending_trust") {
    return {
      title: "Codex Hook 待信任",
      message: "在 Codex 中运行 /hooks，信任 cc-panel Hook，然后返回这里重新检测。",
      codexTrust: true,
    };
  }
  const failedClient = Object.values(clients).find((client) => client.status === "failed");
  if (failedClient) {
    return {
      title: "Hook 检测失败",
      message: failedClient.error || "检查 Claude Code / Codex 配置文件权限后重新安装。",
    };
  }
  if (Object.values(clients).some((client) => client.status === "not_installed")) {
    return {
      title: "Hook 未完整安装",
      message: "点击“重新安装”；完成后重新检测。若 Codex 提示信任，再按待信任步骤操作。",
    };
  }
  return {
    title: "Hook 工作正常",
    message: "若会话状态没有实时更新，可先重新检测，再重新安装。",
  };
}

function renderHookResolution(status) {
  const content = hookResolutionContent(status);
  const forceOpen = !!content.codexTrust;
  const open = forceOpen || hookHelpOpen;
  els.hookResolution.classList.toggle("hidden", !open);
  els.hookResolutionTitle.textContent = content.title;
  els.hookResolutionMessage.textContent = content.message;
  els.codexTrustActions.classList.toggle("hidden", !content.codexTrust);
  els.btnHookHelp.setAttribute("aria-expanded", String(open));
  els.btnHookHelp.textContent = open && !forceOpen ? "收起解决步骤" : "查看解决步骤";
}

function setHookOperationPending(pending) {
  hookOperationPending = pending;
  for (const button of [
    els.btnHookInspect,
    els.btnHookInstall,
    els.btnHookUninstall,
    els.btnCheckCodexTrust,
  ]) button.disabled = pending;
}

function renderHookInstallStatus(status) {
  hookInstallStatus = status || {};
  const clients = status && status.clients ? status.clients : {};
  const diagnostics = status && status.diagnostics ? status.diagnostics : {};
  const clientStates = [];
  for (const [name, element] of [
    ["claude", els.claudeHookStatus],
    ["codex", els.codexHookStatus],
  ]) {
    const client = clients[name] || { status: "not_installed" };
    const rawStatus = HOOK_STATUS_LABELS[client.status] ? client.status : "not_installed";
    const clientStatus = name === "codex" && rawStatus === "pending_trust" ? "installed" : rawStatus;
    clientStates.push(clientStatus);
    element.dataset.status = clientStatus;
    element.textContent = name === "claude" && rawStatus === "pending_trust"
      ? "待启动"
      : HOOK_STATUS_LABELS[clientStatus];
    element.title = client.error || "";
  }

  const codexStatus = clients.codex && clients.codex.status;
  const codexTrustStatus = codexStatus === "pending_trust"
    ? "pending_trust"
    : codexStatus === "installed" ? "installed" : "unknown";
  els.codexTrustStatus.dataset.status = codexTrustStatus;
  els.codexTrustStatus.textContent = codexTrustStatus === "installed"
    ? "已信任"
    : codexTrustStatus === "pending_trust" ? "待信任" : "--";

  const lastEventAt = diagnostics.lastEventAt;
  els.hookLastEvent.textContent = formatHookEventTime(lastEventAt);
  els.hookLastEvent.title = lastEventAt ? new Date(lastEventAt).toLocaleString() : "尚未收到 Hook 事件";
  const serviceRunning = diagnostics.eventService && diagnostics.eventService.status === "running";
  els.hookEventService.dataset.status = serviceRunning ? "installed" : "failed";
  els.hookEventService.textContent = serviceRunning ? "运行中" : "已停止";
  els.hookEventService.title = serviceRunning && diagnostics.eventService.port
    ? `127.0.0.1:${diagnostics.eventService.port}`
    : "";
  els.hookFallbackMode.textContent = HOOK_MODE_LABELS[diagnostics.mode] || "检测中";
  els.hookFallbackMode.title = diagnostics.mode === "hook"
    ? "所有客户端使用实时 Hook 事件"
    : diagnostics.mode === "hybrid"
      ? "部分客户端使用 Hook，其余使用进程扫描"
      : "仅使用进程扫描识别会话";

  const hasFailure = clientStates.includes("failed");
  const needsAttention = hasFailure
    || clientStates.includes("not_installed")
    || codexStatus === "pending_trust"
    || !serviceRunning;
  els.btnSettings.classList.toggle("has-hook-error", hasFailure);
  els.btnSettings.classList.toggle("has-hook-warning", !hasFailure && needsAttention);
  els.btnSettings.title = hasFailure
    ? "设置（Hook 安装失败）"
    : needsAttention ? "设置（Hook 需要处理）" : "设置";
  els.btnSettings.setAttribute("aria-label", els.btnSettings.title);
  renderHookResolution(status);
}

function directoryName(s) {
  if (s.project) return s.project;
  const parts = String(s.cwd || "").split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || "(unknown)";
}

function refreshStateAges(now = Date.now()) {
  for (const elapsed of els.cards.querySelectorAll(".state-age")) {
    elapsed.textContent = stateAgeLabel({
      state: elapsed.dataset.state,
      stateSince: Number(elapsed.dataset.since),
    }, now);
  }
}

function render() {
  const sorted = orderSessions(sessions);
  const idleSessions = sorted.filter((session) => session.state === "idle");
  const hasIdleStack = idleSessions.length > 1;
  const animateInitialCollapse = hasIdleStack && !idleStackInitialized;
  let idleStack = null;

  if (hasIdleStack) {
    idleStackInitialized = true;
    if (animateInitialCollapse) idleStackExpanded = true;
  } else {
    clearIdleStackCollapseTimer();
    idleStackInitialized = false;
    idleStackExpanded = false;
  }

  let cards;
  if (hasIdleStack) {
    idleStack = buildIdleStack(idleSessions, idleStackExpanded);
    cards = [
      idleStack,
      ...sorted.filter((session) => session.state !== "idle").map(buildCard),
    ];
  } else {
    cards = sorted.map(buildCard);
  }

  refreshEmptyState();
  els.cards.replaceChildren(...cards);

  if (animateInitialCollapse && idleStack) {
    // Commit the expanded geometry first so the initial automatic stack is animated.
    idleStack.getBoundingClientRect();
    requestAnimationFrame(() => {
      if (!idleStack.isConnected) return;
      if (idleStack.matches(":hover") || idleStack.contains(document.activeElement)) return;
      setIdleStackExpanded(false, idleStack);
    });
  } else if (idleStack) {
    // Snapshots rebuild the DOM; restore hover state if the pointer stayed over the new stack.
    if (idleStack.matches(":hover") || idleStack.contains(document.activeElement)) {
      setIdleStackExpanded(true, idleStack);
    } else if (idleStackExpanded) {
      scheduleIdleStackCollapse();
    }
  }
}

function refreshEmptyState() {
  els.empty.classList.toggle("hidden", sessions.length > 0);
}

async function focusSession(s) {
  if (isDemoMode) {
    showToast(`${clientLabel(s)} Demo 会话`);
    return;
  }
  if (!s.hasWindow) {
    showToast("未找到该会话的终端窗口");
    return;
  }
  const result = await window.ccPanel.focusSession(s.id);
  if (!result.ok) {
    showToast(result.reason === "gone" ? "终端窗口已关闭" : "无法聚焦窗口");
  }
}

function buildCard(s) {
  console.log(`[buildCard] id=${s.id}, state=${s.state}, client=${s.client}`);
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card" + (s.hasWindow ? "" : " no-window");
  card.dataset.state = s.state;
  card.dataset.id = s.id;
  if (s.state === "working" && Number.isFinite(Number(s.stateSince))) {
    const stateAge = Math.max(0, Date.now() - Number(s.stateSince));
    card.style.setProperty(
      "--working-animation-delay",
      `${-(stateAge % WORKING_LIGHT_CYCLE_MS)}ms`,
    );
  }

  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = directoryName(s);
  const directoryPath = document.createElement("span");
  directoryPath.className = "directory-path";
  directoryPath.textContent = s.cwd || "";
  directoryPath.title = s.cwd || "";
  head.append(title, directoryPath);

  const meta = document.createElement("div");
  meta.className = "meta";

  const stateLabel = document.createElement("span");
  stateLabel.className = "state-label";
  stateLabel.textContent = STATE_LABELS[s.state] || STATE_LABELS.idle;
  meta.append(stateLabel);

  if (!s.hasWindow) {
    const tag = document.createElement("span");
    tag.className = "no-win-tag";
    tag.textContent = "无窗口";
    meta.append(tag);
  }

  card.append(head);
  card.append(meta);

  const context = document.createElement("div");
  context.className = "session-context";
  const client = document.createElement("span");
  client.textContent = clientLabel(s);
  const terminal = document.createElement("span");
  terminal.className = "terminal-number";
  terminal.textContent = s.terminalPid ? `终端 #${s.terminalPid}` : "终端 --";
  const elapsed = document.createElement("span");
  elapsed.className = "state-age";
  elapsed.dataset.state = s.state;
  elapsed.dataset.since = String(s.stateSince);
  elapsed.textContent = stateAgeLabel(s);
  elapsed.title = s.stateSince
    ? `当前状态始于 ${new Date(s.stateSince).toLocaleString()}`
    : "";
  context.append(client, createContextSeparator(), terminal, createContextSeparator(), elapsed);
  card.append(context);

  const detailStr = detailText(s);
  if (detailStr) {
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = detailStr;
    detail.title = detailStr;
    card.append(detail);
  }

  card.addEventListener("click", () => focusSession(s));

  return card;
}

function buildIdleStack(idleSessions, expanded) {
  const stack = document.createElement("section");
  const visibleDepth = Math.min(idleSessions.length - 1, 3);
  stack.className = "idle-stack";
  stack.setAttribute("aria-label", `${idleSessions.length} 个空闲会话`);
  stack.style.setProperty("--stack-collapsed-height", `${88 + visibleDepth * 6}px`);
  stack.style.setProperty("--stack-expanded-height", `${idleSessions.length * 96 - 8}px`);

  const cards = idleSessions.map((session, index) => {
    const card = buildCard(session);
    const depth = Math.min(index, 3);
    card.style.setProperty("--stack-collapsed-top", `${depth * 6}px`);
    card.style.setProperty("--stack-collapsed-inset", `${depth * 4}px`);
    card.style.setProperty("--stack-expanded-top", `${index * 96}px`);
    card.style.zIndex = String(idleSessions.length - index);
    return card;
  });

  const count = document.createElement("span");
  count.className = "idle-stack-count";
  count.textContent = String(idleSessions.length);
  count.title = `${idleSessions.length} 个空闲会话`;
  cards[0].querySelector(".state-label").append(count);
  stack.append(...cards);
  updateIdleStackElement(stack, expanded);

  stack.addEventListener("mouseenter", () => {
    clearIdleStackCollapseTimer();
    setIdleStackExpanded(true, stack);
  });
  stack.addEventListener("mouseleave", scheduleIdleStackCollapse);
  stack.addEventListener("focusin", () => {
    clearIdleStackCollapseTimer();
    setIdleStackExpanded(true, stack);
  });
  stack.addEventListener("focusout", (event) => {
    if (!stack.contains(event.relatedTarget)) scheduleIdleStackCollapse();
  });

  return stack;
}

function updateIdleStackElement(stack, expanded) {
  stack.classList.toggle("is-expanded", expanded);
  stack.classList.toggle("is-collapsed", !expanded);
  stack.setAttribute("aria-expanded", String(expanded));

  for (const [index, card] of [...stack.querySelectorAll(".card")].entries()) {
    const accessible = expanded || index === 0;
    card.tabIndex = accessible ? 0 : -1;
    if (accessible) card.removeAttribute("aria-hidden");
    else card.setAttribute("aria-hidden", "true");
  }
}

function setIdleStackExpanded(expanded, stack = els.cards.querySelector(".idle-stack")) {
  idleStackExpanded = expanded;
  if (expanded) clearIdleStackCollapseTimer();
  if (stack) updateIdleStackElement(stack, expanded);
}

function clearIdleStackCollapseTimer() {
  clearTimeout(idleStackCollapseTimer);
  idleStackCollapseTimer = null;
}

function scheduleIdleStackCollapse() {
  if (idleStackCollapseTimer !== null) return;
  idleStackCollapseTimer = setTimeout(() => {
    idleStackCollapseTimer = null;
    const stack = els.cards.querySelector(".idle-stack");
    if (!stack) {
      idleStackExpanded = false;
      return;
    }
    if (stack.matches(":hover") || stack.contains(document.activeElement)) return;
    setIdleStackExpanded(false, stack);
  }, IDLE_STACK_COLLAPSE_DELAY_MS);
}

function createContextSeparator() {
  const separator = document.createElement("span");
  separator.className = "context-separator";
  separator.textContent = "·";
  return separator;
}

function applySnapshot(snapshot) {
  console.log(`[applySnapshot] 收到 ${snapshot.length} 个会话:`, snapshot.map(s => ({ id: s.id, state: s.state, client: s.client })));
  let hasNotifiableChange = false;
  for (const s of snapshot) {
    const key = s.cardKey || s.id;
    const prev = prevStates.get(key);
    if (prev !== undefined && prev !== s.state && NOTIFY_STATES.has(s.state)) {
      hasNotifiableChange = true;
    }
    prevStates.set(key, s.state);
  }
  const activeKeys = new Set(snapshot.map((s) => s.cardKey || s.id));
  for (const key of [...prevStates.keys()]) {
    if (!activeKeys.has(key)) prevStates.delete(key);
  }

  sessions = snapshot;
  render();

  if (hasNotifiableChange && cfg.sound) beep();
}

function refreshConfigButtons() {
  els.btnSettings.classList.toggle("active", !els.settingsPanel.classList.contains("hidden"));
  els.settingAlwaysOnTop.checked = !!cfg.alwaysOnTop;
  els.settingSound.checked = !!cfg.sound;
  els.settingPromptSummary.checked = cfg.showPromptSummary !== false;
  els.settingAutoLaunch.checked = !!cfg.autoLaunch;
  renderTerminalOptions();
}

function renderTerminalOptions() {
  const current = cfg.terminalExecutable || "";
  const currentKey = current.toLowerCase();
  const options = [];
  options.push(new Option("默认（Windows Terminal）", ""));

  const matchedTerminal = terminalApps.find(
    (terminal) => terminal.executable.toLowerCase() === currentKey,
  );
  if (current && !matchedTerminal) {
    const filename = current.split(/[\\/]/).pop();
    options.push(new Option(`自定义：${filename}`, current));
  }
  for (const terminal of terminalApps) {
    options.push(new Option(terminal.name, terminal.executable));
  }
  options.push(new Option("浏览其他 EXE...", BROWSE_TERMINAL_VALUE));

  els.settingTerminalExecutable.replaceChildren(...options);
  els.settingTerminalExecutable.value = matchedTerminal ? matchedTerminal.executable : current;
  els.settingTerminalExecutable.title = current || "默认使用 Windows Terminal";
}

function setTerminalHistoryOpen(open, terminalCommand = terminalHistoryCommand) {
  const hasHistory = Array.isArray(cfg.terminalHistory) && cfg.terminalHistory.length > 0;
  const shouldOpen = !!open && hasHistory;
  if (shouldOpen) terminalHistoryCommand = terminalCommand;
  els.terminalHistoryMenu.classList.toggle("hidden", !shouldOpen);
  els.btnClaudeTerminal.setAttribute(
    "aria-expanded",
    String(shouldOpen && terminalHistoryCommand === "claude"),
  );
  els.btnCodexTerminal.setAttribute(
    "aria-expanded",
    String(shouldOpen && terminalHistoryCommand === "codex"),
  );
}

function terminalDirectoryTitle(directory) {
  const withoutTrailingSeparators = String(directory).replace(/[\\/]+$/, "");
  const parts = withoutTrailingSeparators.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || directory;
}

function renderTerminalHistory() {
  const directories = Array.isArray(cfg.terminalHistory) ? cfg.terminalHistory.slice(0, 5) : [];
  const items = directories.map((directory) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "terminal-history-item";
    item.setAttribute("role", "menuitem");
    item.title = directory;

    const title = document.createElement("strong");
    title.className = "terminal-history-title";
    title.textContent = terminalDirectoryTitle(directory);

    const directoryPath = document.createElement("span");
    directoryPath.className = "terminal-history-path";
    directoryPath.textContent = directory;
    item.append(title, directoryPath);

    item.addEventListener("click", (event) => {
      event.stopPropagation();
      const command = terminalHistoryCommand || "claude";
      setTerminalHistoryOpen(false);
      void openTerminal(command, directory);
    });
    return item;
  });

  els.terminalHistoryMenu.replaceChildren(...items);
  if (!items.length) setTerminalHistoryOpen(false);
}

function showTerminalHistory(terminalCommand) {
  clearTimeout(terminalHistoryCloseTimer);
  if (!els.settingsPanel.classList.contains("hidden")) setSettingsOpen(false);
  setTerminalHistoryOpen(true, terminalCommand);
}

function scheduleTerminalHistoryClose() {
  clearTimeout(terminalHistoryCloseTimer);
  terminalHistoryCloseTimer = setTimeout(() => setTerminalHistoryOpen(false), 120);
}

function setTerminalControlsDisabled(disabled) {
  els.btnClaudeTerminal.disabled = disabled;
  els.btnCodexTerminal.disabled = disabled;
  for (const item of els.terminalHistoryMenu.querySelectorAll(".terminal-history-item")) {
    item.disabled = disabled;
  }
}

async function scanTerminalApps() {
  if (terminalScanPromise) return terminalScanPromise;
  if (isDemoMode) {
    terminalApps = [{ name: "Windows Terminal", executable: "C:\\Program Files\\WindowsApps\\wt.exe" }];
    renderTerminalOptions();
    return terminalApps;
  }
  els.settingTerminalExecutable.disabled = true;
  terminalScanPromise = (async () => {
    try {
      const result = await window.ccPanel.listTerminalApps();
      terminalApps = result && result.ok && Array.isArray(result.terminals)
        ? result.terminals
        : [];
    } catch {
      terminalApps = [];
    } finally {
      terminalScanPromise = null;
      els.settingTerminalExecutable.disabled = false;
      renderTerminalOptions();
    }
  })();
  return terminalScanPromise;
}

function setSettingsOpen(open) {
  els.settingsPanel.classList.toggle("hidden", !open);
  refreshConfigButtons();
  if (open) void scanTerminalApps();
}

async function openTerminal(terminalCommand, directory) {
  setTerminalHistoryOpen(false);
  if (isDemoMode) {
    showToast(`${terminalCommand === "codex" ? "Codex CLI" : "Claude Code"} Demo`);
    return;
  }
  setTerminalControlsDisabled(true);
  try {
    const result = await window.ccPanel.openTerminal(terminalCommand, directory);
    if (result.config) {
      cfg = result.config;
      renderTerminalHistory();
    }
    if (result.ok && result.configSaveError) {
      showToast("终端已启动，但最近目录未保存，请检查磁盘权限或文件占用");
    }
    if (!result.ok && result.reason !== "canceled") {
      const message = result.reason === "unsupported_platform"
        ? "当前系统不支持启动终端"
        : result.reason === "config_write_failed"
          ? "终端启动设置未保存，请检查磁盘权限或文件占用"
        : result.reason === "invalid_directory"
          ? "该路径已不可用"
          : "无法打开终端";
      showToast(message + (result.error && result.reason !== "config_write_failed" ? "：" + result.error : ""));
    }
  } catch {
    showToast("无法打开终端");
  } finally {
    setTerminalControlsDisabled(false);
  }
}

async function runHookOperation(action) {
  if (hookOperationPending) return;
  if (isDemoMode) {
    showToast("Demo 模式不会修改 Hook");
    return;
  }
  setHookOperationPending(true);
  try {
    const result = await window.ccPanel[action]();
    renderHookInstallStatus(result);
    const operation = result && result.operation ? result.operation : { ok: false };
    if (!operation.ok) {
      showToast(`Hook 操作失败${operation.error ? "：" + operation.error : ""}`);
      return;
    }
    if (action === "installHooks") {
      showToast(result.clients && result.clients.codex.status === "pending_trust"
        ? "Hook 已安装，Codex 仍需信任"
        : "Hook 已重新安装");
    } else if (action === "uninstallHooks") {
      showToast(operation.changed ? "Hook 已卸载" : "未发现可卸载的 Hook");
    } else {
      showToast("Hook 状态已更新");
    }
  } catch (error) {
    showToast(`Hook 操作失败${error && error.message ? "：" + error.message : ""}`);
  } finally {
    setHookOperationPending(false);
  }
}

els.btnClaudeTerminal.addEventListener("click", () => openTerminal("claude"));
els.btnCodexTerminal.addEventListener("click", () => openTerminal("codex"));
els.btnClaudeTerminal.addEventListener("mouseenter", () => showTerminalHistory("claude"));
els.btnCodexTerminal.addEventListener("mouseenter", () => showTerminalHistory("codex"));
els.btnClaudeTerminal.addEventListener("focus", () => showTerminalHistory("claude"));
els.btnCodexTerminal.addEventListener("focus", () => showTerminalHistory("codex"));
els.newTerminalControl.addEventListener("mouseenter", () => clearTimeout(terminalHistoryCloseTimer));
els.newTerminalControl.addEventListener("mouseleave", scheduleTerminalHistoryClose);
els.newTerminalControl.addEventListener("focusout", (event) => {
  if (!els.newTerminalControl.contains(event.relatedTarget)) scheduleTerminalHistoryClose();
});
async function minimizeAllTerminals() {
  if (els.btnCollapseTerminals.disabled) return;
  if (isDemoMode) {
    showToast("Demo 模式不会操作终端窗口");
    return;
  }
  els.btnCollapseTerminals.disabled = true;
  try {
    const result = await window.ccPanel.minimizeAllTerminals();
    if (!result.ok) {
      showToast("无法收起终端窗口");
    } else if (result.minimized) {
      showToast(`已收起 ${result.minimized} 个终端窗口`);
    } else {
      showToast("没有可收起的终端窗口");
    }
  } catch {
    showToast("无法收起终端窗口");
  } finally {
    els.btnCollapseTerminals.disabled = false;
  }
}

els.btnCollapseTerminals.addEventListener("click", minimizeAllTerminals);

els.btnHookInspect.addEventListener("click", () => runHookOperation("inspectHooks"));
els.btnHookInstall.addEventListener("click", () => runHookOperation("installHooks"));
els.btnHookUninstall.addEventListener("click", () => {
  if (window.confirm("卸载 cc-panel 的 Claude Code 和 Codex Hook？会话仍可通过进程扫描显示。")) {
    void runHookOperation("uninstallHooks");
  }
});
els.btnHookHelp.addEventListener("click", () => {
  hookHelpOpen = !hookHelpOpen;
  renderHookResolution(hookInstallStatus);
});
els.btnOpenCodexTrust.addEventListener("click", () => {
  const directory = Array.isArray(cfg.terminalHistory) ? cfg.terminalHistory[0] : undefined;
  void openTerminal("codex", directory);
});
els.btnCopyHooksCommand.addEventListener("click", () => {
  if (!isDemoMode) window.ccPanel.copyHooksCommand();
  showToast("已复制 /hooks");
});
els.btnCheckCodexTrust.addEventListener("click", () => runHookOperation("inspectHooks"));


els.settingAlwaysOnTop.addEventListener("change", async () => {
  if (isDemoMode) {
    cfg.alwaysOnTop = els.settingAlwaysOnTop.checked;
    refreshConfigButtons();
    return;
  }
  await saveSetting({ alwaysOnTop: els.settingAlwaysOnTop.checked });
});

els.settingSound.addEventListener("change", async () => {
  if (isDemoMode) {
    cfg.sound = els.settingSound.checked;
    refreshConfigButtons();
    return;
  }
  await saveSetting({ sound: els.settingSound.checked });
});

els.settingPromptSummary.addEventListener("change", async () => {
  if (isDemoMode) {
    cfg.showPromptSummary = els.settingPromptSummary.checked;
    refreshConfigButtons();
    render();
    return;
  }
  if (await saveSetting({ showPromptSummary: els.settingPromptSummary.checked })) render();
});

els.settingTerminalExecutable.addEventListener("change", async () => {
  if (isDemoMode) {
    showToast("Demo 模式不会修改终端设置");
    renderTerminalOptions();
    return;
  }
  els.settingTerminalExecutable.disabled = true;
  try {
    const selected = els.settingTerminalExecutable.value;
    const result = selected === BROWSE_TERMINAL_VALUE
      ? await window.ccPanel.selectTerminalExecutable()
      : await window.ccPanel.setTerminalExecutable(selected || null);
    if (result.config) cfg = result.config;
    refreshConfigButtons();
    if (!result.ok) {
      if (result.reason === "invalid_executable") showToast("请选择 EXE 文件");
      if (result.reason === "config_write_failed") {
        showToast("终端设置未保存，请检查磁盘权限或文件占用");
      }
    }
  } catch {
    showToast("无法选择终端程序");
  } finally {
    els.settingTerminalExecutable.disabled = false;
  }
});

els.btnSettings.addEventListener("click", () => {
  setSettingsOpen(els.settingsPanel.classList.contains("hidden"));
});

els.settingAutoLaunch.addEventListener("change", async () => {
  if (isDemoMode) {
    cfg.autoLaunch = els.settingAutoLaunch.checked;
    refreshConfigButtons();
    return;
  }
  const saved = await saveSetting({ autoLaunch: els.settingAutoLaunch.checked });
  if (saved && cfg.autoLaunchError) {
    showToast("开机自启动设置失败：" + cfg.autoLaunchError);
  }
});

els.btnOnboardingOpenCodex.addEventListener("click", () => {
  const directory = Array.isArray(cfg.terminalHistory) ? cfg.terminalHistory[0] : undefined;
  void openTerminal("codex", directory);
});
els.btnOnboardingCopyHooks.addEventListener("click", () => {
  if (!isDemoMode) window.ccPanel.copyHooksCommand();
  showToast("已复制 /hooks");
});
els.btnOnboardingRetry.addEventListener("click", () => void runOnboardingChecks());
els.btnOnboardingClose.addEventListener("click", async () => {
  if (isDemoMode) {
    setOnboardingOpen(false);
    return;
  }
  try {
    const result = await window.ccPanel.completeOnboarding();
    if (!result.ok) {
      renderOnboarding(result.onboarding);
      showToast(result.reason === "config_write_failed" ? "向导状态未保存" : "四步检查尚未全部完成");
      return;
    }
    cfg.onboardingCompleted = true;
    setOnboardingOpen(false);
  } catch {
    showToast("无法关闭向导，请重试");
  }
});

document.addEventListener("click", (event) => {
  if (!els.newTerminalControl.contains(event.target)) setTerminalHistoryOpen(false);
  if (els.settingsPanel.classList.contains("hidden")) return;
  if (els.settingsPanel.contains(event.target) || els.btnSettings.contains(event.target)) return;
  setSettingsOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setTerminalHistoryOpen(false);
    setSettingsOpen(false);
  }
});
if (!isDemoMode) window.ccPanel.onSessions(applySnapshot);
setInterval(() => refreshStateAges(), 1000);

(async function init() {
  if (isDemoMode) {
    cfg = {
      alwaysOnTop: false,
      sound: false,
      showPromptSummary: true,
      autoLaunch: false,
      terminalCommand: "claude",
      terminalExecutable: null,
      terminalHistory: ["C:\\workspace\\cc-panel", "C:\\workspace\\docs-site"],
    };
    refreshConfigButtons();
    renderTerminalHistory();
    await scanTerminalApps();
    renderHookInstallStatus({
      clients: { claude: { status: "installed" }, codex: { status: "pending_trust" } },
      diagnostics: {
        lastEventAt: Date.now() - 24000,
        eventService: { status: "running", port: 24333 },
        mode: "hybrid",
      },
    });
    applySnapshot(demoData.createDemoSessions());
    return;
  }
  const state = await window.ccPanel.getState();
  window.ccPanel.onHookInstallStatus(renderHookInstallStatus);
  cfg = state.config;
  refreshConfigButtons();
  renderTerminalHistory();
  await scanTerminalApps();
  renderHookInstallStatus(state.hookInstallStatus);
  renderOnboarding(state.onboarding);
  if (!state.onboarding.completed) {
    setOnboardingOpen(true);
    void runOnboardingChecks();
  }
  if (state.autoLaunchStatus && !state.autoLaunchStatus.ok) {
    showToast("开机自启动设置失败：" + (state.autoLaunchStatus.error || "未知错误"));
  }
  applySnapshot(state.sessions);
})();
