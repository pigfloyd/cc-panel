const test = require("node:test");
const assert = require("node:assert/strict");
const {
  codexSessionIdFromTranscriptPath,
  sessionIdFromPayload,
} = require("../hook/cc-panel-hook");
const { codexEntry } = require("../src/main/hook-installer");

test("uses Codex rollout transcript ID across hook lifecycle events", () => {
  const transcriptPath = "C:\\Users\\ourchem\\.codex\\sessions\\2026\\07\\16\\rollout-2026-07-16T10-00-00-4a2f3c10-1c5e-4a3d-8ac8-5e2b09b3a1ce.jsonl";
  const expected = "codex:4a2f3c10-1c5e-4a3d-8ac8-5e2b09b3a1ce";

  assert.equal(codexSessionIdFromTranscriptPath(transcriptPath), expected.slice("codex:".length));
  assert.equal(sessionIdFromPayload({ session_id: "start-id", transcript_path: transcriptPath }, "codex"), expected);
  assert.equal(sessionIdFromPayload({ session_id: "tool-id", transcript_path: transcriptPath }, "codex"), expected);
  assert.equal(sessionIdFromPayload({ session_id: "stop-id", transcript_path: transcriptPath }, "codex"), expected);
});

test("uses UUIDv7 Codex rollout transcript IDs across hook lifecycle events", () => {
  const transcriptPath = "C:\\Users\\ourchem\\.codex\\sessions\\2026\\07\\16\\rollout-2026-07-16T14-00-00-019f6982-b025-7dc3-9312-59a07c3d7a4d.jsonl";
  const expected = "codex:019f6982-b025-7dc3-9312-59a07c3d7a4d";

  assert.equal(codexSessionIdFromTranscriptPath(transcriptPath), expected.slice("codex:".length));
  assert.equal(sessionIdFromPayload({ session_id: "prompt-id", transcript_path: transcriptPath }, "codex"), expected);
  assert.equal(sessionIdFromPayload({ session_id: "stop-id", transcript_path: transcriptPath }, "codex"), expected);
});

test("prefixes Codex fallback IDs without changing Claude IDs", () => {
  assert.equal(sessionIdFromPayload({ session_id: "session-1" }, "codex"), "codex:session-1");
  assert.equal(sessionIdFromPayload({ session_id: "session-1" }, "claude"), "session-1");
});

test("builds a directly executable Codex Windows hook command", () => {
  const hook = codexEntry("SessionStart").hooks[0];
  assert.match(
    hook.commandWindows,
    /^(?:& "[^"]+cc-panel-hook\.cmd"|\$env:ELECTRON_RUN_AS_NODE="1"; & "[^"]+electron\.exe" "[^"]+cc-panel-hook\.js") SessionStart codex$/i
  );
  assert.doesNotMatch(hook.commandWindows, /(?:cmd\s+\/d\s+\/c|\bset\s+"ELECTRON_RUN_AS_NODE)/i);
  assert.equal(hook.statusMessage, undefined);
});
