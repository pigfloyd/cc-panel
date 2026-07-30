// server.js — localhost HTTP listener that receives hook events.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORTS = [24333, 24334, 24335, 24336, 24337];
const RUNTIME_DIR = path.join(os.homedir(), ".cc-panel");
const RUNTIME_PATH = path.join(RUNTIME_DIR, "runtime.json");
const BODY_LIMIT = 64 * 1024;

function start(onEvent) {
  return new Promise((resolve, reject) => {
    tryPort(0);

    function tryPort(i) {
      if (i >= PORTS.length) {
        reject(new Error("cc-panel: all candidate ports are busy (24333-24337)"));
        return;
      }
      const port = PORTS[i];
      const server = http.createServer((req, res) => handle(req, res, onEvent));
      server.on("error", () => tryPort(i + 1));
      server.listen(port, "127.0.0.1", () => {
        writeRuntime(port);
        resolve({ server, port });
      });
    }
  });
}

function handle(req, res, onEvent) {
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

  if (req.method !== "POST" || url.pathname !== "/event") {
    res.writeHead(404);
    res.end();
    return;
  }

  readJsonBody(req, res, (body) => {
    try { onEvent(body); } catch (err) { console.error("[cc-panel] event error:", err); }
    res.writeHead(200);
    res.end("ok");
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

function sendTestEvent(port) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      __ccPanelTest: true,
      session_id: `cc-panel-onboarding-${Date.now()}`,
    });
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/event",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({
        ok: response.statusCode === 200 && response.headers["x-cc-panel"] === "1",
        statusCode: response.statusCode,
        testedAt: Date.now(),
      }));
    });
    request.setTimeout(2000, () => request.destroy(new Error("test event timed out")));
    request.on("error", (err) => resolve({
      ok: false,
      error: String(err.message || err),
      testedAt: Date.now(),
    }));
    request.end(body);
  });
}

module.exports = { start, clearRuntime, handle, sendTestEvent };
