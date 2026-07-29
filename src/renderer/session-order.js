function createStableSessionOrder() {
  const positions = new Map();
  let nextPosition = 0;

  return function orderSessions(snapshot) {
    for (const session of snapshot) {
      const key = session.cardKey || session.id;
      if (!positions.has(key)) positions.set(key, nextPosition++);
    }

    const activeKeys = new Set(snapshot.map((session) => session.cardKey || session.id));
    for (const key of positions.keys()) {
      if (!activeKeys.has(key)) positions.delete(key);
    }

    return [...snapshot].sort((a, b) =>
      positions.get(a.cardKey || a.id) - positions.get(b.cardKey || b.id)
    );
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createStableSessionOrder };
}
