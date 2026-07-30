const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const config = require("../src/main/config");

test("save propagates write failures and cleans up the temporary file", () => {
  const failure = new Error("access denied");
  const originalMkdirSync = fs.mkdirSync;
  const originalWriteFileSync = fs.writeFileSync;
  const originalRenameSync = fs.renameSync;
  const originalRmSync = fs.rmSync;
  let cleanedPath = null;

  fs.mkdirSync = () => {};
  fs.writeFileSync = () => { throw failure; };
  fs.renameSync = () => { assert.fail("rename must not run after a write failure"); };
  fs.rmSync = (file, options) => {
    cleanedPath = file;
    assert.deepEqual(options, { force: true });
  };

  try {
    assert.throws(() => config.save({ sound: true }), failure);
    assert.equal(path.dirname(cleanedPath), config.DIR);
    assert.match(path.basename(cleanedPath), /^\.config\.\d+\.tmp$/);
  } finally {
    fs.mkdirSync = originalMkdirSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.renameSync = originalRenameSync;
    fs.rmSync = originalRmSync;
  }
});

test("update leaves the in-memory config unchanged when saving fails", () => {
  const original = { sound: false, terminalHistory: ["C:\\work"] };
  const originalWriteFileSync = fs.writeFileSync;

  fs.writeFileSync = () => { throw new Error("disk full"); };
  try {
    assert.throws(() => config.update(original, (next) => {
      next.sound = true;
      next.terminalHistory = ["C:\\other"];
    }), /disk full/);
    assert.deepEqual(original, { sound: false, terminalHistory: ["C:\\work"] });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});
