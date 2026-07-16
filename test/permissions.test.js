const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { PermissionStore } = require("../src/main/permissions");
const { handle, normalizePermissionRequest } = require("../src/main/server");
const {
  codexSessionIdFromTranscriptPath,
  inputSummary,
  sessionIdFromPayload,
  shouldHandlePermission,
} = require("../hook/cc-panel-hook");
const { codexEntry } = require("../src/main/hook-installer");

function request(overrides = {}) {
  return {
    v: 1,
    type: "permission-request",
    req_id: "request-1",
    session_id: "session-1",
    project: "tpanel",
    cwd: "D:\\personal\\tpanel",
    tool_name: "Bash",
    input_summary: "npm test",
    ts: 123,
    ...overrides,
  };
}

test("keeps a resolved decision available while removing it from the pending snapshot", () => {
  const snapshots = [];
  const store = new PermissionStore((snapshot) => snapshots.push(snapshot));
  try {
    store.add(request());
    assert.equal(store.snapshot().length, 1);
    assert.equal(store.resolve("request-1", "allow"), true);
    assert.deepEqual(store.snapshot(), []);
    assert.equal(store.get("request-1").decision, "allow");
    assert.equal(store.resolve("request-1", "deny"), false);
    assert.deepEqual(snapshots.map((snapshot) => snapshot.length), [1, 0]);
  } finally {
    store.dispose();
  }
});

test("expires stale permission requests", () => {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const store = new PermissionStore(null, { ttlMs: 100 });
  try {
    store.add(request());
    now += 101;
    assert.deepEqual(store.snapshot(), []);
    assert.equal(store.get("request-1"), null);
  } finally {
    store.dispose();
    Date.now = realNow;
  }
});

test("normalizes permission payloads at the HTTP boundary", () => {
  assert.deepEqual(normalizePermissionRequest(request()), request());
  assert.equal(normalizePermissionRequest(request({ req_id: "" })), null);
  assert.equal(normalizePermissionRequest({ ...request(), type: "event" }), null);
});

test("summarizes tool input and hides likely secrets", () => {
  assert.equal(inputSummary({ tool_name: "Bash", tool_input: { command: "npm test\necho done" } }), "npm test");
  assert.equal(inputSummary({ tool_name: "Edit", tool_input: { file_path: "src/main/index.js" } }), "src/main/index.js");
  assert.equal(
    inputSummary({ tool_name: "Bash", tool_input: { command: "curl -H 'Authorization: Bearer abc'" } }),
    "[内容包含敏感信息，已隐藏]"
  );
});

test("keeps Codex permission events on the status-only path", () => {
  assert.equal(shouldHandlePermission("PermissionRequest", "claude"), true);
  assert.equal(shouldHandlePermission("PermissionRequest", "codex"), false);
});

test("uses Codex rollout transcript ID across hook lifecycle events", () => {
  const transcriptPath = "C:\\Users\\ourchem\\.codex\\sessions\\2026\\07\\16\\rollout-2026-07-16T10-00-00-4a2f3c10-1c5e-4a3d-8ac8-5e2b09b3a1ce.jsonl";
  const expected = "codex:4a2f3c10-1c5e-4a3d-8ac8-5e2b09b3a1ce";

  assert.equal(codexSessionIdFromTranscriptPath(transcriptPath), expected.slice("codex:".length));
  assert.equal(sessionIdFromPayload({ session_id: "start-id", transcript_path: transcriptPath }, "codex"), expected);
  assert.equal(sessionIdFromPayload({ session_id: "tool-id", transcript_path: transcriptPath }, "codex"), expected);
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
    /^\$env:ELECTRON_RUN_AS_NODE="1"; & "[^"]+electron\.exe" "[^"]+cc-panel-hook\.js" SessionStart codex$/i
  );
  assert.doesNotMatch(hook.commandWindows, /(?:cmd\s+\/d\s+\/c|\bset\s+"ELECTRON_RUN_AS_NODE)/i);
});

test("round-trips permission decisions through the HTTP boundary", async () => {
  const store = new PermissionStore();
  const server = http.createServer((req, res) => handle(req, res, () => {}, store));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const created = await httpJson(port, "POST", "/permission-request", request());
    assert.equal(created.status, 200);

    const pending = await httpJson(port, "GET", "/permission-decision?req_id=request-1");
    assert.deepEqual(pending.body, { decision: null });

    assert.equal(store.resolve("request-1", "deny"), true);
    const resolved = await httpJson(port, "GET", "/permission-decision?req_id=request-1");
    assert.deepEqual(resolved.body, { decision: "deny" });

    const missing = await httpJson(port, "GET", "/permission-decision?req_id=missing");
    assert.equal(missing.status, 404);
  } finally {
    store.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

function httpJson(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const encoded = body ? JSON.stringify(body) : "";
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: encoded ? {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(encoded),
      } : undefined,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}
