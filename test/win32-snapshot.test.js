const test = require("node:test");
const assert = require("node:assert/strict");
const { snapshot, utf16BytesToString, utf16ArrayToString } = require("../src/main/win32-snapshot");

test("decodes UTF-16LE bytes to strings", () => {
  const ascii = new Uint8Array([
    0x48, 0x00, 0x69, 0x00, 0x2C, 0x00, 0x20, 0x00,
    0x4E, 0x00, 0x61, 0x00, 0x6D, 0x00, 0x65, 0x00,
  ]);
  assert.equal(utf16BytesToString(ascii), "Hi, Name");
  assert.equal(utf16BytesToString(new Uint8Array([0x79, 0x98, 0xEE, 0x76])), "项目");
});

test("decodes char16 arrays to strings", () => {
  assert.equal(utf16ArrayToString(new Uint16Array([0x48, 0x69]), 2), "Hi");
  assert.equal(utf16ArrayToString(new Uint16Array([0x9879, 0x76EE, 0x0000, 0x0000]), 2), "项目");
});

test("snapshot returns the process/window shape", { skip: process.platform !== "win32" }, () => {
  const snap = snapshot();
  assert.ok(snap, "koffi snapshot should be available on Windows");
  assert.ok(Array.isArray(snap.processes) && snap.processes.length > 0);
  assert.ok(Array.isArray(snap.windows));
  for (const process of snap.processes) {
    assert.equal(typeof process.pid, "number");
    assert.equal(typeof process.ppid, "number");
    assert.equal(typeof process.name, "string");
    assert.ok(process.name.length > 0);
  }
  for (const window of snap.windows) {
    assert.equal(typeof window.pid, "number");
    assert.equal(typeof window.hwnd, "string");
    assert.equal(typeof window.className, "string");
    assert.equal(typeof window.title, "string");
  }
});

test("reads cwd and command line for the test process itself", { skip: process.platform !== "win32" }, () => {
  const snap = snapshot();
  const myPid = process.pid;
  const me = snap.processes.find((entry) => entry.pid === myPid);
  assert.ok(me, "the test process should appear in the snapshot");
  // The PEB CurrentDirectory ends with a separator, unlike process.cwd().
  assert.equal(me.cwd.replace(/[\\/]+$/, ""), process.cwd().replace(/[\\/]+$/, ""));
  assert.ok(me.commandLine && me.commandLine.length > 0);
});

test("preserves Chinese working-directory names from the PEB", { skip: process.platform !== "win32" }, async () => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "项目-中文目录-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], {
    cwd: directory,
    stdio: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snap = snapshot();
    const entry = snap.processes.find((candidate) => candidate.pid === child.pid);
    assert.ok(entry, "spawned child should appear in the snapshot");
    assert.ok(entry.cwd.includes("项目-中文目录-"), `expected Chinese cwd, got ${JSON.stringify(entry.cwd)}`);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
