const ATTENTION_STATES = new Set(["needs_input", "error"]);
const STATE_PRIORITY = { needs_input: 0, error: 1 };

function isAutoFocusState(state) {
  return ATTENTION_STATES.has(state);
}

function selectAttentionCandidates(transitions, sessions) {
  const currentByCardKey = new Map(
    sessions.map((session) => [session.cardKey, session]),
  );

  return transitions
    .map((transition) => {
      const session = currentByCardKey.get(transition.cardKey);
      if (!session || !session.hasWindow || session.state !== transition.state ||
          Number(session.stateSince) !== Number(transition.stateSince)) return null;
      return { ...session, sequence: transition.sequence };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const priority = STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state];
      return priority || right.sequence - left.sequence;
    });
}

module.exports = { isAutoFocusState, selectAttentionCandidates };
