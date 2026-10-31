import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { createApiKey } from "../src/services/apiKeys.js";
import { OpencodeExecutor } from "../src/executors/opencode.js";
import { getActiveConnection } from "../src/services/auth.js";
import opencode from "../src/providers/registry/opencode.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function withEnv(vars, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// Upstream tiruan: merekam header dan body yang diterima, lalu membalas JSON OpenAI-compatible.
function mockUpstream() {
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  return { seen, fetchFn };
}

test("opencode keyless - provider ditandai noAuth dan tidak memerlukan akun", () => {
  initDb(":memory:");
  assert.strictEqual(opencode.noAuth, true);
  const conn = getActiveConnection("opencode");
  assert.ok(conn, "virtual connection harus tersedia tanpa akun tersimpan");
  assert.strictEqual(conn.auth_type, "noauth");
  assert.deepStrictEqual(conn.credentials, {}, "virtual connection tidak membawa kredensial");
});

test("opencode keyless - executor menimpa Authorization klien dengan Bearer public", async () => {
  const upstream = mockUpstream();
  const executor = new OpencodeExecutor({ fetchFn: upstream.fetchFn });
  const res = await executor.execute({
    url: "https://opencode.ai/inference/openai/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer tes-klien-palsu" },
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "ping" }] }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(upstream.seen.length, 1);
  const sent = upstream.seen[0].headers;
  assert.strictEqual(sent.get("Authorization"), "Bearer public", "upstream menerima kredensial publik, bukan kunci klien");
});

test("opencode keyless - executor dari registry memakai Bearer public tanpa kunci apa pun", async () => {
  const upstream = mockUpstream();
  const executor = new OpencodeExecutor({ fetchFn: upstream.fetchFn });
  await executor.execute({
    url: "https://opencode.ai/inference/openai/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "ping" }] }),
  });
  assert.strictEqual(upstream.seen[0].headers.get("Authorization"), "Bearer public");
  assert.strictEqual(upstream.seen[0].url, "https://opencode.ai/inference/openai/v1/chat/completions");
});

test("opencode keyless - /v1/chat/completions di loopback tanpa kunci klien tidak ditolak 401", async () => {
  initDb(":memory:");
  setSetting("require_api_key", "false");
  const upstream = mockUpstream();
  await withEnv({ HOST: null, ZENITH_ADMIN_TOKEN: null }, async () => {
    const { setCustomExecutor } = await import("../src/executors/base.js");
    setCustomExecutor(new OpencodeExecutor({ fetchFn: upstream.fetchFn }));
    try {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ model: "opencode/big-pickle", messages: [{ role: "user", content: "ping" }] }),
      });
      assert.notStrictEqual(res.status, 401, "loopback tanpa kunci klien tidak boleh 401");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(upstream.seen.length, 1);
      assert.strictEqual(upstream.seen[0].headers.get("Authorization"), "Bearer public");
    } finally {
      setCustomExecutor(null);
    }
  });
});

test("opencode keyless - non-loopback dengan require_api_key tetap menolak tanpa kunci", async () => {
  initDb(":memory:");
  await withEnv({ HOST: "0.0.0.0" }, async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "opencode/big-pickle", messages: [{ role: "user", content: "ping" }] }),
    });
    assert.strictEqual(res.status, 401, "bind non-loopback mewajibkan kunci gateway");
  });
});

test("opencode keyless - kunci gateway valid tetap diterima di non-loopback", async () => {
  initDb(":memory:");
  const created = createApiKey("Agent Keyless");
  const upstream = mockUpstream();
  const { setCustomExecutor } = await import("../src/executors/base.js");
  await withEnv({ HOST: "0.0.0.0" }, async () => {
    setCustomExecutor(new OpencodeExecutor({ fetchFn: upstream.fetchFn }));
    try {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${created.key}` },
        body: JSON.stringify({ model: "opencode/big-pickle", messages: [{ role: "user", content: "ping" }] }),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(upstream.seen[0].headers.get("Authorization"), "Bearer public", "kunci gateway tidak bocor ke upstream");
    } finally {
      setCustomExecutor(null);
    }
  });
});
