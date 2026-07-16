function createStableSessionOrder() {
  const positions = new Map();
  let nextPosition = 0;

  return function orderSessions(snapshot) {
    for (const session of snapshot) {
      if (!positions.has(session.id)) positions.set(session.id, nextPosition++);
    }

    const activeIds = new Set(snapshot.map((session) => session.id));
    for (const id of positions.keys()) {
      if (!activeIds.has(id)) positions.delete(id);
    }

    return [...snapshot].sort((a, b) => {
      const attentionA = a.state === "needs_input" || a.state === "error" ? 0 : 1;
      const attentionB = b.state === "needs_input" || b.state === "error" ? 0 : 1;
      return attentionA - attentionB || positions.get(a.id) - positions.get(b.id);
    });
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createStableSessionOrder };
}
