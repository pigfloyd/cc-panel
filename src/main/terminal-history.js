const path = require("path");

const MAX_TERMINAL_HISTORY = 5;

function normalizeTerminalDirectory(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !path.win32.isAbsolute(trimmed)) return null;
  return path.win32.normalize(trimmed);
}

function normalizeTerminalHistory(value, limit = MAX_TERMINAL_HISTORY) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();

  for (const entry of value) {
    const directory = normalizeTerminalDirectory(entry);
    if (!directory) continue;
    const key = directory.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(directory);
    if (result.length >= limit) break;
  }

  return result;
}

function recordTerminalDirectory(history, directory) {
  return normalizeTerminalHistory([directory, ...(Array.isArray(history) ? history : [])]);
}

function terminalHistoryIncludes(history, directory) {
  const normalized = normalizeTerminalDirectory(directory);
  if (!normalized) return false;
  const key = normalized.toLowerCase();
  return normalizeTerminalHistory(history).some((entry) => entry.toLowerCase() === key);
}

function removeTerminalDirectory(history, directory) {
  const normalized = normalizeTerminalDirectory(directory);
  if (!normalized) return normalizeTerminalHistory(history);
  const key = normalized.toLowerCase();
  return normalizeTerminalHistory(history).filter((entry) => entry.toLowerCase() !== key);
}

module.exports = {
  MAX_TERMINAL_HISTORY,
  normalizeTerminalDirectory,
  normalizeTerminalHistory,
  recordTerminalDirectory,
  terminalHistoryIncludes,
  removeTerminalDirectory,
};
