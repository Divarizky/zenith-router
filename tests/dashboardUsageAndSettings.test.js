import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { recordUsage } from "../src/services/usage.js";
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
});

test("GET /dashboard/settings - renders Settings page with form", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/settings");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Settings"));
  assert.ok(html.includes("require_api_key"));
  assert.ok(html.includes("token_saver_rtk"));
  assert.ok(html.includes("token_saver_caveman"));
});

test("POST /dashboard/settings - updates settings in SQLite and redirects", async () => {
  initDb(":memory:");

  const formData = new FormData();
  formData.append("require_api_key", "true");
  formData.append("token_saver_rtk", "true");
  formData.append("token_saver_caveman", "false");
  formData.append("default_fallback_model", "codex/gpt-4o");

  const res = await app.request("/dashboard/settings", {
    method: "POST",
    body: formData,
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/settings");

  // Verify in SQLite
  assert.strictEqual(getSetting("require_api_key"), "true");
  assert.strictEqual(getSetting("token_saver_caveman"), "false");
  assert.strictEqual(getSetting("default_fallback_model"), "codex/gpt-4o");
});
