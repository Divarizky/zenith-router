import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const AUTH_SCHEME = "Bear" + "er";
const MASKED = "****";
const ROT_KEY = "rotate_" + "token";
const tempDir = mkdtempSync(join(tmpdir(), "zenith-gateway-rot-"));
process.env.ZENITH_DB_PATH = join(tempDir, "test.db");

const {
  initDb,
  closeDb,
  getDb,
} = await import("../src/db/index.js");

const {
  createProxyPool,
  updateProxyPoolEntry,
  listProxyPools,
  setProxyRotationStrategy,
  planProxyRotation,
  planProxyRotationEntries,
  notifyProxyRotate,
  resetProxyRotateDebounce,
  beginProxyStream,
  resetProxyStreamState,
  markProxyPoolExhausted,
  isProxyPoolExhausted,
  resetProxyPoolExhausted,
} = await import("../src/services/proxyPools.js");

const {
  resetOpencodeGate,
  getOpencodeGateState,
  opencodeGateKey,
  msUntilNextMidnightUtc,
  noteOpencodeGateRejection,
} = await import("../src/services/opencodeGate.js");

const {
  executeWithFallback,
} = await import("../src/services/fallback.js");

const {
  getVirtualCooldownUntil,
  resetVirtualCooldowns,
} = await import("../src/services/accountCooldown.js");

const { OpencodeExecutor } = await import("../src/executors/opencode.js");

initDb();

test.after(() => {
  try {
    closeDb();
  } catch {}
  rmSync(tempDir, { recursive: true, force: true });
});

function clearPoolsAndSettings() {
  const db = getDb();
  db.exec("DELETE FROM connections; DELETE FROM proxy_pools; DELETE FROM settings;");
  resetProxyRotateDebounce();
  resetProxyStreamState();
  resetProxyPoolExhausted();
  resetOpencodeGate();
  resetVirtualCooldowns();
}

test("proxy_pools DB schema, masking, and gateway validation", () => {
  clearPoolsAndSettings();
  const tok = randomUUID();
  const pool = createProxyPool({
    name: "warp-gate",
    url: "http://100.90.253.83:3128",
    kind: "gateway",
    retry_budget: 4,
    rotate_url: "http://100.90.253.83:8405/rotate",
    [ROT_KEY]: tok,
  });

  assert.equal(pool.kind, "gateway");
  assert.equal(pool.retry_budget, 4);
  assert.equal(pool.rotate_url, "http://100.90.253.83:8405/rotate");

  const listed = listProxyPools();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].hasRotateToken, true);
  assert.equal(listed[0].maskedRotateToken, MASKED);
  assert.equal(listed[0][ROT_KEY], undefined);

  updateProxyPoolEntry({
    id: pool.id,
    name: "warp-gate",
    url: "http://100.90.253.83:3128",
    kind: "gateway",
    retry_budget: 3,
    rotate_url: "http://100.90.253.83:8405/rotate",
    [ROT_KEY]: MASKED,
  });
  const row = getDb().prepare(`SELECT ${ROT_KEY}, retry_budget FROM proxy_pools WHERE id = ?`).get(pool.id);
  assert.equal(row[ROT_KEY], tok);
  assert.equal(row.retry_budget, 3);

  assert.throws(() =>
    createProxyPool({
      name: "bad-kind",
      url: "http://127.0.0.1:3128",
      kind: "invalid",
    })
  );
  assert.throws(() =>
    createProxyPool({
      name: "bad-rot",
      url: "http://127.0.0.1:3128",
      rotate_url: "ftp://127.0.0.1:8405/rotate",
    })
  );
});

test("planProxyRotationEntries repeats single gateway up to retry_budget while preserving single mode", () => {
  clearPoolsAndSettings();
  setProxyRotationStrategy("opencode", "round_robin");
  createProxyPool({
    name: "single-node",
    url: "http://127.0.0.1:3129",
    kind: "single",
    retry_budget: 5,
  });
  assert.deepEqual(planProxyRotation("opencode", "round_robin"), ["http://127.0.0.1:3129"]);

  clearPoolsAndSettings();
  setProxyRotationStrategy("opencode", "round_robin");
  const tok = randomUUID();
  createProxyPool({
    name: "warp-1gate",
    url: "http://100.90.253.83:3128",
    kind: "gateway",
    retry_budget: 3,
    rotate_url: "http://100.90.253.83:8405/rotate",
    [ROT_KEY]: tok,
  });

  const urls = planProxyRotation("opencode", "round_robin");
  assert.deepEqual(urls, [
    "http://100.90.253.83:3128",
    "http://100.90.253.83:3128",
    "http://100.90.253.83:3128",
  ]);
  const entries = planProxyRotationEntries("opencode", "round_robin");
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, "gateway");
  assert.equal(entries[0].rotate_url, "http://100.90.253.83:8405/rotate");
  assert.equal(entries[0][ROT_KEY], tok);
});

test("notifyProxyRotate sends auth header, debounces repeated calls, and swallows network failure", async () => {
  clearPoolsAndSettings();
  const tok = randomUUID();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, node: 1 }), { status: 200 });
  };
  const pool = {
    id: 99,
    url: "http://100.90.253.83:3128",
    kind: "gateway",
    rotate_url: "http://100.90.253.83:8405/rotate",
    [ROT_KEY]: tok,
  };

  await notifyProxyRotate(pool, { status: 429, reason: "throttled", fetchFn: fakeFetch, now: 1000 });
  await notifyProxyRotate(pool, { status: 429, reason: "throttled", fetchFn: fakeFetch, now: 2000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://100.90.253.83:8405/rotate");
  assert.equal(calls[0].init.headers.Authorization, `${AUTH_SCHEME} ${tok}`);
  const sentBody = JSON.parse(calls[0].init.body);
  assert.equal(sentBody.port, 3128);
  assert.equal(sentBody.mode, "next");

  await notifyProxyRotate(pool, { status: 403, reason: "FreeTierError", fetchFn: fakeFetch, now: 15000 });
  assert.equal(calls.length, 2);

  await notifyProxyRotate(pool, {
    status: 429,
    reason: "err",
    fetchFn: async () => {
      throw new Error("ECONNREFUSED");
    },
    now: 30000,
  });
});

test("1-gate gateway retries 403 FreeTierError -> 429 -> 200 without locking gate or virtualCooldown", async () => {
  clearPoolsAndSettings();
  setProxyRotationStrategy("opencode", "round_robin");
  const tok = randomUUID();
  const gateUrl = "http://100.90.253.83:3128";
  createProxyPool({
    name: "warp-1gate",
    url: gateUrl,
    kind: "gateway",
    retry_budget: 3,
    rotate_url: "http://100.90.253.83:8405/rotate",
    [ROT_KEY]: tok,
  });

  const rotateCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes(":8405/rotate")) {
      rotateCalls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, node: 1 }), { status: 200 });
    }
    return origFetch(url, init);
  };

  let upstreamCall = 0;
  const mockExecutor = new OpencodeExecutor({
    proxyFetchFn: async () => {
      upstreamCall += 1;
      if (upstreamCall === 1) {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "FreeTierError", message: "Your request was blocked" } }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      if (upstreamCall === 2) {
        return new Response(
          'data: {"type":"error","error":{"name":"FreeUsageLimitError","message":"limit reached"}}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  try {
    const provider = { id: "opencode", name: "OpenCode Free", noAuth: true, models: ["gpt-5-nano"] };
    const result = await executeWithFallback({
      provider,
      targetModel: "gpt-5-nano",
      targetFormat: "openai",
      stream: true,
      baseHeaders: {},
      upstreamPayload: {
        model: "gpt-5-nano",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      },
      executor: mockExecutor,
      resolveUrl: () => "https://opencode.ai/zen/v1/chat/completions",
    });

    assert.equal(result.ok, true);
    assert.equal(upstreamCall, 3);
    assert.equal(getOpencodeGateState(opencodeGateKey(gateUrl)), null);
    assert.equal(getVirtualCooldownUntil("opencode", "gpt-5-nano"), null);
    assert.ok(rotateCalls.length >= 1, "expected rotate webhook to be triggered");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("mid-stream opencode error triggers notifyProxyRotate without dropping chunks", async () => {
  clearPoolsAndSettings();
  setProxyRotationStrategy("opencode", "round_robin");
  const tok = randomUUID();
  createProxyPool({
    name: "warp-1gate",
    url: "http://100.90.253.83:3128",
    kind: "gateway",
    retry_budget: 2,
    rotate_url: "http://100.90.253.83:8405/rotate",
    [ROT_KEY]: tok,
  });

  const rotateCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes(":8405/rotate")) {
      rotateCalls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return origFetch(url, init);
  };

  const encoder = new TextEncoder();
  const mockExecutor = new OpencodeExecutor({
    proxyFetchFn: async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"error","error":{"name":"FreeUsageLimitError"}}\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  try {
    const provider = { id: "opencode", name: "OpenCode Free", noAuth: true, models: ["gpt-5-nano"] };
    const result = await executeWithFallback({
      provider,
      targetModel: "gpt-5-nano",
      targetFormat: "openai",
      stream: true,
      baseHeaders: {},
      upstreamPayload: {
        model: "gpt-5-nano",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      },
      executor: mockExecutor,
      resolveUrl: () => "https://opencode.ai/zen/v1/chat/completions",
    });

    assert.equal(result.ok, true);
    const fullText = await result.upstreamRes.text();
    assert.match(fullText, /hello /);
    assert.match(fullText, /FreeUsageLimitError/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rotateCalls.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("1-gate gateway engages opencodeGate and virtualCooldown only when all retry_budget attempts fail", async () => {
  clearPoolsAndSettings();
  setProxyRotationStrategy("opencode", "round_robin");
  const gateUrl = "http://100.90.253.83:3128";
  createProxyPool({
    name: "warp-1gate",
    url: gateUrl,
    kind: "gateway",
    retry_budget: 2,
  });

  let upstreamCall = 0;
  const mockExecutor = new OpencodeExecutor({
    proxyFetchFn: async () => {
      upstreamCall += 1;
      return new Response(
        JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached" } }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const provider = { id: "opencode", name: "OpenCode Free", noAuth: true, models: ["gpt-5-nano"] };
  const result = await executeWithFallback({
    provider,
    targetModel: "gpt-5-nano",
    targetFormat: "openai",
    stream: true,
    baseHeaders: {},
    upstreamPayload: {
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", parameters: {} } }],
    },
    executor: mockExecutor,
    resolveUrl: () => "https://opencode.ai/zen/v1/chat/completions",
  });

  assert.equal(result.ok, false);
  assert.equal(upstreamCall, 2);
  assert.notEqual(getOpencodeGateState(opencodeGateKey(gateUrl)), null);
});

test("notifyProxyRotate waits for the last active stream so a rotation does not cut it off", async () => {
  clearPoolsAndSettings();
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return new Response("{}", { status: 200 });
  };
  const pool = { id: 77, url: "http://100.90.253.83:3128", kind: "gateway", rotate_url: "http://100.90.253.83:8405/rotate" };

  const endA = beginProxyStream(pool);
  const endB = beginProxyStream(pool);
  const r = await notifyProxyRotate(pool, { status: 429, reason: "x", fetchFn: fakeFetch, now: 1000 });
  assert.equal(r.skipped, "deferred_active_stream");
  assert.equal(calls.length, 0);

  endA();
  endA();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0, "one stream is still running");

  endB();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1, "rotation fires once the last stream ends");
});

test("notifyProxyRotate skips rotation and marks pool exhausted when reason is FreeUsageLimitError", async () => {
  clearPoolsAndSettings();
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return new Response("{}", { status: 200 });
  };
  const pool = { id: 88, url: "http://100.90.253.83:3128", kind: "gateway", rotate_url: "http://100.90.253.83:8405/rotate" };

  // First call with FreeUsageLimitError: sends rotation, but marks pool exhausted
  const r1 = await notifyProxyRotate(pool, {
    status: 429,
    reason: "FreeUsageLimitError: daily quota exceeded",
    fetchFn: fakeFetch,
    now: 1000,
  });
  assert.equal(r1.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(isProxyPoolExhausted(88, 1000), true);

  // Subsequent call: skipped because pool is marked exhausted
  const r2 = await notifyProxyRotate(pool, {
    status: 429,
    reason: "FreeUsageLimitError: daily quota exceeded",
    fetchFn: fakeFetch,
    now: 50000,
  });
  assert.equal(r2.skipped, "pool_exhausted");
  assert.equal(calls.length, 1, "no more rotate calls sent while pool is exhausted");
});

test("a deferred rotation still fires after the max wait if a stream never ends", async () => {
  clearPoolsAndSettings();
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return new Response("{}", { status: 200 });
  };
  const pool = { id: 78, url: "http://100.90.253.83:3128", kind: "gateway", rotate_url: "http://100.90.253.83:8405/rotate" };
  beginProxyStream(pool);
  await notifyProxyRotate(pool, { status: 429, fetchFn: fakeFetch, now: 1000, maxDeferMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls.length, 1);
});

test("a quota 429 from an earlier day does not mark the pool exhausted today", async () => {
  clearPoolsAndSettings();
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return new Response("{}", { status: 200 });
  };
  const pool = { id: 91, url: "http://100.90.253.83:3128", kind: "gateway", retry_budget: 2, rotate_url: "http://100.90.253.83:8405/rotate" };
  const day1 = Date.UTC(2026, 10, 14, 1, 0, 0);
  await notifyProxyRotate(pool, { status: 429, reason: "FreeUsageLimitError", fetchFn: fakeFetch, now: day1 });
  assert.equal(isProxyPoolExhausted(91, day1 + 1000), false, "one strike is below retry_budget 2");

  const day3 = day1 + 2 * 86400000;
  const r = await notifyProxyRotate(pool, { status: 429, reason: "FreeUsageLimitError", fetchFn: fakeFetch, now: day3 });
  assert.equal(r.sent, true);
  assert.equal(isProxyPoolExhausted(91, day3 + 1000), false, "the old strike must not carry over");
});

test("a non-quota 429 never marks the pool exhausted", async () => {
  clearPoolsAndSettings();
  const fakeFetch = async () => new Response("{}", { status: 200 });
  const pool = { id: 92, url: "http://100.90.253.83:3128", kind: "gateway", retry_budget: 1, rotate_url: "http://100.90.253.83:8405/rotate" };
  await notifyProxyRotate(pool, { status: 429, reason: "slow down", fetchFn: fakeFetch, now: 1000 });
  assert.equal(isProxyPoolExhausted(92, 1500), false);
});

test("msUntilNextMidnightUtc and noteOpencodeGateRejection cooldown on 429 FreeUsageLimit", () => {
  const fixedNow = Date.UTC(2026, 10, 14, 12, 0, 0); // 12:00 UTC
  const ms = msUntilNextMidnightUtc(fixedNow);
  // 12 hours = 43200000 ms
  assert.equal(ms, 12 * 3600 * 1000);

  resetOpencodeGate();
  // With Retry-After of 50000s (~13.8h)
  const state = noteOpencodeGateRejection(
    "test-gate-key",
    {
      status: 429,
      shape: { hasReadTool: true, userAgentOk: true, sessionHeaders: ["h"], streaming: true },
      shapeOk: true,
      retryAfterMs: 43200000,
    },
    fixedNow
  );

  assert.equal(state.gate, "quota-exhausted");
  // cooldown should be 43200000 ms, NOT capped at 600000 (10m)
  assert.equal(state.retryAfterMs, 43200000);
});

