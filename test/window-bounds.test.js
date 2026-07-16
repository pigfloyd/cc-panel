const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureVisibleBounds } = require("../src/main/window-bounds");

const displays = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  },
  {
    id: 2,
    bounds: { x: 1920, y: -200, width: 1280, height: 1024 },
    workArea: { x: 1920, y: -160, width: 1280, height: 984 },
  },
];
const fallback = { x: 1540, y: 0, width: 380, height: 940 };

test("keeps saved bounds that fit the current work area", () => {
  assert.deepEqual(
    ensureVisibleBounds({ x: 2100, y: -100, width: 380, height: 800 }, displays, fallback),
    { x: 2100, y: -100, width: 380, height: 800 },
  );
});

test("clamps partially visible saved bounds into the matching work area", () => {
  assert.deepEqual(
    ensureVisibleBounds({ x: 3100, y: -190, width: 500, height: 1100 }, displays, fallback),
    { x: 2700, y: -160, width: 500, height: 984 },
  );
});

test("uses current defaults when the saved display has been removed", () => {
  assert.deepEqual(
    ensureVisibleBounds({ x: 3500, y: 100, width: 380, height: 800 }, displays, fallback),
    fallback,
  );
});

test("clamps dimensions after display scaling or resolution changes", () => {
  const singleDisplay = [{
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    workArea: { x: 0, y: 0, width: 1280, height: 680 },
  }];

  assert.deepEqual(
    ensureVisibleBounds({ x: 100, y: 100, width: 1800, height: 900 }, singleDisplay, fallback),
    { x: 0, y: 0, width: 1280, height: 680 },
  );
});

test("uses current defaults for malformed saved bounds", () => {
  assert.deepEqual(
    ensureVisibleBounds({ x: null, y: 10, width: 380, height: 800 }, displays, fallback),
    fallback,
  );
});
