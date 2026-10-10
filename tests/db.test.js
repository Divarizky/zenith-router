import test from "node:test";
import assert from "node:assert";
import {
  initDb,
  getDb,
  closeDb,
  addConnection,
  getConnections,
  getConnectionById,
  updateConnection,
  deleteConnection,
  setConnectionCooldown,
} from "../src/db/index.js";

test("Database - initializes tables in in-memory mode", () => {
  const db = initDb(":memory:");
  assert.ok(db, "Database instance must be initialized");

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);

  assert.ok(tables.includes("connections"), "Table connections must exist");
  assert.ok(tables.includes("combos"), "Table combos must exist");
  assert.ok(tables.includes("settings"), "Table settings must exist");
  assert.ok(tables.includes("usage_history"), "Table usage_history must exist");
});

test("Connections CRUD - addConnection and getConnectionById", () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "glm",
    name: "Zai GLM Primary",
    auth_type: "apikey",
    credentials: { api_key: "glm_secret_123" },
    proxy_url: "http://127.0.0.1:7890",
  });

  assert.ok(conn.id, "Inserted connection must have an id");
  assert.strictEqual(conn.provider, "glm");
  assert.strictEqual(conn.name, "Zai GLM Primary");
  assert.strictEqual(conn.auth_type, "apikey");
  assert.deepStrictEqual(conn.credentials, { api_key: "glm_secret_123" });
  assert.strictEqual(conn.proxy_url, "http://127.0.0.1:7890");
  assert.strictEqual(conn.is_active, 1);

  const fetched = getConnectionById(conn.id);
  assert.strictEqual(fetched.id, conn.id);
  assert.strictEqual(fetched.name, "Zai GLM Primary");
  assert.deepStrictEqual(fetched.credentials, { api_key: "glm_secret_123" });
});

test("Connections CRUD - getConnections filters by provider", () => {
  initDb(":memory:");

  addConnection({
    provider: "glm",
    name: "GLM Key 1",
    credentials: { api_key: "k1" },
  });
  addConnection({
    provider: "glm",
    name: "GLM Key 2",
    credentials: { api_key: "k2" },
  });
  addConnection({
    provider: "claude",
    name: "Claude OAuth",
    auth_type: "oauth",
    credentials: { access_token: "tok1", refresh_token: "ref1" },
  });

  const all = getConnections();
  assert.strictEqual(all.length, 3);

  const glmOnly = getConnections("glm");
  assert.strictEqual(glmOnly.length, 2);
  assert.ok(glmOnly.every((c) => c.provider === "glm"));

  const claudeOnly = getConnections("claude");
  assert.strictEqual(claudeOnly.length, 1);
  assert.strictEqual(claudeOnly[0].auth_type, "oauth");
});

test("Connections CRUD - updateConnection and deleteConnection", () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "codex",
    name: "Codex OAuth",
    auth_type: "oauth",
    credentials: { access_token: "old_tok" },
  });

  const updated = updateConnection(conn.id, {
    name: "Codex OAuth Renewed",
    credentials: { access_token: "new_tok" },
  });

  assert.strictEqual(updated.name, "Codex OAuth Renewed");
  assert.strictEqual(updated.credentials.access_token, "new_tok");

  const success = deleteConnection(conn.id);
  assert.strictEqual(success, true);

  const deleted = getConnectionById(conn.id);
  assert.strictEqual(deleted, null);
});

test("Connections Cooldown - setConnectionCooldown marks cooldown timestamp", () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "github",
    name: "Copilot Work",
    credentials: { api_key: "gh_test" },
  });

  const cooldownTime = Date.now() + 60000;
  setConnectionCooldown(conn.id, cooldownTime);

  const fetched = getConnectionById(conn.id);
  assert.strictEqual(fetched.cooldown_until, cooldownTime);
});

test("Database - migrates a pre-api_key_id usage_history table on startup", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "zenith-migrate-"));
  const dbPath = join(dir, "old.db");
  t.after(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  // Schema shipped before gateway API keys existed.
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE usage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL
  )`);
  old.prepare("INSERT INTO usage_history (model, total_tokens, timestamp) VALUES (?, ?, ?)").run("old-model", 42, Date.now());
  old.close();

  const db = initDb(dbPath);
  const columns = db.prepare("PRAGMA table_info(usage_history)").all().map((c) => c.name);
  assert.ok(columns.includes("api_key_id"), "api_key_id column is added");
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(indexes.includes("idx_usage_api_key"));
  assert.strictEqual(db.prepare("SELECT total_tokens FROM usage_history").get().total_tokens, 42, "existing rows kept");
  assert.strictEqual(getDb(), db);
});
