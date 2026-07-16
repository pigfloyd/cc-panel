const MIN_WINDOW_WIDTH = 300;
const MIN_WINDOW_HEIGHT = 400;

function isRect(rect) {
  return rect
    && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0
    && rect.height > 0;
}

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampToWorkArea(bounds, workArea) {
  const minWidth = Math.min(MIN_WINDOW_WIDTH, workArea.width);
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, workArea.height);
  const width = clamp(Math.round(bounds.width), minWidth, workArea.width);
  const height = clamp(Math.round(bounds.height), minHeight, workArea.height);

  return {
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function ensureVisibleBounds(savedBounds, displays, fallbackBounds) {
  if (!isRect(savedBounds)) return fallbackBounds;

  let matchingDisplay = null;
  let largestIntersection = 0;
  for (const display of displays) {
    const displayBounds = display && display.bounds;
    const workArea = display && display.workArea;
    if (!isRect(displayBounds) || !isRect(workArea)) continue;

    const area = intersectionArea(savedBounds, displayBounds);
    if (area > largestIntersection) {
      largestIntersection = area;
      matchingDisplay = display;
    }
  }

  if (!matchingDisplay) return fallbackBounds;
  return clampToWorkArea(savedBounds, matchingDisplay.workArea);
}

module.exports = {
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  ensureVisibleBounds,
};
