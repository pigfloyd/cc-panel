const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_TERMINAL_HISTORY,
  normalizeTerminalDirectory,
  normalizeTerminalHistory,
  recordTerminalDirectory,
  terminalHistoryIncludes,
  removeTerminalDirectory,
} = require("../src/main/terminal-history");

test("normalizes absolute Windows terminal directories", () => {
  assert.equal(normalizeTerminalDirectory("  C:/work/project/  "), "C:\\work\\project\\");
  assert.equal(normalizeTerminalDirectory("project"), null);
  assert.equal(normalizeTerminalDirectory(""), null);
});

test("keeps five unique terminal directories in recent-first order", () => {
  const history = normalizeTerminalHistory([
    "C:\\one",
    "c:/ONE",
    "C:\\two",
    "C:\\three",
    "C:\\four",
    "C:\\five",
    "C:\\six",
  ]);

  assert.equal(history.length, MAX_TERMINAL_HISTORY);
  assert.deepEqual(history, ["C:\\one", "C:\\two", "C:\\three", "C:\\four", "C:\\five"]);
});

test("promotes reused terminal directories and supports membership and removal", () => {
  const history = recordTerminalDirectory(["C:\\one", "C:\\two"], "c:/TWO");
  assert.deepEqual(history, ["c:\\TWO", "C:\\one"]);
  assert.equal(terminalHistoryIncludes(history, "C:\\two"), true);
  assert.deepEqual(removeTerminalDirectory(history, "c:/two"), ["C:\\one"]);
});
