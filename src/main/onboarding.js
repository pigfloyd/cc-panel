const { execFileSync } = require("child_process");

function commandAvailable(command, platform = process.platform) {
  try {
    if (platform === "win32") {
      execFileSync("where.exe", [command], { stdio: "ignore", windowsHide: true });
    } else {
      execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function detectClients(check = commandAvailable) {
  return {
    claude: !!check("claude"),
    codex: !!check("codex"),
  };
}

function buildOnboardingStatus({ detected, hookStatus, testEvent, completed = false }) {
  const clients = hookStatus && hookStatus.clients ? hookStatus.clients : {};
  const found = Object.values(detected || {}).some(Boolean);
  const detectedClients = Object.entries(detected || {})
    .filter(([, available]) => available)
    .map(([name]) => name);
  const hooksReady = found && detectedClients.every((name) => (
    clients[name] && clients[name].status !== "not_installed" && clients[name].status !== "failed"
  ));
  const trustReady = !detected.codex || (clients.codex && clients.codex.status === "installed");
  const testReady = !!(testEvent && testEvent.ok);
  const ready = found && hooksReady && trustReady && testReady;

  return {
    completed: !!completed,
    ready,
    detected,
    hookStatus,
    testEvent: testEvent || { ok: false },
    steps: {
      discover: { ok: found },
      hooks: { ok: hooksReady },
      trust: { ok: trustReady, required: !!detected.codex },
      test: { ok: testReady },
    },
  };
}

module.exports = { commandAvailable, detectClients, buildOnboardingStatus };
