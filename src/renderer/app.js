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
const SORT_PRIORITY = {
  needs_input: 0, error: 1, done: 2, working: 3, idle: 4, dead: 5, ended: 6,
};
// transitions worth interrupting the user for
const NOTIFY_STATES = new Set(["needs_input", "done", "error"]);

const els = {
  cards: document.getElementById("cards"),
  empty: document.getElementById("empty"),
  count: document.getElementById("count"),
  toast: document.getElementById("toast"),
  btnTerminal: document.getElementById("btn-terminal"),
  btnSettings: document.getElementById("btn-settings"),
  settingsPanel: document.getElementById("settings-panel"),
  settingAlwaysOnTop: document.getElementById("setting-always-on-top"),
  settingSound: document.getElementById("setting-sound"),
  settingAutoLaunch: document.getElementById("setting-auto-launch"),
};

let sessions = [];
let prevStates = new Map(); // id -> state, for flash/sound on transition
let cfg = { alwaysOnTop: true, sound: false, autoLaunch: true };
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

function render() {
  const sorted = [...sessions].sort((a, b) => {
    const p = (SORT_PRIORITY[a.state] ?? 9) - (SORT_PRIORITY[b.state] ?? 9);
    return p !== 0 ? p : b.stateSince - a.stateSince;
  });

  els.count.textContent = sorted.length ? String(sorted.length) : "";
  els.empty.classList.toggle("hidden", sorted.length > 0);
  els.cards.replaceChildren(...sorted.map(buildCard));
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
      showToast("未找到该会话的 Windows Terminal 窗口");
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

function refreshConfigButtons() {
  els.btnSettings.classList.toggle("active", !els.settingsPanel.classList.contains("hidden"));
  els.settingAlwaysOnTop.checked = !!cfg.alwaysOnTop;
  els.settingSound.checked = !!cfg.sound;
  els.settingAutoLaunch.checked = !!cfg.autoLaunch;
}


function setSettingsOpen(open) {
  els.settingsPanel.classList.toggle("hidden", !open);
  refreshConfigButtons();
}

els.btnTerminal.addEventListener("click", async () => {
  const result = await window.ccPanel.openTerminal();
  if (!result.ok && result.reason !== "canceled") {
    const message = result.reason === "unsupported_platform"
      ? "当前系统不支持 Windows Terminal"
      : "无法打开 Windows Terminal";
    showToast(message + (result.error ? "：" + result.error : ""));
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
})();
