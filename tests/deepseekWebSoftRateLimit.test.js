import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnections, getModelLockUntil } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { executeWithFallback } from "../src/services/fallback.js";
import { getProvider } from "../src/providers/index.js";
import { resetTrafficGuardState } from "../src/services/trafficGuard.js";

const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const tooFrequent = () =>
  new Response(
    JSON.stringify({
      error: { message: "Messages too frequent, please slow down", type: "rate_limit_exceeded" },
    }),
    { status: 429, headers: { "Content-Type": "application/json" } }
  );

/** One attempt with the same provider, model, and request id a client call uses. */
function attempt(executor, requestId) {
  return executeWithFallback({
    provider: getProvider("deepseek-web"),
    targetFormat: "openai",
    upstreamPayload: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] },
    baseHeaders: {},
    executor,
    signal: null,
    resolveUrl: () => "http://upstream.test/api/v0/chat/completions",
    stream: false,
    targetModel: "deepseek-chat",
    requestId,
  });
}

function setup() {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "true");
  setSetting("request_jitter_enabled", "false");
  setSetting("provider_throttle_ms:deepseek-web", "0");
  return addConnection({
    provider: "deepseek-web",
    name: "Sesi web",
    credentials: { token: "session-token" },
  });
}

test("soft rate limit - a 429 on a serial provider never locks the model", async () => {
  const conn = setup();
  // Every call answers the contention 429, so the retry budget is spent and the
  // upstream error reaches the client instead of a cooldown.
  const executor = { execute: async () => tooFrequent() };
  setCustomExecutor(executor);
  try {
    const res = await attempt(executor, "soft-1");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.response.status, 429, "the upstream 429 is relayed as is");
    assert.strictEqual(
      getModelLockUntil(conn.id, "deepseek-chat"),
      null,
      "contention must not lock a healthy account"
    );
    assert.ok(!(getConnections("deepseek-web")[0].cooldown_until > Date.now()), "account stays usable");
  } finally {
    setCustomExecutor(null);
  }
});

test("soft rate limit - the same account is retried and succeeds on the second turn", async () => {
  setup();
  let calls = 0;
  const executor = {
    execute: async () => {
      calls += 1;
      return calls === 1 ? tooFrequent() : ok();
    },
  };
  setCustomExecutor(executor);
  try {
    const res = await attempt(executor, "soft-2");
    assert.strictEqual(res.ok, true, "the retry after the throttle gap answers normally");
    assert.strictEqual(res.upstreamRes.status, 200);
    assert.strictEqual(calls, 2, "exactly one same-account retry");
  } finally {
    setCustomExecutor(null);
  }
});