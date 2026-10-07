import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import {
  initConsoleLogCapture,
  getConsoleLogs,
  clearConsoleLogs,
} from "../src/services/logger.js";

test("logger service - captures console calls and strips ANSI codes", () => {
  initConsoleLogCapture();
  clearConsoleLogs();

  console.log("\x1b[32mTest log message\x1b[0m");
  console.warn("Warning test");
  console.error("Error test");

  const logs = getConsoleLogs();
  assert.ok(logs.length >= 3);
  assert.ok(logs.some((l) => l.includes("[LOG] Test log message")));
  assert.ok(logs.some((l) => l.includes("[WARN] Warning test")));
  assert.ok(logs.some((l) => l.includes("[ERROR] Error test")));
  assert.ok(!logs.some((l) => l.includes("\x1b[32m")), "ANSI codes must be stripped");
});

test("GET /api/console-logs - returns JSON logs list", async () => {
  initConsoleLogCapture();
  clearConsoleLogs();
  console.log("Activity from test");

  const res = await app.request("/api/console-logs");
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.logs));
  assert.ok(data.logs.some((l) => l.includes("Activity from test")));
});

test("DELETE /api/console-logs - clears logs buffer", async () => {
  initConsoleLogCapture();
  console.log("Before clear");

  const delRes = await app.request("/api/console-logs", { method: "DELETE" });
  assert.strictEqual(delRes.status, 200);
  const delData = await delRes.json();
  assert.strictEqual(delData.ok, true);

  const getRes = await app.request("/api/console-logs");
  const data = await getRes.json();
  assert.strictEqual(data.logs.length, 0);
});

test("GET /dashboard - includes Console Log terminal card", async () => {
  const res = await app.request("/dashboard");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Console Log"));
  assert.ok(html.includes("console-terminal"));
  assert.ok(html.includes("/api/console-logs/stream"));
  assert.ok(html.includes("log-filter"));
});
