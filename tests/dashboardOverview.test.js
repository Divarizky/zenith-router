import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { app } from "../src/index.js";

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
  assert.ok(html.includes("zenroute"));
  assert.ok(html.includes("Overview"));
  assert.ok(html.includes("Connections"));
  assert.ok(html.includes("Usage"));
  assert.ok(html.includes("Settings"));
  assert.ok(html.includes("20120"));
  assert.ok(html.includes("Active Connections"));
});

test("GET / - redirects or renders dashboard overview", async () => {
  initDb(":memory:");

  const res = await app.request("/");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("zenroute"));
});
