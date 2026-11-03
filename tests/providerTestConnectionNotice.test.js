import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { app } from "../src/index.js";

test("GET /dashboard/providers/:id with notice=test_ok renders success notice banner", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/providers/opencode?notice=test_ok&msg=HTTP%20200%20OK%20(120ms)");
  assert.strictEqual(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes("notice-ok"), "must render green success notice banner");
  assert.ok(html.includes("Koneksi berhasil: HTTP 200 OK (120ms)"), "must show detail msg");
});

test("GET /dashboard/providers/:id with notice=test_fail renders error notice banner", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/providers/opencode?notice=test_fail&msg=HTTP%20401%20Unauthorized");
  assert.strictEqual(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes("notice-error"), "must render red error notice banner");
  assert.ok(html.includes("Koneksi gagal: HTTP 401 Unauthorized"), "must show error detail");
});
