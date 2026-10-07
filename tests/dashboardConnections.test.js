import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnectionById } from "../src/db/index.js";
import { app } from "../src/index.js";

test("GET /dashboard/connections - renders connections page with accounts and form", async () => {
  initDb(":memory:");

  addConnection({
    provider: "glm",
    name: "GLM Main",
    credentials: { api_key: "k_test" },
  });

  const res = await app.request("/dashboard/connections");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Connections"));
  assert.ok(html.includes("GLM Main"));
  assert.ok(html.includes("Add New Connection"));
  assert.ok(html.includes("/dashboard/connections/add"));
});

test("POST /dashboard/connections/add - creates connection in SQLite and redirects", async () => {
  initDb(":memory:");

  const formData = new FormData();
  formData.append("provider", "claude");
  formData.append("name", "Claude Work");
  formData.append("auth_type", "apikey");
  formData.append("api_key", "sk-ant-test12345");
  formData.append("proxy_url", "http://127.0.0.1:1080");

  const res = await app.request("/dashboard/connections/add", {
    method: "POST",
    body: formData,
  });

  // Should redirect back to /dashboard/connections
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/connections");

  // Verify record in SQLite
  const list = await app.request("/dashboard/connections");
  const html = await list.text();
  assert.ok(html.includes("Claude Work"));
  assert.ok(html.includes("127.0.0.1:1080"));
});

test("POST /dashboard/connections/delete - deletes connection and redirects", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "codex",
    name: "Temporary Account",
    credentials: { api_key: "temp" },
  });

  const formData = new FormData();
  formData.append("id", String(conn.id));

  const res = await app.request("/dashboard/connections/delete", {
    method: "POST",
    body: formData,
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/connections");

  const inDb = getConnectionById(conn.id);
  assert.strictEqual(inDb, null);
});
