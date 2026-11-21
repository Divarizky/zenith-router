import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, deleteConnection, getConnections, getModelLockUntil, setConnectionCooldown } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { setSetting } from "../src/services/settings.js";
import { acquireAccountSlot, getConnectionTraffic, resetTrafficGuardState } from "../src/services/trafficGuard.js";
import { sessionPins } from "../src/services/sessionPin.js";
import { executeWithFallback } from "../src/services/fallback.js";
import { getProvider } from "../src/providers/index.js";
import { createApiKey } from "../src/services/apiKeys.js";

const MODEL = "glm-4-flash";
const ACC_1 = "Bearer key-1";
const ACC_2 = "Bearer key-2";

function chat(sessionId) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) headers["x-session-id"] = sessionId;
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: `glm/${MODEL}`, messages: [{ role: "user", content: "hi" }] }),
  });
}

function recordingExecutor(attempts, status = 200) {
  return {
    async execute({ headers }) {
      attempts.push(headers.Authorization || headers.authorization);
      const body = status === 200
        ? JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] })
        : JSON.stringify({ error: { message: "upstream" } });
      return new Response(body, { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

function setup() {
  initDb(":memory:");
  resetTrafficGuardState();
  sessionPins.clear();
  setSetting("max_account_concurrency", "1");
  setSetting("request_jitter_enabled", "false");
  const a = addConnection({ provider: "glm", name: "A", credentials: { api_key: "key-1" } });
  const b = addConnection({ provider: "glm", name: "B", credentials: { api_key: "key-2" } });
  return { a, b };
}

function connById(id) {
  return getConnections("glm").find((c) => c.id === id);
}

test("pin lifecycle - a pin to a deleted account is never used and falls through to a sibling", async () => {
  const { a } = setup();
  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  try {
    assert.strictEqual((await chat("sess-del")).status, 200);
    assert.strictEqual(attempts.at(-1), ACC_1, "turn 1 jatuh ke akun A dan dipin");
    deleteConnection(a.id);
    assert.strictEqual((await chat("sess-del")).status, 200);
    assert.strictEqual(attempts.at(-1), ACC_2, "pin ke akun terhapus tidak dipakai");
  } finally {
    setCustomExecutor(null);
  }
});

test("pin lifecycle - a pinned account that is full (max_concurrent) is skipped without waiting in its queue", async () => {
  const { a } = setup();
  // A short queue timeout makes waiting on the full account visible as latency.
  setSetting("provider_queue_timeout_ms:glm", "1500");
  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  let release = null;
  try {
    // A request with tools is purpose "main", which uses the provider queue timeout.
    const withTools = (sessionId) =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": sessionId },
        body: JSON.stringify({
          model: `glm/${MODEL}`,
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "noop", parameters: { type: "object", properties: {} } } }],
        }),
      });
    assert.strictEqual((await withTools("sess-full")).status, 200);
    assert.strictEqual(attempts.at(-1), ACC_1);
    release = await acquireAccountSlot(connById(a.id), null, { purpose: "main" });
    assert.strictEqual(getConnectionTraffic(a.id).inFlight, 1, "akun A penuh");

    const started = Date.now();
    const res = await withTools("sess-full");
    const elapsed = Date.now() - started;
    assert.strictEqual(res.status, 200);
    assert.strictEqual(attempts.at(-1), ACC_2, "akun pin penuh dilewati ke saudara");
    assert.ok(elapsed < 1000, `sesi tidak menunggu antrean akun penuh (${elapsed} ms, batas antrean 1500 ms)`);
  } finally {
    if (release) release();
    setSetting("provider_queue_timeout_ms:glm", "");
    setCustomExecutor(null);
  }
});

test("pin lifecycle - a noFailover probe neither reads nor writes the session pin", async () => {
  setup();
  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  try {
    assert.strictEqual((await chat("sess-probe")).status, 200);
    assert.strictEqual(attempts.at(-1), ACC_1);

    // Pin the session to account B. A probe that wrote its own pin would move it back to A.
    const b = getConnections("glm").find((c) => c.name === "B");
    sessionPins.set("glm", "sess-probe", b.id, MODEL);
    attempts.length = 0;
    await executeWithFallback({
      provider: getProvider("glm"),
      targetFormat: "openai",
      upstreamPayload: { model: MODEL, messages: [{ role: "user", content: "probe" }] },
      baseHeaders: {},
      executor: recordingExecutor(attempts, 500),
      signal: null,
      resolveUrl: () => "http://upstream.test/v1/chat/completions",
      stream: false,
      targetModel: MODEL,
      sessionKey: "sess-probe",
      sessionSource: "header",
      noFailover: true,
    });
    assert.strictEqual(sessionPins.get("glm", "sess-probe", MODEL), b.id, "probe tidak menulis pin baru");
    assert.strictEqual(attempts.length, 1, "probe noFailover tidak mencoba akun lain");
    assert.strictEqual(attempts[0], ACC_1, "probe memakai urutan biasa, bukan akun pin B");
  } finally {
    setCustomExecutor(null);
  }
});

test("pin lifecycle - a session key from a gateway API key is never pinned", async () => {
  setup();
  const attempts = [];
  await executeWithFallback({
    provider: getProvider("glm"),
    targetFormat: "openai",
    upstreamPayload: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
    baseHeaders: {},
    executor: recordingExecutor(attempts),
    signal: null,
    resolveUrl: () => "http://upstream.test/v1/chat/completions",
    stream: false,
    targetModel: MODEL,
    sessionKey: "apikey:team-1",
    sessionSource: "apikey",
  });
  assert.strictEqual(sessionPins.get("glm", "apikey:team-1", MODEL), null, "API key tidak dipin");
  assert.strictEqual(sessionPins.size(), 0, "tidak ada pin sama sekali");
});

test("pin lifecycle x #4 - a pinned account with a 24-hour model lock hops to its sibling", async () => {
  const { a } = setup();
  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  try {
    assert.strictEqual((await chat("sess-lock")).status, 200);
    assert.strictEqual(attempts.at(-1), ACC_1);
    setConnectionCooldown(a.id, Date.now() + 24 * 60 * 60 * 1000, MODEL, { lockClass: "quota" });
    assert.ok(getModelLockUntil(a.id, MODEL) > Date.now() + 60 * 60 * 1000, "lock 24 jam aktif");
    assert.strictEqual((await chat("sess-lock")).status, 200);
    assert.strictEqual(attempts.at(-1), ACC_2, "akun pin terkunci pindah ke saudara");
  } finally {
    setCustomExecutor(null);
  }
});

test("pin lifecycle x #6 - a pinned account returning a large error body still hops to its sibling", async () => {
  setup();
  const big = "x".repeat(200_000);
  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      attempts.push(auth);
      if (auth === ACC_1) {
        return new Response(JSON.stringify({ error: { message: big } }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    const res = await chat("sess-big");
    assert.strictEqual(res.status, 200, "error besar dibaca terpotong dan request pindah ke akun 2");
    assert.deepStrictEqual(attempts, [ACC_1, ACC_2]);
  } finally {
    setCustomExecutor(null);
  }
});

test("cross-issue #4/#5/#6 - a pinned account hit by a large 429 quota parks until its reset and the next turn moves to a healthy sibling", async () => {
  const { a } = setup();
  const SIX_HOURS = 6 * 60 * 60;
  const quotaBody = JSON.stringify({
    error: { message: "daily quota exhausted", code: "rate_limit_exceeded" },
    padding: "x".repeat(200_000),
  });
  let quotaOnA = false;
  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      attempts.push(auth);
      if (auth === ACC_1 && quotaOnA) {
        return new Response(quotaBody, {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": String(SIX_HOURS) },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    // Turn 1 pins session "sess-quota" to account A.
    assert.strictEqual((await chat("sess-quota")).status, 200);
    assert.strictEqual(attempts.at(-1), ACC_1);

    // Account A starts answering 429 with a large body. A park needs two failed requests on A
    // (strikes), so a second session that is pinned to A fails there too. Every turn still succeeds on B.
    assert.strictEqual((await chat("sess-other")).status, 200);
    quotaOnA = true;
    attempts.length = 0;
    assert.strictEqual((await chat("sess-quota")).status, 200, "429 dari A dibaca lalu pindah ke B");
    assert.deepStrictEqual(attempts, [ACC_1, ACC_2], "satu 429 dari A, lalu B melayani");
    attempts.length = 0;
    assert.strictEqual((await chat("sess-other")).status, 200, "sesi kedua juga pindah ke B");
    assert.deepStrictEqual(attempts, [ACC_1, ACC_2]);

    // Lock on A extends to the reset, not to the one-hour transient cap.
    const lockUntil = getModelLockUntil(a.id, MODEL);
    assert.ok(lockUntil, "akun A terparkir setelah kegagalan berulang");
    const remainingH = (lockUntil - Date.now()) / 3600_000;
    assert.ok(remainingH > 5.9 && remainingH <= 6.01, `lock mengikuti reset 6 jam (sisa ${remainingH.toFixed(2)} jam)`);

    // Next turn is served by the healthy sibling, not the parked account.
    attempts.length = 0;
    assert.strictEqual((await chat("sess-quota")).status, 200);
    assert.strictEqual(attempts.at(-1), ACC_2, "turn berikutnya pindah ke akun sehat");
  } finally {
    setCustomExecutor(null);
  }
});

test("pin lifecycle - a pin to a deleted account is dropped from the store on first use", async () => {
  const { a } = setup();
  // Turn 2 fails on the sibling, so no new pin overwrites the stale entry.
  setCustomExecutor(recordingExecutor([], 500));
  try {
    setCustomExecutor(recordingExecutor([]));
    assert.strictEqual((await chat("sess-lazy")).status, 200);
    assert.strictEqual(sessionPins.get("glm", "sess-lazy", MODEL), a.id, "turn 1 memasang pin ke akun A");
    deleteConnection(a.id);
    setCustomExecutor(recordingExecutor([], 500));
    await chat("sess-lazy");
    assert.strictEqual(sessionPins.get("glm", "sess-lazy", MODEL), null, "pin ke id terhapus dibersihkan saat dipakai");
  } finally {
    setCustomExecutor(null);
  }
});

test("regression #4 - a 5xx with a one-day Retry-After stays transient: the model lock is capped to one hour", async () => {
  const { a } = setup();
  const ONE_DAY = 86400;
  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      attempts.push(auth);
      if (auth === ACC_1) {
        return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": String(ONE_DAY) },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    // Two failures on different sessions meet the strike threshold for account A.
    await chat("sess-5xx-1");
    await chat("sess-5xx-2");
    const until = getModelLockUntil(a.id, MODEL);
    const cap = Date.now() + 60 * 60 * 1000;
    assert.ok(until && until > Date.now(), "the 5xx must leave a model lock in place");
    assert.ok(until <= cap + 5000, `5xx lock ${until - Date.now()} ms exceeds the one-hour transient cap`);
  } finally {
    setCustomExecutor(null);
  }
});

test("pin lifecycle - a gateway key source (apikey) with its local apiKeyId never writes or reads a pin", async () => {
  setup();
  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  try {
    const res = await executeWithFallback({
      provider: getProvider("glm"),
      targetFormat: "openai",
      upstreamPayload: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
      baseHeaders: {},
      executor: recordingExecutor(attempts),
      signal: null,
      resolveUrl: () => "http://upstream.test/v1/chat/completions",
      stream: false,
      targetModel: MODEL,
      sessionKey: "apikey:team-7",
      sessionSource: "apikey",
      sessionApiKeyId: "team-7",
    });
    assert.strictEqual(res.ok, true, "the request is served normally");
    assert.strictEqual(res.upstreamRes.status, 200);
    assert.strictEqual(sessionPins.size(), 0, "a gateway key never creates a pin");
    assert.strictEqual(sessionPins.get("glm", "apikey:team-7", MODEL), null);
  } finally {
    setCustomExecutor(null);
  }
});

// Two gateway keys send the same x-session-id. Each key is created in memory by createApiKey, so the
// test never holds a literal credential. The local key id must keep their pins apart.
function chatWithKey(sessionId, key) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId, authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: `glm/${MODEL}`, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("pin lifecycle - two gateway keys with the same x-session-id keep separate pins", async () => {
  setup();
  const keyOne = createApiKey("team-one");
  const keyTwo = createApiKey("team-two");
  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  try {
    assert.strictEqual((await chatWithKey("shared-sess", keyOne.key)).status, 200);
    assert.strictEqual((await chatWithKey("shared-sess", keyTwo.key)).status, 200);
    // Each key has one pin under its own namespace: the store holds two entries, not one shared entry.
    assert.strictEqual(sessionPins.size(), 2, "the two keys do not share one pin");
    // Each key's pin is reachable only under its own scope.
    assert.strictEqual(sessionPins.get("glm", "shared-sess", MODEL, `client:${keyOne.id}`) !== null, true, "key one owns a pin");
    assert.strictEqual(sessionPins.get("glm", "shared-sess", MODEL, `client:${keyTwo.id}`) !== null, true, "key two owns a pin");
  } finally {
    setCustomExecutor(null);
  }
});
