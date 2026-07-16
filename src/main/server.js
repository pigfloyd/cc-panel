// server.js — localhost HTTP listener that receives hook events.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORTS = [24333, 24334, 24335, 24336, 24337];
const RUNTIME_DIR = path.join(os.homedir(), ".cc-panel");
const RUNTIME_PATH = path.join(RUNTIME_DIR, "runtime.json");
const BODY_LIMIT = 64 * 1024;

function start(onEvent, permissionStore) {
  return new Promise((resolve, reject) => {
    tryPort(0);

    function tryPort(i) {
      if (i >= PORTS.length) {
        reject(new Error("cc-panel: all candidate ports are busy (24333-24337)"));
        return;
      }
      const port = PORTS[i];
      const server = http.createServer((req, res) => handle(req, res, onEvent, permissionStore));
      server.on("error", () => tryPort(i + 1));
      server.listen(port, "127.0.0.1", () => {
        writeRuntime(port);
        resolve({ server, port });
      });
    }
  });
}

function handle(req, res, onEvent, permissionStore) {
  res.setHeader("x-cc-panel", "1");
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/permission-decision") {
    const reqId = cleanString(url.searchParams.get("req_id"), 256);
    const item = reqId && permissionStore ? permissionStore.get(reqId) : null;
    if (!item) {
      writeJson(res, 404, { error: "unknown_request" });
      return;
    }
    writeJson(res, 200, { decision: item.decision });
    return;
  }

  if (req.method !== "POST" || (url.pathname !== "/event" && url.pathname !== "/permission-request")) {
    res.writeHead(404);
    res.end();
    return;
  }

  readJsonBody(req, res, (body) => {
    if (url.pathname === "/event") {
      try { onEvent(body); } catch (err) { console.error("[cc-panel] event error:", err); }
      res.writeHead(200);
      res.end("ok");
      return;
    }

    const request = normalizePermissionRequest(body);
    if (!request || !permissionStore) {
      writeJson(res, 400, { error: "invalid_request" });
      return;
    }
    permissionStore.add(request);
    writeJson(res, 200, { ok: true });
  });
}

function readJsonBody(req, res, onBody) {
  const chunks = [];
  let size = 0;
  let rejected = false;
  req.on("data", (c) => {
    if (rejected) return;
    size += c.length;
    if (size > BODY_LIMIT) {
      rejected = true;
      res.writeHead(413);
      res.end();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (rejected) return;
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {}
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.writeHead(400);
      res.end();
      return;
    }
    onBody(body);
  });
  req.on("error", () => {});
}

function normalizePermissionRequest(body) {
  if (body.type !== "permission-request") return null;
  const reqId = cleanString(body.req_id, 256);
  const sessionId = cleanString(body.session_id, 512);
  const toolName = cleanString(body.tool_name, 120);
  if (!reqId || !sessionId || !toolName) return null;

  return {
    v: 1,
    type: "permission-request",
    req_id: reqId,
    session_id: sessionId,
    project: cleanString(body.project, 240) || "(unknown)",
    cwd: cleanString(body.cwd, 2048) || "",
    tool_name: toolName,
    input_summary: cleanString(body.input_summary, 500) || "",
    ts: Number.isFinite(Number(body.ts)) ? Number(body.ts) : Date.now(),
  };
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeRuntime(port) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tmp = path.join(RUNTIME_DIR, `.runtime.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ app: "cc-panel", port }, null, 2), "utf8");
    fs.renameSync(tmp, RUNTIME_PATH);
  } catch {}
}

function clearRuntime() {
  try { fs.unlinkSync(RUNTIME_PATH); } catch {}
}

module.exports = { start, clearRuntime, handle, normalizePermissionRequest };
