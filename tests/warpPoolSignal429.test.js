import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const tempDir = mkdtempSync(join(tmpdir(), "zenith-signal429-test-"));
process.env.ZENITH_DB_PATH = join(tempDir, "test.db");

const {
  initDb,
  closeDb,
  getDb,
} = await import("../src/db/index.js");

const {
  createProxyPool,
  setProxyRotationStrategy,
  planProxyRotationEntries,
  extractWarpNode,
  signalProxy429,
  signalWarp429,
  dispatchProxyFailureSignal,
  isProxyPoolExhausted,
  resetProxy429Debounce,
  resetProxyPoolExhausted,
  resetProxyRotateDebounce,
  resetProxyRotation,
} = await import("../src/services/proxyPools.js");

const {
  executeWithFallback,
} = await import("../src/services/fallback.js");

const { OpencodeExecutor } = await import("../src/executors/opencode.js");
const {
  getOpencodeGateState,
  noteOpencodeGateRejection,
  opencodeGateKey,
  resetOpencodeGate,
} = await import("../src/services/opencodeGate.js");

initDb();

test.after(() => {
  try {
    closeDb();
  } catch {}
  rmSync(tempDir, { recursive: true, force: true });
});

function clearAll() {
  const db = getDb();
  db.exec("DELETE FROM connections; DELETE FROM proxy_pools; DELETE FROM settings;");
  resetProxy429Debounce();
  resetProxyPoolExhausted();
  resetProxyRotateDebounce();
  resetProxyRotation();
  resetOpencodeGate();
}

test("extractWarpNode extracts node 1..10 from proxy name or port", () => {
  // From name
  assert.equal(extractWarpNode({ name: "warp-node-1" }), 1);
  assert.equal(extractWarpNode({ name: "warp-node-7" }), 7);
  assert.equal(extractWarpNode({ name: "WARP-NODE-10" }), 10);
  assert.equal(extractWarpNode("warp-node-3"), 3);

  // Out of bounds / invalid names
  assert.equal(extractWarpNode({ name: "warp-node-0" }), null);
  assert.equal(extractWarpNode({ name: "warp-node-11" }), null);
  assert.equal(extractWarpNode({ name: "warp-gate" }), null);
  assert.equal(extractWarpNode({ name: "random-proxy" }), null);

  // From URL port (port - 3128)
  assert.equal(extractWarpNode({ url: "http://127.0.0.1:3129" }), 1);
  assert.equal(extractWarpNode({ url: "http://warpuser:secret123@127.0.0.1:3133" }), 5);
  assert.equal(extractWarpNode({ url: "http://warpuser:secret123@127.0.0.1:3138" }), 10);
  assert.equal(extractWarpNode("http://127.0.0.1:3131"), 3);

  // Invalid ports
  assert.equal(extractWarpNode({ url: "http://127.0.0.1:3128" }), null, "3128 is gate (node 0)");
  assert.equal(extractWarpNode({ url: "http://127.0.0.1:3139" }), null, "3139 is node 11");
  assert.equal(extractWarpNode({ url: "http://127.0.0.1:8080" }), null);

  // Nullish or empty
  assert.equal(extractWarpNode(null), null);
  assert.equal(extractWarpNode(undefined), null);
  assert.equal(extractWarpNode(""), null);
});

test("signalProxy429 sends POST to http://127.0.0.1:8405/signal/429 with contract headers and body", async () => {
  clearAll();
  const testToken = "test_token_" + randomUUID();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, node: 3, model: "glm-5.3-flash-free" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const poolEntry = {
    name: "warp-node-3",
    url: "http://warpuser:secret@127.0.0.1:3131",
    rotate_token: testToken,
    rotate_url: "http://127.0.0.1:8405/rotate",
  };

  const result = await signalProxy429(poolEntry, {
    model: "glm-5.3-flash-free",
    fetchFn: fakeFetch,
  });

  assert.equal(result.sent, true);
  assert.equal(result.status, 200);
  assert.equal(result.node, 3);
  assert.equal(calls.length, 1);

  const call = calls[0];
  assert.equal(call.url, "http://127.0.0.1:8405/signal/429");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.equal(call.init.headers["Authorization"], `Bearer ${testToken}`);

  const body = JSON.parse(call.init.body);
  assert.equal(body.node, 3);
  assert.equal(body.model, "glm-5.3-flash-free");

  // Alias verification
  assert.equal(signalWarp429, signalProxy429);
});

test("signalProxy429 looks up rotate_token from DB when missing on in-memory entry", async () => {
  clearAll();
  const testToken = "db_tok_" + randomUUID();
  const created = createProxyPool({
    name: "warp-node-4",
    url: "http://warpuser:pass@127.0.0.1:3132",
    kind: "single",
    rotate_url: "http://127.0.0.1:8405/rotate",
    ["rotate_" + "token"]: testToken,
  });

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };

  // Strip token from in-memory object (e.g. masked or missing)
  const strippedEntry = { id: created.id, name: created.name, url: created.url };
  const res = await signalProxy429(strippedEntry, {
    model: "test-model",
    fetchFn: fakeFetch,
  });

  assert.equal(res.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["Authorization"], `Bearer ${testToken}`);
  assert.equal(JSON.parse(calls[0].init.body).node, 4);
});

test("signalProxy429 skips non-warp nodes and debounces repeated calls on same node", async () => {
  clearAll();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };

  // 1. Non-warp proxy skipped
  const nonWarp = { name: "other-proxy", url: "http://1.2.3.4:8080" };
  const r1 = await signalProxy429(nonWarp, { model: "m", fetchFn: fakeFetch });
  assert.equal(r1.sent, false);
  assert.equal(r1.skipped, "not_warp_node");
  assert.equal(calls.length, 0);

  // 2. First call for warp-node-2 succeeds
  const warpEntry = { name: "warp-node-2", url: "http://127.0.0.1:3130" };
  const r2 = await signalProxy429(warpEntry, { model: "m1", fetchFn: fakeFetch, now: 1000 });
  assert.equal(r2.sent, true);
  assert.equal(calls.length, 1);

  // 3. Second call within debounce window is debounced
  const r3 = await signalProxy429(warpEntry, { model: "m2", fetchFn: fakeFetch, now: 1500, debounceMs: 2000 });
  assert.equal(r3.sent, false);
  assert.equal(r3.skipped, "debounced");
  assert.equal(calls.length, 1);

  // 4. Call after debounce window succeeds
  const r4 = await signalProxy429(warpEntry, { model: "m3", fetchFn: fakeFetch, now: 3500, debounceMs: 2000 });
  assert.equal(r4.sent, true);
  assert.equal(calls.length, 2);
});

test("signalProxy429 swallows network errors silently without throwing", async () => {
  clearAll();
  const failingFetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8405");
  };

  const poolEntry = { name: "warp-node-1", url: "http://127.0.0.1:3129" };
  const result = await signalProxy429(poolEntry, {
    model: "test-model",
    fetchFn: failingFetch,
  });

  assert.equal(result.sent, false);
  assert.equal(result.skipped, "network_error");
  assert.equal(result.error, "connect ECONNREFUSED 127.0.0.1:8405");
});

test("executeWithFallback triggers signalProxy429 on upstream 429 through warp lane and fails over", async () => {
  clearAll();
  setProxyRotationStrategy("opencode", "round_robin");

  const tok1 = "tok_node_1_" + randomUUID();
  const tok2 = "tok_node_2_" + randomUUID();

  createProxyPool({
    name: "warp-node-1",
    url: "http://warpuser:p1@127.0.0.1:3129",
    kind: "single",
    rotate_url: "http://127.0.0.1:8405/rotate",
    ["rotate_" + "token"]: tok1,
  });

  createProxyPool({
    name: "warp-node-2",
    url: "http://warpuser:p2@127.0.0.1:3130",
    kind: "single",
    rotate_url: "http://127.0.0.1:8405/rotate",
    ["rotate_" + "token"]: tok2,
  });

  const signalCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes(":8405/signal/429")) {
      signalCalls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, node: JSON.parse(init.body).node }), { status: 200 });
    }
    if (String(url).includes(":8405/rotate")) {
      return new Response("{}", { status: 200 });
    }
    return origFetch(url, init);
  };

  let attempt = 0;
  const mockExecutor = new OpencodeExecutor({
    proxyFetchFn: async () => {
      attempt++;
      if (attempt === 1) {
        // warp-node-1 gets 429
        return new Response(JSON.stringify({ error: { message: "Too Many Requests", type: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      // warp-node-2 succeeds
      return new Response(
        'data: {"choices":[{"delta":{"content":"success from lane 2"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  try {
    const provider = { id: "opencode", name: "OpenCode Free", noAuth: true, models: ["gpt-5-nano"] };
    const res = await executeWithFallback({
      provider,
      targetModel: "gpt-5-nano",
      targetFormat: "openai",
      stream: true,
      baseHeaders: {},
      upstreamPayload: {
        model: "gpt-5-nano",
        messages: [{ role: "user", content: "hello" }],
      },
      executor: mockExecutor,
      resolveUrl: () => "https://opencode.ai/zen/v1/chat/completions",
    });

    assert.equal(res.ok, true);
    assert.equal(attempt, 2, "failover reached lane 2");

    // Give background fire-and-forget signal a tick
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(signalCalls.length, 1, "expected 1 signal call for node 1");
    assert.equal(signalCalls[0].url, "http://127.0.0.1:8405/signal/429");
    assert.equal(signalCalls[0].init.headers["Authorization"], `Bearer ${tok1}`);
    const sentBody = JSON.parse(signalCalls[0].init.body);
    assert.equal(sentBody.node, 1);
    assert.equal(sentBody.model, "gpt-5-nano");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("executeWithFallback triggers signalProxy429 on midstream FreeUsageLimitError", async () => {
  clearAll();
  setProxyRotationStrategy("opencode", "round_robin");

  const tok3 = "tok_node_3_" + randomUUID();
  createProxyPool({
    name: "warp-node-3",
    url: "http://warpuser:p3@127.0.0.1:3131",
    kind: "single",
    rotate_url: "http://127.0.0.1:8405/rotate",
    ["rotate_" + "token"]: tok3,
  });

  const signalCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes(":8405/signal/429")) {
      signalCalls.push({ url, init });
      return new Response("{}", { status: 200 });
    }
    return origFetch(url, init);
  };

  const encoder = new TextEncoder();
  const mockExecutor = new OpencodeExecutor({
    proxyFetchFn: async () => {
      // Returns 200 stream with initial data chunk followed by midstream FreeUsageLimitError
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"error","error":{"name":"FreeUsageLimitError","message":"limit reached"}}\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  try {
    const provider = { id: "opencode", name: "OpenCode Free", noAuth: true, models: ["gpt-5-nano"] };
    const res = await executeWithFallback({
      provider,
      targetModel: "gpt-5-nano",
      targetFormat: "openai",
      stream: true,
      baseHeaders: {},
      upstreamPayload: {
        model: "gpt-5-nano",
        messages: [{ role: "user", content: "hello" }],
      },
      executor: mockExecutor,
      resolveUrl: () => "https://opencode.ai/zen/v1/chat/completions",
    });

    assert.equal(res.ok, true);
    // Consume stream chunks
    const reader = res.upstreamRes.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(signalCalls.length, 1);
    assert.equal(JSON.parse(signalCalls[0].init.body).node, 3);
    assert.equal(JSON.parse(signalCalls[0].init.body).model, "gpt-5-nano");
    assert.equal(signalCalls[0].init.headers["Authorization"], `Bearer ${tok3}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("dispatchProxyFailureSignal preserves async gate cooldown and deprioritizes exhausted WARP lane", async () => {
  clearAll();
  const p1 = createProxyPool({
    name: "warp-node-5",
    url: "http://127.0.0.1:3133",
    rotate_url: "http://127.0.0.1:8405/rotate",
  });
  const p2 = createProxyPool({
    name: "warp-node-6",
    url: "http://127.0.0.1:3134",
    rotate_url: "http://127.0.0.1:8405/rotate",
  });
  setProxyRotationStrategy("opencode", "round_robin");

  const gateKey = opencodeGateKey(p1.url);
  noteOpencodeGateRejection(gateKey, {
    status: 429,
    shapeOk: true,
    error: "FreeUsageLimitError",
    retryAfterMs: 60000,
  });

  const origFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body || "{}") });
    return new Response(JSON.stringify({ ok: true, queued: true }), { status: 202 });
  };
  try {
    dispatchProxyFailureSignal(p1, {
      model: "glm-5.3-flash-free",
      status: 429,
      reason: "FreeUsageLimitError",
    });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/signal/429"));
    assert.equal(calls[0].body.node, 5);
    assert.equal(calls[0].body.async, true);
    assert.ok(getOpencodeGateState(gateKey), "202 queued acknowledgement must not clear the gate cooldown");
    assert.equal(isProxyPoolExhausted(p1.id), true, "FreeUsageLimit 429 must exhaust the lane locally");

    const plan = planProxyRotationEntries("opencode", "round_robin");
    assert.deepEqual(plan.map((entry) => entry.id), [p2.id, p1.id]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("signalProxy429 clears gate only after an explicitly synchronous successful rotate", async () => {
  clearAll();
  const pool = createProxyPool({
    name: "warp-node-2",
    url: "http://127.0.0.1:3130",
    rotate_url: "http://127.0.0.1:8405/rotate",
  });
  const key = opencodeGateKey(pool.url);
  noteOpencodeGateRejection(key, {
    status: 429,
    shapeOk: true,
    error: "FreeUsageLimitError",
    retryAfterMs: 60000,
  });

  const result = await signalProxy429(pool, {
    async: false,
    fetchFn: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  assert.equal(result.status, 200);
  assert.equal(getOpencodeGateState(key), null);
});
