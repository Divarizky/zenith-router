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

test("usage service - records apiKeyId and aggregates by_api_key", () => {
  const db = initDb(":memory:");

  // Insert two api keys
  const k1 = db
    .prepare("INSERT INTO api_keys (name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .get("Agent Alpha", "zr_alpha", "hash1", Date.now());
  const k2 = db
    .prepare("INSERT INTO api_keys (name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .get("Agent Beta", "zr_beta", "hash2", Date.now());

  recordUsage({
    apiKeyId: k1.id,
    model: "claude-3-7-sonnet",
    inputTokens: 100,
    outputTokens: 50,
  });
  recordUsage({
    apiKeyId: k1.id,
    model: "claude-3-7-sonnet",
    inputTokens: 100,
    outputTokens: 50,
  });
  recordUsage({
    apiKeyId: k2.id,
    model: "gpt-4o",
    inputTokens: 300,
    outputTokens: 200,
  });
  recordUsage({
    apiKeyId: null, // anonymous
    model: "gpt-4o",
    inputTokens: 50,
    outputTokens: 50,
  });

  const stats = getUsageStats();
  assert.ok(Array.isArray(stats.by_api_key));
  assert.strictEqual(stats.by_api_key.length, 3);

  const alpha = stats.by_api_key.find((k) => k.name === "Agent Alpha");
  assert.ok(alpha);
  assert.strictEqual(alpha.count, 2);
  assert.strictEqual(alpha.total_tokens, 300);

  const beta = stats.by_api_key.find((k) => k.name === "Agent Beta");
  assert.ok(beta);
  assert.strictEqual(beta.count, 1);
  assert.strictEqual(beta.total_tokens, 500);

  const anon = stats.by_api_key.find((k) => k.name === "anonymous");
  assert.ok(anon);
  assert.strictEqual(anon.count, 1);
  assert.strictEqual(anon.total_tokens, 100);
});

test("usage service - getUsageStats aggregates by_provider via connections", () => {
  initDb(":memory:");

  const c1 = addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "k1" } });
  const c2 = addConnection({ provider: "glm", name: "GLM Acc 2", credentials: { api_key: "k2" } });

  recordUsage({ connectionId: c1.id, model: "glm-4-flash", inputTokens: 100, outputTokens: 50 });
  recordUsage({ connectionId: c2.id, model: "glm-4-flash", inputTokens: 200, outputTokens: 100 });

  const stats = getUsageStats();
  assert.ok(Array.isArray(stats.by_provider));
  const glm = stats.by_provider.find((p) => p.provider === "glm");
  assert.ok(glm);
  assert.strictEqual(glm.count, 2);
  assert.strictEqual(glm.total_tokens, 450);
});
