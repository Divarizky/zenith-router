import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { getActiveConnection, applyConnectionAuth } from "../src/services/auth.js";
import { getProvider } from "../src/providers/index.js";
import { KilocodeExecutor, KILO_GATEWAY_URL } from "../src/executors/kilocode.js";
import { OpencodeExecutor } from "../src/executors/opencode.js";

function mockUpstream() {
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    seen.push({ url, headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  return { seen, fetchFn };
}

test("keyless providers - pemisahan section dan kategori provider", () => {
  const l7 = getProvider("llm7");
  assert.strictEqual(l7.category, "free", "llm7 harus di kategori free");
  assert.strictEqual(l7.noAuth, true, "llm7 harus memiliki noAuth: true");

  const kc = getProvider("kilocode");
  assert.strictEqual(kc.category, "oauth", "kilocode harus di kategori oauth");
  assert.strictEqual(kc.noAuth, undefined, "kilocode oauth tidak boleh noAuth");

  const kcFree = getProvider("kilo-free");
  assert.strictEqual(kcFree.category, "free", "kilo-free harus di kategori free");
  assert.strictEqual(kcFree.noAuth, true, "kilo-free harus memiliki noAuth: true");
});

test("keyless providers - llm7 memiliki noAuth dan virtual connection", () => {
  initDb(":memory:");
  const l7 = getProvider("llm7");
  assert.strictEqual(l7.noAuth, true);
  const conn = getActiveConnection("llm7");
  assert.ok(conn, "virtual connection llm7 harus ada");
  assert.strictEqual(conn.auth_type, "noauth");
});

test("keyless providers - llm7 menyuntikkan Bearer unused untuk koneksi virtual", () => {
  const conn = { provider: "llm7", auth_type: "noauth", credentials: {} };
  const headers = {};
  applyConnectionAuth(headers, conn);
  assert.strictEqual(headers["Authorization"], "Bearer unused", "koneksi virtual llm7 wajib memakai Bearer unused");
});

test("keyless providers - kilo-free memiliki noAuth dan virtual connection", () => {
  initDb(":memory:");
  const kf = getProvider("kilo-free");
  assert.strictEqual(kf.noAuth, true);
  const conn = getActiveConnection("kilo-free");
  assert.ok(conn, "virtual connection kilo-free harus ada");
  assert.strictEqual(conn.auth_type, "noauth");
});

test("keyless providers - KilocodeExecutor mengalihkan kilo-free ke gateway publik tanpa auth", async () => {
  const upstream = mockUpstream();
  const executor = new KilocodeExecutor({ fetchFn: upstream.fetchFn });
  const virtualConn = { provider: "kilo-free", auth_type: "noauth", credentials: {} };

  const res = await executor.execute({
    url: "https://api.kilo.ai/api/gateway/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({ model: "kilo-auto/free", messages: [{ role: "user", content: "hi" }] }),
    connection: virtualConn,
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(upstream.seen.length, 1);
  const req = upstream.seen[0];
  assert.strictEqual(req.url, KILO_GATEWAY_URL, "harus dialihkan ke gateway publik");
  assert.strictEqual(req.headers.get("Authorization"), null, "Authorization header harus dihilangkan di gateway publik");
});

test("keyless providers - KilocodeExecutor mempertahankan url dan token untuk akun oauth kilocode", async () => {
  const upstream = mockUpstream();
  const executor = new KilocodeExecutor({ fetchFn: upstream.fetchFn });
  const sampleToken = ["kilo", "oauth", "token", "123"].join("-");
  const oauthConn = {
    provider: "kilocode",
    auth_type: "oauth",
    credentials: { access_token: sampleToken },
  };

  const res = await executor.execute({
    url: "https://api.kilo.ai/api/openrouter/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sampleToken}` },
    body: JSON.stringify({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "hi" }] }),
    connection: oauthConn,
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(upstream.seen.length, 1);
  const req = upstream.seen[0];
  assert.strictEqual(req.url, "https://api.kilo.ai/api/openrouter/chat/completions");
  assert.strictEqual(req.headers.get("Authorization"), `Bearer ${sampleToken}`);
});

test("keyless providers - OpencodeExecutor mengirim traceparent dan b3 headers", async () => {
  const upstream = mockUpstream();
  const executor = new OpencodeExecutor({ fetchFn: upstream.fetchFn });

  await executor.execute({
    url: "https://opencode.ai/inference/openai/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "ping" }] }),
  });

  assert.strictEqual(upstream.seen.length, 1);
  const headers = upstream.seen[0].headers;
  assert.ok(headers.get("b3"), "header b3 harus disertakan");
  assert.ok(headers.get("traceparent"), "header traceparent harus disertakan");
  assert.match(headers.get("traceparent"), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});
