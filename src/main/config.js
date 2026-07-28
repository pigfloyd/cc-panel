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
  autoLaunch: true,
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
    return loaded;
  } catch {
    return null;
  }
}

function load() {
  return readConfig(CONFIG_PATH) || readConfig(LEGACY_CONFIG_PATH) || { ...DEFAULTS };
}

function save(config) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = path.join(DIR, `.config.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
    fs.renameSync(tmp, CONFIG_PATH);
  } catch {}
}

module.exports = { load, save, DIR };
