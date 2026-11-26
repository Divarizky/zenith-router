import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { recordUsage } from "../src/services/usage.js";
import { setCustomQuotaFetcher } from "../src/services/quota.js";
import { getSetting, setSetting } from "../src/services/settings.js";
import { app } from "../src/index.js";

function form(fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  return body;
}

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

test("GET /api/usage/recent - returns the latest usage entries as JSON", async () => {
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

  const res = await app.request("/api/usage/recent?limit=10");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("application/json"));

  const body = await res.json();
  assert.ok(Array.isArray(body.recent), "recent is an array");
  assert.strictEqual(body.recent.length, 1);
  assert.strictEqual(body.recent[0].model, "glm-4-flash");
  assert.strictEqual(body.recent[0].input_tokens, 250);
  assert.strictEqual(body.recent[0].output_tokens, 75);
});

test("GET /dashboard/usage - Recent Requests panel is wired for live refresh", async () => {
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

  const html = await res.text();
  assert.ok(html.includes('id="recent-body"'), "panel body is replaceable");
  assert.ok(html.includes('id="recent-count"'), "panel badge is updatable");
  assert.ok(html.includes("/api/usage/recent"), "client polls the recent endpoint");
});

test("GET /dashboard/settings - renders Settings page with form", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/settings");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Settings"));
  assert.ok(html.includes("require_api_key"));

  // Settings splits into four sections in one form with a single save button.
  assert.ok(html.includes("Access &amp; Security"));
  assert.ok(html.includes("Account Selection"));
  assert.ok(html.includes("Account Protection"));
  assert.ok(html.includes("Routing &amp; Fallback"));
  assert.ok(html.includes('formaction="/dashboard/settings/password/reset"'), "tombol reset password ke default ada di form");
  assert.strictEqual(
    (html.match(/<form action="\/dashboard\/settings"/g) || []).length,
    1,
    "both sections share one form"
  );
  assert.strictEqual((html.match(/Simpan Pengaturan/g) || []).length, 1, "one save button");
  assert.strictEqual((html.match(/class="settings-actions"/g) || []).length, 1, "satu bar simpan");
  assert.ok(!html.includes("margin-top: 1.75rem"), "jarak antar bagian memakai CSS, bukan inline style");
  // Auto quota sync has no on/off toggle anymore.
  assert.ok(!html.includes("quota_auto_sync"));
  assert.ok(!html.includes("Auto Sinkron Kuota"));
});

test("GET /dashboard/settings - renders DLP and Token Saver settings", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/settings");
  assert.strictEqual(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes("Token &amp; Prompt Saver") || html.includes("Token & Prompt Saver"));
  assert.ok(html.includes("token_saver_rtk"));
  assert.ok(html.includes("token_saver_caveman"));
  assert.ok(html.includes("dlp_mode"));
});

test("GET /dashboard/token-saver - redirects to settings#tokensaver", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/token-saver");
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/settings#tokensaver");
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

test("POST /dashboard/token-saver - legacy route saves settings and redirects to settings#tokensaver", async () => {
  initDb(":memory:");

  const formData = new FormData();
  formData.append("token_saver_rtk", "true");
  formData.append("token_saver_caveman", "false");

  const res = await app.request("/dashboard/token-saver", {
    method: "POST",
    body: formData,
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/settings?saved=1#tokensaver");
  assert.strictEqual(getSetting("token_saver_caveman"), "false");
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

test("POST /dashboard/settings - combo hold count is saved and clamped to at least one", async () => {
  initDb(":memory:");

  const ok = new FormData();
  ok.append("combo_round_robin_count", "3");
  const res = await app.request("/dashboard/settings", { method: "POST", body: ok });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(getSetting("combo_round_robin_count"), "3");

  const html = await (await app.request("/dashboard/settings")).text();
  assert.ok(html.includes('name="combo_round_robin_count"'), "field batas giliran harus tampil di halaman");

  for (const bad of ["-5", "abc", ""]) {
    const form = new FormData();
    form.append("combo_round_robin_count", bad);
    await app.request("/dashboard/settings", { method: "POST", body: form });
    assert.strictEqual(getSetting("combo_round_robin_count"), "1", `"${bad}" harus jatuh ke 1`);
  }
});

test("GET /dashboard/usage - the recent panel attributes a request to its combo", async () => {
  initDb(":memory:");

  const conn = addConnection({ provider: "glm", name: "GLM Key", credentials: { api_key: "k1" } });
  recordUsage({
    connectionId: conn.id,
    provider: "glm",
    model: "glm-4-flash",
    comboName: "antai-utama",
    inputTokens: 10,
    outputTokens: 20,
    durationMs: 100,
  });

  const html = await (await app.request("/dashboard/usage")).text();
  assert.ok(html.includes("antai-utama"), "nama combo tampil di panel request terbaru");
  assert.ok(html.includes("esc(r.fallback_from || r.combo_name"), "pembaruan live merender nama combo, bukan sekadar memuatnya");

  const api = JSON.parse(await (await app.request("/api/usage/recent")).text());
  assert.strictEqual(api.recent[0].combo_name, "antai-utama");
});

test("Dashboard usage - kartu kuota menampilkan pill 'Kuota Habis' saat limit habis", async () => {
  initDb(":memory:");
  addConnection({
    provider: "openrouter",
    name: "OpenRouter Exhausted",
    credentials: {
      api_key: "sk-or-exhausted",
      quota: {
        provider: "openrouter",
        is_exhausted: true,
        remaining: 0,
        limit: 10,
        usage: 10,
        unit: "credits_usd",
      },
    },
  });

  const res = await app.request("/dashboard/usage");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("OpenRouter Exhausted"));
  assert.ok(html.includes('<span class="pill pill-danger">Kuota Habis</span>'));
  assert.ok(!html.includes('<span class="pill pill-danger">Exhausted</span>'));
});

test("POST /dashboard/settings/password/reset - mereset password ke default 123456 dan redirect", async () => {
  const { initDb } = await import("../src/db/index.js");
  const { setDashboardPassword, isUsingDefaultPassword, verifyDashboardPassword } = await import("../src/services/dashboardAuth.js");
  initDb(":memory:");
  setDashboardPassword("kunciRahasiaBaru", "123456");
  assert.strictEqual(isUsingDefaultPassword(), false);

  // Tanpa password lama: reset ditolak, setting tidak berubah.
  const rejected = await app.request(
    "/dashboard/settings/password/reset",
    { method: "POST", body: form({}) }
  );
  assert.strictEqual(rejected.status, 302);
  assert.ok(rejected.headers.get("location").startsWith("/dashboard/settings?pw_error="), "reset tanpa re-autentikasi ditolak");
  assert.strictEqual(isUsingDefaultPassword(), false, "password lama masih berlaku setelah reset ditolak");

  // Dengan password lama yang benar: reset diterima.
  const res = await app.request(
    "/dashboard/settings/password/reset",
    { method: "POST", body: form({ current_password: "kunciRahasiaBaru" }) }
  );
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/settings?reset=1#password");
  assert.strictEqual(isUsingDefaultPassword(), true);
  assert.strictEqual(verifyDashboardPassword("123456"), true);
});
