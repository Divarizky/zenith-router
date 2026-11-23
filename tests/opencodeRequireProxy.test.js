import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/index.js";
import { initDb, addConnection, addProxyPool, updateProxyPool } from "../src/db/index.js";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { proxyFetch } from "../src/executors/proxy.js";
import { OpencodeExecutor } from "../src/executors/opencode.js";
import { setSetting } from "../src/services/settings.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { handleBridgeRequest } from "../src/bridge/opencode-bridge.js";

test("OpenCode require proxy with empty scoped pool fails closed before executor", async () => {
  initDb(":memory:");
  setSetting("opencode_egress_policy", "require_proxy");
  setSetting("opencode_proxy_pool_ids", JSON.stringify([]));
  let calls = 0;
  setCustomExecutor({ async execute() { calls++; return new Response("{}"); } });
  try {
    const res = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "opencode/glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /proxy_required/);
    assert.equal(calls, 0);
  } finally { setCustomExecutor(null); }
});

test("require uses only scoped active proxy even with rotation off", async () => {
  initDb(":memory:");
  const excluded = addProxyPool({ name: "excluded", url: "http://excluded.local:3128" });
  const selected = addProxyPool({ name: "selected", url: "http://selected.local:3128" });
  setSetting("opencode_egress_policy", "require");
  setSetting("opencode_proxy_pool_ids", JSON.stringify([selected.id]));
  const calls = [];
  setCustomExecutor({ async execute(args) { calls.push(args); return new Response('{}', { status: 200 }); } });
  const request = () => app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "opencode/glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }) });
  try {
    assert.equal((await request()).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].proxyUrl, selected.url);
    assert.equal(calls[0].requireProxy, true);
    updateProxyPool(selected.id, { is_active: 0 });
    assert.equal((await request()).status, 503);
    assert.equal(calls.length, 1);
    assert.notEqual(excluded.id, selected.id);
  } finally { setCustomExecutor(null); }
});

test("strict executor rejects missing proxy before transport", async () => {
  let calls = 0;
  const executor = new OpencodeExecutor();
  executor.fetchFn = async () => { calls++; return new Response('{}'); };
  executor.proxyFetchFn = async () => { calls++; return new Response('{}'); };
  const res = await executor.execute({ body: '{}', requireProxy: true });
  assert.equal(res.status, 503);
  assert.equal(calls, 0);
});

test("strict policy persists to default fallback without a proxy", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "fallback", credentials: { api_key: "test" } });
  setSetting("opencode_egress_policy", "require");
  setSetting("opencode_proxy_pool_ids", "[]");
  setSetting("default_fallback_model", "glm/glm-4-flash");
  let calls = 0;
  setCustomExecutor({ async execute() { calls++; return new Response('{}'); } });
  try {
    const res = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "opencode/glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 503);
    assert.equal(calls, 0);
  } finally { setCustomExecutor(null); }
});

test("failed OpenCode proxy cannot cause direct fallback", async () => {
  initDb(":memory:");
  const pool = addProxyPool({ name: "strict", url: "http://strict.local:3128" });
  addConnection({ provider: "glm", name: "fallback", credentials: { api_key: "test" } });
  setSetting("opencode_egress_policy", "require");
  setSetting("opencode_proxy_pool_ids", JSON.stringify([pool.id]));
  setSetting("default_fallback_model", "glm/glm-4-flash");
  const calls = [];
  setCustomExecutor({ async execute(args) { calls.push(args); return new Response('{}', { status: 503 }); } });
  try {
    const res = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "opencode/glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 503);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].proxyUrl, pool.url);
  } finally { setCustomExecutor(null); }
});

test("strict fallback uses its own account proxy, not OpenCode scope", async () => {
  initDb(":memory:");
  const selected = addProxyPool({ name: "open-code", url: "http://open-code.local:3128" });
  addConnection({ provider: "glm", name: "fallback", credentials: { api_key: "test" }, proxy_url: "http://fallback.local:3128" });
  setSetting("opencode_egress_policy", "require");
  setSetting("opencode_proxy_pool_ids", JSON.stringify([selected.id]));
  setSetting("default_fallback_model", "glm/glm-4-flash");
  const calls = [];
  setCustomExecutor({ async execute(args) { calls.push(args); return calls.length === 1 ? new Response('{}', { status: 503 }) : new Response('{"choices":[{"message":{"role":"assistant","content":"ok"}}]}', { headers: { "content-type": "application/json" } }); } });
  try {
    const res = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "opencode/glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.proxyUrl), [selected.url, "http://fallback.local:3128"]);
  } finally { setCustomExecutor(null); }
});

test("strict executor rejects unverified external bridge without transport", () => {
  const script = `import { OpencodeExecutor } from './src/executors/opencode.js'; const e = new OpencodeExecutor(); let calls = 0; e.fetchFn = e.proxyFetchFn = async () => { calls++; throw Error('unexpected'); }; const r = await e.execute({ proxyUrl: 'http://proxy.local:3128', requireProxy: true }); if (r.status !== 503 || calls !== 0) process.exit(1);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, ZENITH_OPENCODE_BASE_URL: "http://external.invalid/v1" }, timeout: 5000 });
});

test("bridge uses local proxy, never direct, even on transport failure and cancellation", async () => {
  let targetCalls = 0, proxyCalls = 0, directCalls = 0, bridgeCalls = 0;
  const target = http.createServer((_req, res) => { targetCalls++; res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'); });
  const proxy = http.createServer((req, res) => { proxyCalls++; const upstream = http.request(req.url, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(upstream); res.on("close", () => upstream.destroy()); });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const targetUrl = `http://127.0.0.1:${target.address().port}/`;
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const request = () => new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-zenith-require-proxy": "1", "x-zenith-proxy": proxyUrl }, body: JSON.stringify({ model: "opencode/free", messages: [], stream: true }) });
  const options = { useBunProxy: false, fetchImpl: async () => { directCalls++; throw new Error("direct forbidden"); }, proxyFetchImpl: (_url, opts, proxyAddress) => { bridgeCalls++; return proxyFetch(targetUrl, opts, proxyAddress); } };
  try {
    const res = await handleBridgeRequest(request(), options);
    assert.equal(res.status, 200);
    await res.body.cancel();
    assert.equal(bridgeCalls, 1); assert.equal(proxyCalls, 1); assert.equal(targetCalls, 1); assert.equal(directCalls, 0);
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    const failed = await handleBridgeRequest(request(), options);
    assert.equal(failed.status, 502);
    assert.equal(bridgeCalls, 2); assert.equal(targetCalls, 1); assert.equal(directCalls, 0);
  } finally { proxy.closeAllConnections(); proxy.close(); target.closeAllConnections(); await new Promise((r) => target.close(r)); }
});

test("bridge require proxy rejects missing proxy before any fetch", async () => {
  let calls = 0;
  const req = new Request("http://localhost:20129/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-zenith-require-proxy": "1" }, body: JSON.stringify({ model: "opencode/free", messages: [] }) });
  const res = await handleBridgeRequest(req, { fetchImpl: async () => { calls++; return new Response("{}"); }, proxyFetchImpl: async () => { calls++; return new Response("{}"); } });
  assert.equal(res.ok, false);
  assert.equal(calls, 0);
});

test("real executor with dead proxy under require makes zero direct deliveries", async () => {
  let directCalls = 0;
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const executor = new OpencodeExecutor();
  executor.fetchFn = async () => { directCalls++; return new Response("{}"); };
  let res;
  try {
    res = await executor.execute({
      url: "https://opencode.ai/inference/v1/chat/completions",
      body: { model: "glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] },
      proxyUrl: `http://127.0.0.1:${deadPort}`,
      requireProxy: true,
      stream: false,
      targetModel: "glm-5.3-flash-free",
      targetFormat: "openai",
    });
    assert.notEqual(res.status, 200);
  } catch (err) {
    assert.ok(err, "a transport error is an acceptable refusal");
  }
  assert.equal(directCalls, 0);
});

test("policy modes: direct ignores pools, prefer falls back direct only when no scoped pool, legacy unchanged", async () => {
  initDb(":memory:");
  const pool = addProxyPool({ name: "p", url: "http://p.local:3128" });
  const calls = [];
  setCustomExecutor({ async execute(args) { calls.push(args); return new Response("{}", { status: 200 }); } });
  const send = () => app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "opencode/glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }) });
  try {
    setSetting("opencode_egress_policy", "direct");
    setSetting("opencode_proxy_pool_ids", JSON.stringify([pool.id]));
    assert.equal((await send()).status, 200);
    assert.equal(calls.at(-1).proxyUrl ?? null, null);

    setSetting("opencode_egress_policy", "prefer");
    assert.equal((await send()).status, 200);
    assert.equal(calls.at(-1).proxyUrl, pool.url);
    assert.ok(!calls.at(-1).requireProxy);

    setSetting("opencode_proxy_pool_ids", "[]");
    assert.equal((await send()).status, 200);
    assert.equal(calls.at(-1).proxyUrl ?? null, null);

    setSetting("opencode_egress_policy", "legacy");
    assert.equal((await send()).status, 200);
    assert.ok(!calls.at(-1).requireProxy);
  } finally { setCustomExecutor(null); }
});
