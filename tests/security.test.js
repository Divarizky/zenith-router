import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getConnections } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { createApiKey, setApiKeyActive } from "../src/services/apiKeys.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { applyConnectionAuth } from "../src/services/auth.js";
import { isApiKeyRequired } from "../src/security.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const chatBody = JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] });

function captureExecutor() {
  const calls = [];
  setCustomExecutor({
    async execute(opts) {
      calls.push(opts);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return calls;
}

function withEnv(vars, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("security - no CORS headers on /v1 by default", async () => {
  initDb(":memory:");
  const res = await app.request("/v1/models", { headers: { Origin: "https://evil.example" } });
  assert.strictEqual(res.headers.get("access-control-allow-origin"), null);
});

test("security - CORS is opt-in through ZENROUTE_CORS_ORIGINS", async () => {
  initDb(":memory:");
  await withEnv({ ZENROUTE_CORS_ORIGINS: "http://localhost:3000" }, async () => {
    const ok = await app.request("/v1/models", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
    });
    assert.strictEqual(ok.headers.get("access-control-allow-origin"), "http://localhost:3000");

    const evil = await app.request("/v1/models", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    assert.notStrictEqual(evil.headers.get("access-control-allow-origin"), "https://evil.example");
  });
});

test("security - host guard blocks non-loopback Host headers (DNS rebinding)", async () => {
  initDb(":memory:");
  assert.strictEqual((await app.request("http://evil.example/health")).status, 403);
  assert.strictEqual((await app.request("http://127.0.0.1/health")).status, 200);
  assert.strictEqual((await app.request("http://localhost/health")).status, 200);

  await withEnv({ ZENROUTE_ALLOWED_HOSTS: "zenroute.local" }, async () => {
    assert.strictEqual((await app.request("http://zenroute.local/health")).status, 200);
  });
});

test("security - dashboard and /api are localhost-only", async () => {
  initDb(":memory:");
  const remote = (address) => ({ incoming: { socket: { remoteAddress: address } } });

  assert.strictEqual((await app.request("/dashboard", {}, remote("192.168.1.20"))).status, 403);
  assert.strictEqual((await app.request("/api/usage", {}, remote("10.0.0.5"))).status, 403);
  assert.strictEqual((await app.request("/dashboard", {}, remote("127.0.0.1"))).status, 200);
  assert.strictEqual((await app.request("/dashboard", {}, remote("::ffff:127.0.0.1"))).status, 200);
  assert.strictEqual((await app.request("/dashboard", {}, remote("::1"))).status, 200);
});

test("security - dashboard POSTs reject cross-site requests (CSRF)", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "glm", name: "Keep me", credentials: { api_key: "k" } });
  const form = () => {
    const fd = new FormData();
    fd.append("id", String(conn.id));
    return fd;
  };

  const evilOrigin = await app.request("/dashboard/providers/accounts/delete", {
    method: "POST",
    headers: { Origin: "https://evil.example" },
    body: form(),
  });
  assert.strictEqual(evilOrigin.status, 403);

  const crossSite = await app.request("/dashboard/providers/accounts/delete", {
    method: "POST",
    headers: { "Sec-Fetch-Site": "cross-site" },
    body: form(),
  });
  assert.strictEqual(crossSite.status, 403);
  assert.strictEqual(getConnections().length, 1, "Connection must survive blocked requests");

  const sameOrigin = await app.request("/dashboard/providers/accounts/delete", {
    method: "POST",
    headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
    body: form(),
  });
  assert.strictEqual(sameOrigin.status, 302);
  assert.strictEqual(getConnections().length, 0);
});

test("security - /v1 POST requires a JSON content type", async () => {
  initDb(":memory:");
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: chatBody,
  });
  assert.strictEqual(res.status, 415);
});

test("security - gateway keys are enforced when require_api_key is on", async () => {
  initDb(":memory:");
  setSetting("require_api_key", "true");
  const created = createApiKey("Claude Code");

  assert.strictEqual((await app.request("/v1/models")).status, 401);
  assert.strictEqual((await app.request("/v1/models", { headers: { Authorization: "Bearer zr_wrong" } })).status, 401);
  assert.strictEqual((await app.request("/v1/models", { headers: { Authorization: `Bearer ${created.key}` } })).status, 200);
  assert.strictEqual((await app.request("/v1/models", { headers: { "x-api-key": created.key } })).status, 200);

  setApiKeyActive(created.id, false);
  assert.strictEqual((await app.request("/v1/models", { headers: { Authorization: `Bearer ${created.key}` } })).status, 401);

  const anthropic = await app.request("/v1/messages", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: "cc/claude-x", messages: [] }),
  });
  assert.strictEqual(anthropic.status, 401);
  const json = await anthropic.json();
  assert.strictEqual(json.type, "error");
  assert.strictEqual(json.error.type, "authentication_error");
});

test("security - binding to a non-loopback host forces gateway keys", async () => {
  initDb(":memory:");
  await withEnv({ HOST: "0.0.0.0" }, async () => {
    assert.strictEqual(isApiKeyRequired(), true);
    assert.strictEqual((await app.request("/v1/models")).status, 401);
  });
  assert.strictEqual(isApiKeyRequired(), false);
});

test("security - client auth headers are never forwarded upstream", async () => {
  initDb(":memory:");
  setSetting("require_api_key", "true");
  addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "STORED_KEY" } });
  const gatewayKey = createApiKey("Pi").key;
  const calls = captureExecutor();

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${gatewayKey}`, "x-api-key": gatewayKey },
    body: chatBody,
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls[0].headers.Authorization, "Bearer STORED_KEY");
  assert.strictEqual(calls[0].headers["x-api-key"], undefined);
  setCustomExecutor(null);
});

test("security - missing connection returns 503 instead of calling upstream", async () => {
  initDb(":memory:");
  const calls = captureExecutor();

  const chat = await app.request("/v1/chat/completions", { method: "POST", headers: JSON_HEADERS, body: chatBody });
  assert.strictEqual(chat.status, 503);
  assert.strictEqual((await chat.json()).error.code, "no_available_connection");

  const messages = await app.request("/v1/messages", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: "cc/claude-x", max_tokens: 5, messages: [{ role: "user", content: "hello" }] }),
  });
  assert.strictEqual(messages.status, 503);
  assert.strictEqual((await messages.json()).type, "error");
  assert.strictEqual(calls.length, 0);
  setCustomExecutor(null);
});

test("security - applyConnectionAuth follows the connection auth type", () => {
  assert.deepStrictEqual(
    applyConnectionAuth({}, { provider: "claude", auth_type: "apikey", credentials: { api_key: "sk-ant" } }),
    { "x-api-key": "sk-ant" }
  );
  assert.deepStrictEqual(
    applyConnectionAuth({}, { provider: "claude", auth_type: "oauth", credentials: { access_token: "tok" } }),
    { Authorization: "Bearer tok" }
  );
  assert.deepStrictEqual(
    applyConnectionAuth({}, { provider: "glm", auth_type: "apikey", credentials: { api_key: "k" } }),
    { Authorization: "Bearer k" }
  );
  assert.deepStrictEqual(applyConnectionAuth({}, { provider: "opencode", auth_type: "noauth", credentials: {} }), {});
});

test("security - dashboard connection form validates provider, proxy, and auth type", async () => {
  initDb(":memory:");
  const submit = (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return app.request("/dashboard/providers/accounts/add", { method: "POST", body: fd });
  };

  await submit({ provider: "not-a-provider", name: "X", api_key: "k" });
  await submit({ provider: "glm", name: "Bad proxy", api_key: "k", proxy_url: "javascript:alert(1)" });
  assert.strictEqual(getConnections().length, 0);

  await submit({ provider: "claude", name: "Key", auth_type: "apikey", api_key: "sk-ant" });
  await submit({ provider: "claude", name: "Token", auth_type: "oauth", api_key: "tok" });
  const [apiKeyConn, oauthConn] = getConnections();
  assert.deepStrictEqual(apiKeyConn.credentials, { api_key: "sk-ant" });
  assert.deepStrictEqual(oauthConn.credentials, { access_token: "tok" });
});
