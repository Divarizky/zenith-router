import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { app } from "../src/index.js";
import pkg from "../package.json" with { type: "json" };

test("GET /health - reports the version from package.json", async () => {
  initDb(":memory:");

  const res = await app.request("/health");
  assert.strictEqual(res.status, 200);

  const json = await res.json();
  assert.strictEqual(json.status, "ok");
  assert.strictEqual(json.service, "zenith-router");
  assert.strictEqual(json.version, pkg.version, "health version follows package.json");
});

test("GET /dashboard - sidebar version follows package.json", async () => {
  initDb(":memory:");

  const html = await (await app.request("/dashboard")).text();
  assert.ok(html.includes(`<small>v${pkg.version}</small>`));
});

test("GET /dashboard - returns Overview HTML page with tabs and status", async () => {
  initDb(":memory:");

  addConnection({
    provider: "glm",
    name: "GLM User",
    credentials: { api_key: "k1" },
  });

  const res = await app.request("/dashboard");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Zenith Router"));
  assert.ok(html.includes("Overview"));
  assert.ok(html.includes("Providers"));
  assert.ok(html.includes("Usage & Quota"));
  assert.ok(html.includes("Settings"));
  assert.ok(html.includes("20120"));
  assert.ok(html.includes("Koneksi Aktif"));
  assert.ok(html.includes("Console Log"));
  assert.ok(html.includes("console-terminal"));
});

test("GET / - redirects or renders dashboard overview", async () => {
  initDb(":memory:");

  const res = await app.request("/");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Zenith Router"));
});
