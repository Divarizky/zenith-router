import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { listApiKeys, verifyApiKey } from "../src/services/apiKeys.js";
import { recordUsage } from "../src/services/usage.js";
import { escapeHtml } from "../src/ui/html.js";

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

test("escapeHtml - escapes markup and quotes", () => {
  assert.strictEqual(escapeHtml(`<a href="x">'&</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;");
  assert.strictEqual(escapeHtml(null), "");
  assert.strictEqual(escapeHtml(42), "42");
});

test("GET /dashboard/keys - renders policy, form, and API Keys tab", async () => {
  initDb(":memory:");
  const res = await app.request("/dashboard/keys");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("API Keys"));
  assert.ok(html.includes("/dashboard/keys/create"));
  assert.ok(html.includes("Not required"));
});

test("POST /dashboard/keys/create - shows the plaintext key once and lists only the prefix after", async () => {
  initDb(":memory:");
  const res = await app.request("/dashboard/keys/create", { method: "POST", body: form({ name: "Claude Code" }) });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.headers.get("cache-control"), "no-store");

  const html = await res.text();
  const match = html.match(/zr_[A-Za-z0-9_-]{43}/);
  assert.ok(match, "Created page must include the full key");
  assert.ok(verifyApiKey(match[0]));

  const later = await (await app.request("/dashboard/keys")).text();
  assert.ok(!later.includes(match[0]), "Full key must not be shown again");
  assert.ok(later.includes(match[0].slice(0, 10)));
});

test("POST /dashboard/keys/toggle and /delete - manage key status", async () => {
  initDb(":memory:");
  await app.request("/dashboard/keys/create", { method: "POST", body: form({ name: "Pi" }) });
  const [key] = listApiKeys();

  const off = await app.request("/dashboard/keys/toggle", { method: "POST", body: form({ id: String(key.id), active: "false" }) });
  assert.strictEqual(off.status, 302);
  assert.strictEqual(listApiKeys()[0].is_active, 0);

  await app.request("/dashboard/keys/toggle", { method: "POST", body: form({ id: String(key.id), active: "true" }) });
  assert.strictEqual(listApiKeys()[0].is_active, 1);

  await app.request("/dashboard/keys/delete", { method: "POST", body: form({ id: String(key.id) }) });
  assert.strictEqual(listApiKeys().length, 0);
});

test("dashboard - stored values are escaped (no stored XSS)", async () => {
  initDb(":memory:");
  const payload = "<script>alert(1)</script>";
  addConnection({ provider: "glm", name: payload, credentials: { api_key: "k" } });
  recordUsage({ model: payload, inputTokens: 1, outputTokens: 1 });
  await app.request("/dashboard/keys/create", { method: "POST", body: form({ name: payload }) });

  for (const path of ["/dashboard/connections", "/dashboard/usage", "/dashboard/keys"]) {
    const html = await (await app.request(path)).text();
    assert.ok(!html.includes(payload), `${path} must escape stored values`);
    assert.ok(html.includes("&lt;script&gt;"), `${path} must render the escaped value`);
  }
});
