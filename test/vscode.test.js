const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildVSCodeLaunchSpec,
  directoryKey,
  findOpenDirectories,
  resolveVSCodeExecutable,
  titleContainsProject,
} = require("../src/main/vscode");

test("normalizes VS Code directory keys case-insensitively", () => {
  assert.equal(directoryKey(" C:/Work/Panel/ "), "c:\\work\\panel");
  assert.equal(directoryKey("C:\\"), "c:\\");
  assert.equal(directoryKey(""), null);
});

test("recognizes project names in VS Code window titles", () => {
  assert.equal(titleContainsProject("tpanel - Visual Studio Code", "tpanel"), true);
  assert.equal(titleContainsProject("app.js - tpanel - Visual Studio Code", "tpanel"), true);
  assert.equal(titleContainsProject("tpanel - Visual Studio Code - Insiders", "tpanel"), true);
  assert.equal(titleContainsProject("app.js - tpanel - Visual Studio Code [Administrator]", "tpanel"), true);
  assert.equal(titleContainsProject("Settings - Visual Studio Code", "tpanel"), false);
  assert.equal(titleContainsProject("tpanel - Notepad", "tpanel"), false);
});

test("maps VS Code windows to session directories", () => {
  const open = findOpenDirectories([
    { cwd: "C:\\work\\tpanel" },
    { cwd: "D:\\docs\\website" },
  ], {
    processes: [
      { pid: 10, name: "Code.exe" },
      { pid: 20, name: "notepad.exe" },
    ],
    windows: [
      { pid: 10, title: "app.js - tpanel - Visual Studio Code" },
      { pid: 20, title: "website - Visual Studio Code" },
    ],
  });

  assert.deepEqual([...open], ["c:\\work\\tpanel"]);
});

test("resolves common and PATH VS Code executables", () => {
  const existing = new Set(["C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"]);
  const resolved = resolveVSCodeExecutable({
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    Path: "C:\\Windows\\System32",
  }, (candidate) => existing.has(candidate));
  assert.equal(resolved, "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe");

  const pathResolved = resolveVSCodeExecutable({ Path: "C:\\tools;D:\\apps" }, (candidate) => (
    candidate === "D:\\apps\\code.cmd"
  ));
  assert.equal(pathResolved, "D:\\apps\\code.cmd");

  const parentResolved = resolveVSCodeExecutable({ Path: "D:\\Microsoft VS Code\\bin" }, (candidate) => (
    candidate === "D:\\Microsoft VS Code\\Code.exe"
  ));
  assert.equal(parentResolved, "D:\\Microsoft VS Code\\Code.exe");
});

test("builds direct and command-shim VS Code launch specs", () => {
  assert.deepEqual(buildVSCodeLaunchSpec("D:\\work\\panel", {
    executable: "C:\\VS Code\\Code.exe",
  }), {
    executable: "C:\\VS Code\\Code.exe",
    args: ["--new-window", "D:\\work\\panel"],
    cwd: "D:\\work\\panel",
  });

  assert.deepEqual(buildVSCodeLaunchSpec("D:\\work\\panel", {
    executable: "C:\\VS Code\\bin\\code.cmd",
    environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  }), {
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "\"\"C:\\VS Code\\bin\\code.cmd\" --new-window \"D:\\work\\panel\"\""],
    cwd: "D:\\work\\panel",
  });
});
