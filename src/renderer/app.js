// app.js — renderer: render session cards, handle clicks and settings.
// transitions worth interrupting the user for
const NOTIFY_STATES = new Set(["needs_input", "done", "error"]);
const orderSessions = createStableSessionOrder();
const { clientLabel, stateAgeLabel } = sessionMeta;
const { normalizeLanguage, translate, applyDocument } = appI18n;
const sound = statusSound.createStatusSound();
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
  settingLanguage: document.getElementById("setting-language"),
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
  language: "zh-CN",
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
let onboardingStatus = null;
const BROWSE_TERMINAL_VALUE = "__browse__";

function currentLanguage() {
  return normalizeLanguage(cfg.language);
}

function t(key, values) {
  return translate(currentLanguage(), key, values);
}

function dateLocale() {
  return currentLanguage() === "en" ? "en-US" : "zh-CN";
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2500);
}

function applyConfigResult(result) {
  const previousLanguage = currentLanguage();
  if (result && result.config) cfg = result.config;
  if (currentLanguage() !== previousLanguage) applyLanguage();
  else refreshConfigButtons();
  if (result && result.ok) return true;
  showToast(result && result.reason === "config_write_failed"
    ? t("settings.saveFailedDisk")
    : t("settings.saveFailedRetry"));
  return false;
}

async function saveSetting(patch) {
  try {
    return applyConfigResult(await window.ccPanel.setConfig(patch));
  } catch {
    refreshConfigButtons();
    showToast(t("settings.saveFailedRetry"));
    return false;
  }
}

function detailText(s) {
  if (s.state === "needs_input" && s.message) return s.message;
  if (s.state === "working" && s.currentTool) return t("session.tool", { tool: s.currentTool });
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
  onboardingStatus = status;
  const steps = status.steps || {};
  const detectedNames = onboardingClientNames(status.detected);
  setOnboardingStep(els.onboardingStepDiscover, 1, !!(steps.discover && steps.discover.ok));
  setOnboardingStep(els.onboardingStepHooks, 2, !!(steps.hooks && steps.hooks.ok));
  setOnboardingStep(els.onboardingStepTrust, 3, !!(steps.trust && steps.trust.ok));
  setOnboardingStep(els.onboardingStepTest, 4, !!(steps.test && steps.test.ok));
  els.onboardingDiscoverDetail.textContent = detectedNames.length
    ? t("onboarding.discovered", { clients: detectedNames.join(currentLanguage() === "en" ? ", " : "、") })
    : t("onboarding.notFound");
  els.onboardingHooksDetail.textContent = steps.hooks && steps.hooks.ok
    ? t("onboarding.hooksReady")
    : t("onboarding.hooksRetry");
  const trustRequired = !!(steps.trust && steps.trust.required);
  els.onboardingTrustDetail.textContent = !trustRequired
    ? t("onboarding.codexSkipped")
    : steps.trust.ok ? t("onboarding.codexTrusted") : t("onboarding.codexAwaiting");
  els.onboardingTestDetail.textContent = steps.test && steps.test.ok
    ? t("onboarding.testReady")
    : t("onboarding.testRetry");
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
  els.btnOnboardingRetry.textContent = t("onboarding.checking");
  let status = null;
  try {
    status = await window.ccPanel.runOnboardingChecks();
  } catch {
    if (!silent) showToast(t("onboarding.checkFailed"));
  } finally {
    onboardingPending = false;
    els.btnOnboardingRetry.disabled = false;
    els.btnOnboardingRetry.textContent = t("onboarding.retry");
    if (status) renderOnboarding(status);
  }
}

function formatHookEventTime(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === "") return t("hook.neverReceived");
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return t("hook.neverReceived");
  return date.toLocaleString(dateLocale(), {
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
      title: t("hook.eventServiceStoppedTitle"),
      message: t("hook.eventServiceStoppedMessage"),
    };
  }
  if (clients.codex && clients.codex.status === "pending_trust") {
    return {
      title: t("hook.codexTrustTitle"),
      message: t("hook.codexTrustMessage"),
      codexTrust: true,
    };
  }
  const failedClient = Object.values(clients).find((client) => client.status === "failed");
  if (failedClient) {
    return {
      title: t("hook.checkFailedTitle"),
      message: failedClient.error || t("hook.checkFailedMessage"),
    };
  }
  if (Object.values(clients).some((client) => client.status === "not_installed")) {
    return {
      title: t("hook.incompleteTitle"),
      message: t("hook.incompleteMessage"),
    };
  }
  return {
    title: t("hook.healthyTitle"),
    message: t("hook.healthyMessage"),
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
  els.btnHookHelp.textContent = open && !forceOpen ? t("hook.hideHelp") : t("hook.showHelp");
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
    const rawStatus = ["installed", "not_installed", "failed", "pending_trust"].includes(client.status)
      ? client.status
      : "not_installed";
    const clientStatus = name === "codex" && rawStatus === "pending_trust" ? "installed" : rawStatus;
    clientStates.push(clientStatus);
    element.dataset.status = clientStatus;
    element.textContent = name === "claude" && rawStatus === "pending_trust"
      ? t("hook.pendingStart")
      : t(`hook.status.${clientStatus}`);
    element.title = client.error || "";
  }

  const codexStatus = clients.codex && clients.codex.status;
  const codexTrustStatus = codexStatus === "pending_trust"
    ? "pending_trust"
    : codexStatus === "installed" ? "installed" : "unknown";
  els.codexTrustStatus.dataset.status = codexTrustStatus;
  els.codexTrustStatus.textContent = codexTrustStatus === "installed"
    ? t("hook.trusted")
    : codexTrustStatus === "pending_trust" ? t("hook.status.pending_trust") : "--";

  const lastEventAt = diagnostics.lastEventAt;
  els.hookLastEvent.textContent = formatHookEventTime(lastEventAt);
  els.hookLastEvent.title = lastEventAt
    ? new Date(lastEventAt).toLocaleString(dateLocale())
    : t("hook.neverReceivedTitle");
  const serviceRunning = diagnostics.eventService && diagnostics.eventService.status === "running";
  els.hookEventService.dataset.status = serviceRunning ? "installed" : "failed";
  els.hookEventService.textContent = serviceRunning ? t("hook.serviceRunning") : t("hook.serviceStopped");
  els.hookEventService.title = serviceRunning && diagnostics.eventService.port
    ? `127.0.0.1:${diagnostics.eventService.port}`
    : "";
  els.hookFallbackMode.textContent = ["hook", "hybrid", "process_scan"].includes(diagnostics.mode)
    ? t(`hook.mode.${diagnostics.mode}`)
    : t("hook.checking");
  els.hookFallbackMode.title = diagnostics.mode === "hook"
    ? t("hook.modeHookTitle")
    : diagnostics.mode === "hybrid"
      ? t("hook.modeHybridTitle")
      : t("hook.modeScanTitle");

  const hasFailure = clientStates.includes("failed");
  const needsAttention = hasFailure
    || clientStates.includes("not_installed")
    || codexStatus === "pending_trust"
    || !serviceRunning;
  els.btnSettings.classList.toggle("has-hook-error", hasFailure);
  els.btnSettings.classList.toggle("has-hook-warning", !hasFailure && needsAttention);
  els.btnSettings.title = hasFailure
    ? t("hook.settingsFailed")
    : needsAttention ? t("hook.settingsAttention") : t("toolbar.settings");
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
    }, now, currentLanguage());
  }
}

function applyLanguage() {
  cfg.language = currentLanguage();
  applyDocument(document, cfg.language);
  refreshConfigButtons();
  renderTerminalHistory();
  renderHookInstallStatus(hookInstallStatus);
  if (onboardingStatus) renderOnboarding(onboardingStatus);
  render();
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
    showToast(t("session.demo", { client: clientLabel(s) }));
    return;
  }
  if (!s.hasWindow) {
    showToast(t("session.windowMissing"));
    return;
  }
  const result = await window.ccPanel.focusSession(s.id);
  if (!result.ok) {
    showToast(result.reason === "gone" ? t("session.windowClosed") : t("session.focusFailed"));
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
  const state = ["working", "needs_input", "done", "error", "idle"].includes(s.state) ? s.state : "idle";
  stateLabel.textContent = t(`session.state.${state}`);
  meta.append(stateLabel);

  if (!s.hasWindow) {
    const tag = document.createElement("span");
    tag.className = "no-win-tag";
    tag.textContent = t("session.noWindow");
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
  terminal.textContent = s.terminalPid
    ? t("session.terminalNumber", { pid: s.terminalPid })
    : t("session.terminalUnknown");
  const elapsed = document.createElement("span");
  elapsed.className = "state-age";
  elapsed.dataset.state = s.state;
  elapsed.dataset.since = String(s.stateSince);
  elapsed.textContent = stateAgeLabel(s, Date.now(), currentLanguage());
  elapsed.title = s.stateSince
    ? t("session.stateSince", { time: new Date(s.stateSince).toLocaleString(dateLocale()) })
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
  stack.setAttribute("aria-label", t("session.idleCount", { count: idleSessions.length }));
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
  count.title = t("session.idleCount", { count: idleSessions.length });
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

  if (hasNotifiableChange) sound.beep();
}

function refreshConfigButtons() {
  sound.setEnabled(cfg.sound);
  els.btnSettings.classList.toggle("active", !els.settingsPanel.classList.contains("hidden"));
  els.settingAlwaysOnTop.checked = !!cfg.alwaysOnTop;
  els.settingSound.checked = !!cfg.sound;
  els.settingPromptSummary.checked = cfg.showPromptSummary !== false;
  els.settingAutoLaunch.checked = !!cfg.autoLaunch;
  els.settingLanguage.value = currentLanguage();
  renderTerminalOptions();
}

function renderTerminalOptions() {
  const current = cfg.terminalExecutable || "";
  const currentKey = current.toLowerCase();
  const options = [];
  options.push(new Option(t("terminal.defaultOption"), ""));

  const matchedTerminal = terminalApps.find(
    (terminal) => terminal.executable.toLowerCase() === currentKey,
  );
  if (current && !matchedTerminal) {
    const filename = current.split(/[\\/]/).pop();
    options.push(new Option(t("terminal.customOption", { filename }), current));
  }
  for (const terminal of terminalApps) {
    options.push(new Option(terminal.name, terminal.executable));
  }
  options.push(new Option(t("terminal.browseOption"), BROWSE_TERMINAL_VALUE));

  els.settingTerminalExecutable.replaceChildren(...options);
  els.settingTerminalExecutable.value = matchedTerminal ? matchedTerminal.executable : current;
  els.settingTerminalExecutable.title = current || t("terminal.defaultTitle");
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
      showToast(t("terminal.launchedHistorySaveFailed"));
    }
    if (!result.ok && result.reason !== "canceled") {
      const message = result.reason === "unsupported_platform"
        ? t("terminal.unsupported")
        : result.reason === "config_write_failed"
          ? t("terminal.settingSaveFailed")
        : result.reason === "invalid_directory"
          ? t("terminal.invalidDirectory")
          : t("terminal.openFailed");
      showToast(message + (result.error && result.reason !== "config_write_failed"
        ? t("common.errorSuffix", { error: result.error })
        : ""));
    }
  } catch {
    showToast(t("terminal.openFailed"));
  } finally {
    setTerminalControlsDisabled(false);
  }
}

async function runHookOperation(action) {
  if (hookOperationPending) return;
  if (isDemoMode) {
    showToast(t("hook.demoNoChanges"));
    return;
  }
  setHookOperationPending(true);
  try {
    const result = await window.ccPanel[action]();
    renderHookInstallStatus(result);
    const operation = result && result.operation ? result.operation : { ok: false };
    if (!operation.ok) {
      showToast(t("hook.operationFailed", {
        error: operation.error ? t("common.errorSuffix", { error: operation.error }) : "",
      }));
      return;
    }
    if (action === "installHooks") {
      showToast(result.clients && result.clients.codex.status === "pending_trust"
        ? t("hook.installedNeedsTrust")
        : t("hook.reinstalled"));
    } else if (action === "uninstallHooks") {
      showToast(operation.changed ? t("hook.uninstalled") : t("hook.noneToUninstall"));
    } else {
      showToast(t("hook.statusUpdated"));
    }
  } catch (error) {
    showToast(t("hook.operationFailed", {
      error: error && error.message ? t("common.errorSuffix", { error: error.message }) : "",
    }));
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
    showToast(t("terminal.demoNoWindowChanges"));
    return;
  }
  els.btnCollapseTerminals.disabled = true;
  try {
    const result = await window.ccPanel.minimizeAllTerminals();
    if (!result.ok) {
      showToast(t("terminal.collapseFailed"));
    } else if (result.minimized) {
      showToast(t("terminal.collapsedCount", { count: result.minimized }));
    } else {
      showToast(t("terminal.noneToCollapse"));
    }
  } catch {
    showToast(t("terminal.collapseFailed"));
  } finally {
    els.btnCollapseTerminals.disabled = false;
  }
}

els.btnCollapseTerminals.addEventListener("click", minimizeAllTerminals);

els.btnHookInspect.addEventListener("click", () => runHookOperation("inspectHooks"));
els.btnHookInstall.addEventListener("click", () => runHookOperation("installHooks"));
els.btnHookUninstall.addEventListener("click", () => {
  if (window.confirm(t("hook.confirmUninstall"))) {
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
  showToast(t("hook.copied"));
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
  const previousSound = cfg.sound;
  cfg.sound = els.settingSound.checked;
  sound.setEnabled(cfg.sound);
  if (isDemoMode) {
    refreshConfigButtons();
    return;
  }
  if (!await saveSetting({ sound: cfg.sound })) {
    cfg.sound = previousSound;
    refreshConfigButtons();
  }
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

els.settingLanguage.addEventListener("change", async () => {
  const language = normalizeLanguage(els.settingLanguage.value);
  if (isDemoMode) {
    cfg.language = language;
    applyLanguage();
    return;
  }
  await saveSetting({ language });
});

els.settingTerminalExecutable.addEventListener("change", async () => {
  if (isDemoMode) {
    showToast(t("terminal.demoNoSettings"));
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
      if (result.reason === "invalid_executable") showToast(t("terminal.selectExe"));
      if (result.reason === "config_write_failed") {
        showToast(t("terminal.settingSaveFailed"));
      }
    }
  } catch {
    showToast(t("terminal.selectFailed"));
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
    showToast(t("autoLaunch.failed", { error: cfg.autoLaunchError }));
  }
});

els.btnOnboardingOpenCodex.addEventListener("click", () => {
  const directory = Array.isArray(cfg.terminalHistory) ? cfg.terminalHistory[0] : undefined;
  void openTerminal("codex", directory);
});
els.btnOnboardingCopyHooks.addEventListener("click", () => {
  if (!isDemoMode) window.ccPanel.copyHooksCommand();
  showToast(t("hook.copied"));
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
      showToast(result.reason === "config_write_failed"
        ? t("onboarding.statusSaveFailed")
        : t("onboarding.stepsIncomplete"));
      return;
    }
    cfg.onboardingCompleted = true;
    setOnboardingOpen(false);
  } catch {
    showToast(t("onboarding.closeFailed"));
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
      language: "zh-CN",
      autoLaunch: false,
      terminalCommand: "claude",
      terminalExecutable: null,
      terminalHistory: ["C:\\workspace\\cc-panel", "C:\\workspace\\docs-site"],
    };
    applyLanguage();
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
  applyLanguage();
  renderTerminalHistory();
  await scanTerminalApps();
  renderHookInstallStatus(state.hookInstallStatus);
  renderOnboarding(state.onboarding);
  if (!state.onboarding.completed) {
    setOnboardingOpen(true);
    void runOnboardingChecks();
  }
  if (state.autoLaunchStatus && !state.autoLaunchStatus.ok) {
    showToast(t("autoLaunch.failed", {
      error: state.autoLaunchStatus.error || t("common.unknownError"),
    }));
  }
  applySnapshot(state.sessions);
})();
