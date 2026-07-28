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
const { summarizeSessions } = sessionSummary;
const query = new URLSearchParams(window.location.search);
const isDemoMode = query.get("demo") === "1";
const initialCompactMode = !isDemoMode && query.get("compact") === "1";
document.body.classList.toggle("compact-mode", initialCompactMode);
document.body.classList.toggle("demo-mode", isDemoMode);

const els = {
  cards: document.getElementById("cards"),
  empty: document.getElementById("empty"),
  compactStatus: document.getElementById("compact-status"),
  compactTitle: document.getElementById("compact-title"),
  compactDetail: document.getElementById("compact-detail"),
  compactAttention: document.getElementById("compact-attention"),
  btnExpand: document.getElementById("btn-expand"),
  toast: document.getElementById("toast"),
  btnClaudeTerminal: document.getElementById("btn-claude-terminal"),
  btnCodexTerminal: document.getElementById("btn-codex-terminal"),
  btnCollapseTerminals: document.getElementById("btn-collapse-terminals"),
  btnCompact: document.getElementById("btn-compact"),
  btnSettings: document.getElementById("btn-settings"),
  settingsPanel: document.getElementById("settings-panel"),
  settingAlwaysOnTop: document.getElementById("setting-always-on-top"),
  settingSound: document.getElementById("setting-sound"),
  settingAutoLaunch: document.getElementById("setting-auto-launch"),
  settingTerminalExecutable: document.getElementById("setting-terminal-executable"),
};

let sessions = [];
let prevStates = new Map();
let cfg = {
  compactMode: initialCompactMode,
  alwaysOnTop: true,
  sound: false,
  autoLaunch: true,
  terminalCommand: "claude",
  terminalExecutable: null,
};
let toastTimer = null;
let terminalApps = [];
let terminalScanPromise = null;
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

function detailText(s) {
  if (s.state === "needs_input" && s.message) return s.message;
  if (s.state === "working" && s.currentTool) return `工具：${s.currentTool}`;
  if (s.lastPrompt) return s.lastPrompt;
  return "";
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

  refreshEmptyState();
  els.cards.replaceChildren(...sorted.map(buildCard));
  refreshCompactSummary();
}

function refreshCompactSummary() {
  const summary = summarizeSessions(sessions);
  els.compactStatus.dataset.state = summary.state;
  els.compactTitle.textContent = summary.title;
  els.compactDetail.textContent = summary.detail;
  els.compactAttention.textContent = String(summary.attention);
  els.compactAttention.classList.toggle("hidden", summary.attention === 0);
  els.btnExpand.setAttribute(
    "aria-label",
    `${summary.title}，${summary.detail}，点击恢复完整模式`,
  );
  document.title = cfg.compactMode ? `${summary.title} - cc-panel` : "cc-panel";
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

  const head = document.createElement("div");
  head.className = "head";
  if (s.state === "working") {
    const indicator = document.createElement("span");
    indicator.className = "working-indicator";
    indicator.setAttribute("aria-hidden", "true");
    head.append(indicator);
  }
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
    const prev = prevStates.get(s.id);
    if (prev !== undefined && prev !== s.state && NOTIFY_STATES.has(s.state)) {
      hasNotifiableChange = true;
    }
    prevStates.set(s.id, s.state);
  }
  for (const id of [...prevStates.keys()]) {
    if (!snapshot.some((s) => s.id === id)) prevStates.delete(id);
  }

  sessions = snapshot;
  render();

  if (hasNotifiableChange && cfg.sound) beep();
}

function refreshConfigButtons() {
  els.btnSettings.classList.toggle("active", !els.settingsPanel.classList.contains("hidden"));
  els.settingAlwaysOnTop.checked = !!cfg.alwaysOnTop;
  els.settingSound.checked = !!cfg.sound;
  els.settingAutoLaunch.checked = !!cfg.autoLaunch;
  renderTerminalOptions();
}

function applyCompactMode(compact) {
  cfg.compactMode = !!compact;
  document.body.classList.toggle("compact-mode", cfg.compactMode);
  els.btnCompact.setAttribute("aria-pressed", String(cfg.compactMode));
  if (cfg.compactMode) els.settingsPanel.classList.add("hidden");
  refreshConfigButtons();
  refreshCompactSummary();
}

async function updateCompactMode(compact) {
  if (isDemoMode) {
    applyCompactMode(compact);
    return;
  }
  els.btnCompact.disabled = true;
  els.btnExpand.disabled = true;
  try {
    cfg = await window.ccPanel.setCompactMode(compact);
    applyCompactMode(cfg.compactMode);
  } catch {
    showToast(compact ? "无法进入缩小模式" : "无法恢复完整模式");
  } finally {
    els.btnCompact.disabled = false;
    els.btnExpand.disabled = false;
  }
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

async function openTerminal(terminalCommand) {
  if (isDemoMode) {
    showToast(`${terminalCommand === "codex" ? "Codex CLI" : "Claude Code"} Demo`);
    return;
  }
  els.btnClaudeTerminal.disabled = true;
  els.btnCodexTerminal.disabled = true;
  try {
    const result = await window.ccPanel.openTerminal(terminalCommand);
    if (!result.ok && result.reason !== "canceled") {
      const message = result.reason === "unsupported_platform"
        ? "当前系统不支持启动终端"
        : "无法打开终端";
      showToast(message + (result.error ? "：" + result.error : ""));
    }
  } catch {
    showToast("无法打开终端");
  } finally {
    els.btnClaudeTerminal.disabled = false;
    els.btnCodexTerminal.disabled = false;
  }
}

els.btnClaudeTerminal.addEventListener("click", () => openTerminal("claude"));
els.btnCodexTerminal.addEventListener("click", () => openTerminal("codex"));
els.btnCompact.addEventListener("click", () => updateCompactMode(true));
els.btnExpand.addEventListener("click", () => updateCompactMode(false));

els.btnCollapseTerminals.addEventListener("click", async () => {
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
});


els.settingAlwaysOnTop.addEventListener("change", async () => {
  if (isDemoMode) {
    cfg.alwaysOnTop = els.settingAlwaysOnTop.checked;
    refreshConfigButtons();
    return;
  }
  cfg = await window.ccPanel.setConfig({ alwaysOnTop: els.settingAlwaysOnTop.checked });
  refreshConfigButtons();
});

els.settingSound.addEventListener("change", async () => {
  if (isDemoMode) {
    cfg.sound = els.settingSound.checked;
    refreshConfigButtons();
    return;
  }
  cfg = await window.ccPanel.setConfig({ sound: els.settingSound.checked });
  refreshConfigButtons();
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
    if (!result.ok && result.reason === "invalid_executable") {
      showToast("请选择 EXE 文件");
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
  cfg = await window.ccPanel.setConfig({ autoLaunch: els.settingAutoLaunch.checked });
  refreshConfigButtons();
  if (cfg.autoLaunchError) {
    showToast("开机自启动设置失败：" + cfg.autoLaunchError);
  }
});

document.addEventListener("click", (event) => {
  if (els.settingsPanel.classList.contains("hidden")) return;
  if (els.settingsPanel.contains(event.target) || els.btnSettings.contains(event.target)) return;
  setSettingsOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSettingsOpen(false);
});
if (!isDemoMode) window.ccPanel.onSessions(applySnapshot);
setInterval(() => refreshStateAges(), 1000);

(async function init() {
  if (isDemoMode) {
    cfg = {
      compactMode: false,
      alwaysOnTop: false,
      sound: false,
      autoLaunch: false,
      terminalCommand: "claude",
      terminalExecutable: null,
    };
    applyCompactMode(false);
    refreshConfigButtons();
    await scanTerminalApps();
    applySnapshot(demoData.createDemoSessions());
    return;
  }
  const state = await window.ccPanel.getState();
  cfg = state.config;
  applyCompactMode(cfg.compactMode);
  refreshConfigButtons();
  await scanTerminalApps();
  if (state.hookInstallStatus && !state.hookInstallStatus.ok) {
    showToast("hooks 自动安装失败：" + (state.hookInstallStatus.error || "未知错误"));
  }
  if (state.autoLaunchStatus && !state.autoLaunchStatus.ok) {
    showToast("开机自启动设置失败：" + (state.autoLaunchStatus.error || "未知错误"));
  }
  applySnapshot(state.sessions);
})();
