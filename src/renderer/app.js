// app.js — renderer: render session cards, handle clicks and settings.
const STATE_LABEL = {
  working: "工作中",
  needs_input: "等待输入",
  done: "已完成",
  error: "出错",
  idle: "空闲",
  ended: "已结束",
  dead: "进程已退出",
};
// transitions worth interrupting the user for
const NOTIFY_STATES = new Set(["needs_input", "done", "error"]);
const orderSessions = createStableSessionOrder();
const { clientLabel, stateAgeLabel } = sessionMeta;

const els = {
  permissions: document.getElementById("permissions"),
  cards: document.getElementById("cards"),
  empty: document.getElementById("empty"),
  toast: document.getElementById("toast"),
  btnTerminal: document.getElementById("btn-terminal"),
  btnCollapseTerminals: document.getElementById("btn-collapse-terminals"),
  btnSettings: document.getElementById("btn-settings"),
  settingsPanel: document.getElementById("settings-panel"),
  terminalCommand: document.getElementById("terminal-command"),
  settingAlwaysOnTop: document.getElementById("setting-always-on-top"),
  settingSound: document.getElementById("setting-sound"),
  settingAutoLaunch: document.getElementById("setting-auto-launch"),
};

let sessions = [];
let permissions = [];
let permissionSnapshotReady = false;
let prevStates = new Map(); // id -> state, for flash/sound on transition
let cfg = { alwaysOnTop: true, sound: false, autoLaunch: true, terminalCommand: "claude" };
let toastTimer = null;

function beep() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain).connect(ctx.destination);
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  osc.start();
  osc.stop(ctx.currentTime + 0.35);
  osc.onended = () => ctx.close();
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
  return s.cwd || "";
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
}

function renderPermissions() {
  els.permissions.classList.toggle("hidden", permissions.length === 0);
  document.body.classList.toggle("has-permissions", permissions.length > 0);
  els.permissions.replaceChildren(...permissions.map(buildPermissionCard));
  refreshEmptyState();
}

function refreshEmptyState() {
  els.empty.classList.toggle("hidden", sessions.length > 0 || permissions.length > 0);
}

function buildPermissionCard(request) {
  const card = document.createElement("article");
  card.className = "permission-card";
  card.dataset.reqId = request.req_id;

  const head = document.createElement("div");
  head.className = "permission-head";
  const project = document.createElement("strong");
  project.className = "permission-project";
  project.textContent = request.project;
  project.title = request.cwd;
  const tool = document.createElement("span");
  tool.className = "permission-tool";
  tool.textContent = request.tool_name;
  head.append(project, tool);

  const summary = document.createElement("div");
  summary.className = "permission-summary";
  summary.textContent = request.input_summary || "该工具请求本次执行权限";
  summary.title = summary.textContent;

  const actions = document.createElement("div");
  actions.className = "permission-actions";
  const deny = permissionButton("本次拒绝", "deny");
  const allow = permissionButton("本次允许", "allow");
  actions.append(deny, allow);

  for (const button of [deny, allow]) {
    button.addEventListener("click", async () => {
      deny.disabled = true;
      allow.disabled = true;
      permissions = permissions.filter((item) => item.req_id !== request.req_id);
      renderPermissions();
      let result = null;
      try {
        result = await window.ccPanel.resolvePermission(request.req_id, button.dataset.decision);
      } catch {}
      if (!result || !result.ok) {
        try {
          const state = await window.ccPanel.getState();
          applyPermissionSnapshot(state.permissions || []);
        } catch {}
        showToast("权限请求已失效，请在终端中处理");
      }
    });
  }

  card.append(head, summary, actions);
  return card;
}

function permissionButton(label, decision) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `permission-btn ${decision}`;
  button.dataset.decision = decision;
  button.textContent = label;
  return button;
}

function buildCard(s) {
  const card = document.createElement("div");
  card.className = "card" + (s.hasWindow ? "" : " no-window");
  card.dataset.state = s.state;
  card.dataset.id = s.id;

  const head = document.createElement("div");
  head.className = "head";
  const dot = document.createElement("span");
  dot.className = "dot";
  const project = document.createElement("span");
  project.className = "project";
  project.textContent = s.project;
  project.title = s.cwd;
  head.append(dot, project);

  const meta = document.createElement("div");
  meta.className = "meta";

  if (!s.hasWindow) {
    const tag = document.createElement("span");
    tag.className = "no-win-tag";
    tag.textContent = "无窗口";
    meta.append(tag);
  }

  const status = document.createElement("span");
  status.className = "state-label";
  status.textContent = STATE_LABEL[s.state] || s.state;
  meta.append(status);

  card.append(head, meta);

  const context = document.createElement("div");
  context.className = "session-context";
  const client = document.createElement("span");
  client.textContent = clientLabel(s);
  const separator = document.createElement("span");
  separator.className = "context-separator";
  separator.textContent = "·";
  const elapsed = document.createElement("span");
  elapsed.className = "state-age";
  elapsed.dataset.state = s.state;
  elapsed.dataset.since = String(s.stateSince);
  elapsed.textContent = stateAgeLabel(s);
  elapsed.title = s.stateSince
    ? `当前状态始于 ${new Date(s.stateSince).toLocaleString()}`
    : "";
  context.append(client, separator, elapsed);
  card.append(context);

  const detailStr = detailText(s);
  if (detailStr) {
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = detailStr;
    detail.title = detailStr;
    card.append(detail);
  }

  card.addEventListener("click", async () => {
    if (!s.hasWindow) {
      showToast("未找到该会话的终端窗口");
      return;
    }
    const result = await window.ccPanel.focusSession(s.id);
    if (!result.ok) {
      showToast(result.reason === "gone" ? "终端窗口已关闭" : "无法聚焦窗口");
    }
  });

  return card;
}

function applySnapshot(snapshot) {
  const changed = [];
  for (const s of snapshot) {
    const prev = prevStates.get(s.id);
    if (prev !== undefined && prev !== s.state && NOTIFY_STATES.has(s.state)) {
      changed.push(s.id);
    }
    prevStates.set(s.id, s.state);
  }
  for (const id of [...prevStates.keys()]) {
    if (!snapshot.some((s) => s.id === id)) prevStates.delete(id);
  }

  sessions = snapshot;
  render();

  if (changed.length) {
    for (const id of changed) {
      const el = els.cards.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (el) {
        el.classList.remove("flash");
        void el.offsetWidth; // restart animation
        el.classList.add("flash");
      }
    }
    if (cfg.sound) beep();
  }
}

function applyPermissionSnapshot(snapshot) {
  const previousIds = new Set(permissions.map((item) => item.req_id));
  const hasNewRequest = permissionSnapshotReady && snapshot.some((item) => !previousIds.has(item.req_id));
  permissions = snapshot;
  permissionSnapshotReady = true;
  renderPermissions();
  if (hasNewRequest && cfg.sound) beep();
}

function refreshConfigButtons() {
  els.btnSettings.classList.toggle("active", !els.settingsPanel.classList.contains("hidden"));
  els.settingAlwaysOnTop.checked = !!cfg.alwaysOnTop;
  els.settingSound.checked = !!cfg.sound;
  els.settingAutoLaunch.checked = !!cfg.autoLaunch;
  els.terminalCommand.value = cfg.terminalCommand || "claude";
}


function setSettingsOpen(open) {
  els.settingsPanel.classList.toggle("hidden", !open);
  refreshConfigButtons();
}

async function openTerminal() {
  els.btnTerminal.disabled = true;
  els.terminalCommand.disabled = true;
  try {
    const result = await window.ccPanel.openTerminal(els.terminalCommand.value);
    if (!result.ok && result.reason !== "canceled") {
      const message = result.reason === "unsupported_platform"
        ? "当前系统不支持 Windows Terminal"
        : "无法打开 Windows Terminal";
      showToast(message + (result.error ? "：" + result.error : ""));
    }
  } catch {
    showToast("无法打开 Windows Terminal");
  } finally {
    els.btnTerminal.disabled = false;
    els.terminalCommand.disabled = false;
  }
}

els.btnTerminal.addEventListener("click", openTerminal);
els.terminalCommand.addEventListener("change", async () => {
  cfg = await window.ccPanel.setConfig({ terminalCommand: els.terminalCommand.value });
  refreshConfigButtons();
});

els.btnCollapseTerminals.addEventListener("click", async () => {
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
  cfg = await window.ccPanel.setConfig({ alwaysOnTop: els.settingAlwaysOnTop.checked });
  refreshConfigButtons();
});

els.settingSound.addEventListener("change", async () => {
  cfg = await window.ccPanel.setConfig({ sound: els.settingSound.checked });
  refreshConfigButtons();
});

els.btnSettings.addEventListener("click", () => {
  setSettingsOpen(els.settingsPanel.classList.contains("hidden"));
});

els.settingAutoLaunch.addEventListener("change", async () => {
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
window.ccPanel.onSessions(applySnapshot);
window.ccPanel.onPermissions(applyPermissionSnapshot);
setInterval(() => refreshStateAges(), 1000);

(async function init() {
  const state = await window.ccPanel.getState();
  cfg = state.config;
  refreshConfigButtons();
  if (state.hookInstallStatus && !state.hookInstallStatus.ok) {
    showToast("hooks 自动安装失败：" + (state.hookInstallStatus.error || "未知错误"));
  }
  if (state.autoLaunchStatus && !state.autoLaunchStatus.ok) {
    showToast("开机自启动设置失败：" + (state.autoLaunchStatus.error || "未知错误"));
  }
  applySnapshot(state.sessions);
  applyPermissionSnapshot(state.permissions || []);
})();
