const test = require("node:test");
const assert = require("node:assert/strict");
const { detectClients, buildOnboardingStatus } = require("../src/main/onboarding");

test("detects Claude and Codex independently", () => {
  assert.deepEqual(detectClients((command) => command === "codex"), {
    claude: false,
    codex: true,
  });
});

test("requires Codex trust when Codex is detected", () => {
  const status = buildOnboardingStatus({
    detected: { claude: true, codex: true },
    hookStatus: {
      clients: {
        claude: { status: "installed" },
        codex: { status: "pending_trust" },
      },
    },
    testEvent: { ok: true },
  });

  assert.equal(status.steps.discover.ok, true);
  assert.equal(status.steps.hooks.ok, true);
  assert.equal(status.steps.trust.ok, false);
  assert.equal(status.ready, false);
});

test("is ready when detected clients, hooks, trust, and test event are ready", () => {
  const status = buildOnboardingStatus({
    detected: { claude: false, codex: true },
    hookStatus: { clients: { codex: { status: "installed" } } },
    testEvent: { ok: true },
  });

  assert.equal(status.steps.hooks.ok, true);
  assert.equal(status.steps.trust.required, true);
  assert.equal(status.ready, true);
});

test("does not accept hook installation when no supported client was found", () => {
  const status = buildOnboardingStatus({
    detected: { claude: false, codex: false },
    hookStatus: { clients: {} },
    testEvent: { ok: true },
  });

  assert.equal(status.steps.discover.ok, false);
  assert.equal(status.steps.hooks.ok, false);
  assert.equal(status.ready, false);
});

test("does not treat Claude's pre-initialization state as an installed hook", () => {
  const status = buildOnboardingStatus({
    detected: { claude: true, codex: false },
    hookStatus: { clients: { claude: { status: "pending_trust" } } },
    testEvent: { ok: true },
  });

  assert.equal(status.steps.hooks.ok, false);
  assert.equal(status.ready, false);
});
