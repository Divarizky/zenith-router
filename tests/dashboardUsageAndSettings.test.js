import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { recordUsage } from "../src/services/usage.js";
import { setCustomQuotaFetcher } from "../src/services/quota.js";
import { getSetting, setSetting } from "../src/services/settings.js";
import { app } from "../src/index.js";

test("GET /dashboard/usage - renders Usage Analytics page with model breakdown", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "glm",
    name: "GLM Key",
    credentials: { api_key: "k1" },
  });

  recordUsage({
    connectionId: conn.id,
    model: "glm-4-flash",
    inputTokens: 250,
    outputTokens: 75,
    durationMs: 400,
  });

  const res = await app.request("/dashboard/usage");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Usage Analytics"));
  assert.ok(html.includes("glm-4-flash"));
  assert.ok(html.includes("325")); // total tokens
  // Topology dataset includes provider icon URL
  assert.ok(html.includes("&quot;icon&quot;:&quot;/providers/glm.png&quot;"));
  // Node animation for the provider currently in use
  assert.ok(html.includes("topo-node-breathe"), "active node breathes");
  assert.ok(html.includes("topo-glow-"), "active node gets an SVG glow filter");
  assert.ok(html.includes("topo-router-pulse"), "router core pulses while powering");
  assert.ok(html.includes("/api/topology/active"), "topology state is polled live");
  // Quota card renders the provider icon image
  assert.ok(html.includes("<img src=\"/providers/glm.png\""));
});

test("GET /dashboard/settings - renders Settings page with form", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/settings");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Settings"));
  assert.ok(html.includes("require_api_key"));

  // Settings splits into two sections in one form with a single save button.
  assert.ok(html.includes("General"));
  assert.ok(html.includes("Accounts &amp; Connections"));
  assert.strictEqual(
    (html.match(/<form action="\/dashboard\/settings"/g) || []).length,
    1,
    "both sections share one form"
  );
  assert.strictEqual((html.match(/Simpan Pengaturan/g) || []).length, 1, "one save button");
  // Auto quota sync has no on/off toggle anymore.
  assert.ok(!html.includes("quota_auto_sync"));
  assert.ok(!html.includes("Auto Sinkron Kuota"));
});

test("GET /dashboard/token-saver - renders Token Saver page with toggles", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/token-saver");
  assert.strictEqual(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes("Token Saver"));
  assert.ok(html.includes("token_saver_rtk"));
  assert.ok(html.includes("token_saver_caveman"));
});

test("POST /dashboard/settings - updates settings in SQLite and redirects with saved notice", async () => {
  initDb(":memory:");

  const formData = new FormData();
  formData.append("require_api_key", "true");

  const res = await app.request("/dashboard/settings", {
    method: "POST",
    body: formData,
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/settings?saved=1");

  // Verify in SQLite
  assert.strictEqual(getSetting("require_api_key"), "true");

  const html = await (await app.request(res.headers.get("location"))).text();
  assert.ok(html.includes("Pengaturan Gateway berhasil disimpan."));
});

test("POST /dashboard/quota/sync/all - refreshes every linked provider quota", async () => {
  initDb(":memory:");
  addConnection({
    provider: "glm",
    name: "GLM Bulk",
    credentials: { api_key: "k1", quota: { remaining: 1, unit: "tokens" } },
  });
  setCustomQuotaFetcher(async () => ({ remaining: 42, unit: "tokens", is_exhausted: false }));

  try {
    const res = await app.request("/dashboard/quota/sync/all", { method: "POST" });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/dashboard/usage?synced=1");

    const json = await (await app.request("/api/quota")).json();
    assert.strictEqual(json[0].quota.remaining, 42, "bulk sync wrote the fresh value");

    const html = await (await app.request("/dashboard/usage?synced=1")).text();
    assert.ok(html.includes("/dashboard/quota/sync/all"), "usage page keeps the re-sync button");
    assert.ok(html.includes("Kuota semua akun tertaut berhasil disegarkan"));
    assert.ok(html.includes("Auto setiap 15 menit"), "auto-sync cadence is shown");
  } finally {
    setCustomQuotaFetcher(null);
  }
});

test("POST /dashboard/token-saver - updates token saver settings and redirects with saved notice", async () => {
  initDb(":memory:");

  const formData = new FormData();
  formData.append("token_saver_rtk", "true");
  formData.append("token_saver_caveman", "false");

  const res = await app.request("/dashboard/token-saver", {
    method: "POST",
    body: formData,
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/token-saver?saved=1");
  assert.strictEqual(getSetting("token_saver_caveman"), "false");

  const html = await (await app.request(res.headers.get("location"))).text();
  assert.ok(html.includes("Pengaturan Token Saver berhasil disimpan."));
});

test("GET /api/topology/active - reports live in-flight and last provider", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "glm",
    name: "GLM Live",
    credentials: { api_key: "k1" },
  });
  recordUsage({
    connectionId: conn.id,
    model: "glm-4-flash",
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 100,
  });
  // No-auth traffic has no connection row; the provider column carries it instead.
  recordUsage({
    connectionId: null,
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
    inputTokens: 5,
    outputTokens: 5,
    durationMs: 50,
  });

  const res = await app.request("/api/topology/active");
  assert.strictEqual(res.status, 200);

  const json = await res.json();
  assert.ok(Array.isArray(json.active), "active is an array");
  assert.deepStrictEqual(json.active, [], "no request in flight");
  assert.strictEqual(json.last, "opencode", "most recent provider wins, even without a connection");
});

test("GET /dashboard/usage - quota cards use a fixed 2-column grid", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/usage")).text();
  assert.ok(html.includes("grid-template-columns: repeat(2, minmax(0, 1fr))"));
  assert.ok(!html.includes("auto-fit, minmax(300px"));
});
