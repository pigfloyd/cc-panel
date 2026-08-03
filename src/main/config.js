// config.js — persist panel settings in ~/.cc-panel/config.json
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.join(os.homedir(), ".cc-panel");
const CONFIG_PATH = path.join(DIR, "config.json");
const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".tpanel", "config.json");

const DEFAULTS = {
  bounds: null,          // {x,y,width,height}
  alwaysOnTop: true,
  sound: false,
  autoFocusAttention: false,
  openVSCodeWithTerminal: false,
  language: "zh-CN",
  autoLaunch: true,
  hooksEnabled: true,
  onboardingCompleted: false,
  terminalDir: null,
  terminalHistory: [],
  terminalCommand: "claude",
  terminalExecutable: null,
};

function readConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const loaded = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
    delete loaded.compactMode;
    delete loaded.showPromptSummary;
    return loaded;
  } catch {
    return null;
  }
}

function load() {
  return readConfig(CONFIG_PATH) || readConfig(LEGACY_CONFIG_PATH) || { ...DEFAULTS };
}

function save(config) {
  const tmp = path.join(DIR, `.config.${process.pid}.tmp`);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

function update(current, mutator) {
  const next = { ...current };
  mutator(next);
  save(next);
  return next;
}

module.exports = { load, save, update, DIR, DEFAULTS };
