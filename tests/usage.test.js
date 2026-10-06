import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { recordUsage, getUsageStats } from "../src/services/usage.js";
import { app } from "../src/index.js";

test("usage service - recordUsage saves entry to usage_history safely", () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "glm",
    name: "GLM Acc",
    credentials: { api_key: "k1" },
  });

  const record = recordUsage({
    connectionId: conn.id,
    model: "glm-4-flash",
    inputTokens: 120,
    outputTokens: 45,
    durationMs: 320,
  });

  assert.ok(record);
  assert.strictEqual(record.model, "glm-4-flash");
  assert.strictEqual(record.input_tokens, 120);
  assert.strictEqual(record.output_tokens, 45);
  assert.strictEqual(record.total_tokens, 165);
});

test("usage service - getUsageStats aggregates total tokens and breakdowns", () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "claude",
    name: "Claude Acc",
    credentials: { api_key: "k2" },
  });

  recordUsage({
    connectionId: conn.id,
    model: "claude-3-7-sonnet",
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 400,
  });

  recordUsage({
    connectionId: conn.id,
    model: "claude-3-7-sonnet",
    inputTokens: 200,
    outputTokens: 100,
    durationMs: 600,
  });

  recordUsage({
    connectionId: conn.id,
    model: "claude-3-5-haiku",
    inputTokens: 50,
    outputTokens: 20,
    durationMs: 200,
  });

  const stats = getUsageStats();
  assert.ok(stats.summary);
  assert.strictEqual(stats.summary.total_requests, 3);
  assert.strictEqual(stats.summary.total_input_tokens, 350);
  assert.strictEqual(stats.summary.total_output_tokens, 170);
  assert.strictEqual(stats.summary.total_tokens, 520);

  assert.ok(Array.isArray(stats.by_model));
  assert.strictEqual(stats.by_model.length, 2);

  const sonnetStats = stats.by_model.find((m) => m.model === "claude-3-7-sonnet");
  assert.ok(sonnetStats);
  assert.strictEqual(sonnetStats.count, 2);
  assert.strictEqual(sonnetStats.total_tokens, 450);
});

test("GET /api/usage - returns JSON usage analytics", async () => {
  initDb(":memory:");

  recordUsage({
    connectionId: null,
    model: "opencode-free",
    inputTokens: 10,
    outputTokens: 10,
    durationMs: 150,
  });

  const res = await app.request("/api/usage");
  assert.strictEqual(res.status, 200);

  const json = await res.json();
  assert.ok(json.summary);
  assert.strictEqual(json.summary.total_requests, 1);
  assert.strictEqual(json.summary.total_tokens, 20);
});
