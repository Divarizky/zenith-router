import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
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
  getModelLockUntil,
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
  for (const col of ["cache_read_tokens", "cache_write_tokens", "reasoning_tokens"]) {
    assert.ok(columns.includes(col), `${col} column is added`);
  }
  assert.strictEqual(db.prepare("SELECT cache_read_tokens FROM usage_history").get().cache_read_tokens, 0, "old rows default to zero cache");
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(indexes.includes("idx_usage_api_key"));
  assert.strictEqual(db.prepare("SELECT total_tokens FROM usage_history").get().total_tokens, 42, "existing rows kept");
  assert.strictEqual(getDb(), db);
});

// Two shapes of pre-upgrade database must come out right: one that predates
// per-model locks entirely, and one that carried them in the short-lived
// connections.cooldown_model column.
test("Migration - upgrades databases from both pre-lock designs", () => {
  const tmp = join(tmpdir(), `zenith-migrate-${process.pid}-${Math.floor(process.uptime() * 1000)}.db`);
  try {
    const legacy = new DatabaseSync(tmp);
    legacy.exec(`
      CREATE TABLE connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        name TEXT,
        auth_type TEXT NOT NULL DEFAULT 'api_key',
        credentials TEXT NOT NULL DEFAULT '{}',
        proxy_url TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_used_at INTEGER DEFAULT 0,
        cooldown_until INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE combos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        strategy TEXT NOT NULL DEFAULT 'fallback',
        models TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      INSERT INTO connections (provider, name, credentials, created_at)
        VALUES ('mistral', 'Lama', '{"api_key":"k"}', 1);
      ALTER TABLE connections ADD COLUMN cooldown_model TEXT;
      INSERT INTO connections (provider, name, credentials, cooldown_until, cooldown_model, created_at)
        VALUES ('glm', 'Terbatas', '{"api_key":"g"}', ${Date.now() + 60000}, 'glm-4-flash', 2);
      INSERT INTO combos (name, models, created_at) VALUES ('lama', '["mistral/mistral-large-latest"]', 1);
    `);
    legacy.close();

    initDb(tmp);

    const cols = getDb().prepare("PRAGMA table_info(connections)").all().map((c) => c.name);
    assert.ok(!cols.includes("cooldown_model"), "kolom lock model lama harus dibuang");

    const comboCols = getDb().prepare("PRAGMA table_info(combos)").all().map((c) => c.name);
    assert.ok(comboCols.includes("enabled") && comboCols.includes("updated_at"));

    // Data lama utuh. Lock model pindah ke tabel per-pasangan dan tidak ikut
    // melebar jadi lock akun; lock akun yang asli tetap berlaku.
    assert.strictEqual(getConnectionById(1).name, "Lama");
    assert.strictEqual(getConnectionById(2).cooldown_until, 0, "lock model tidak boleh melebar jadi lock akun");
    const modelLock = getModelLockUntil(2, "glm-4-flash");
    assert.ok(modelLock > Date.now(), "lock model harus pindah ke tabel per-pasangan");
    assert.strictEqual(getModelLockUntil(2, "mistral-large-latest"), null);

    // Jalankan lagi: tidak boleh gagal maupun menggandakan lock.
    initDb(tmp);
    const carried = getDb().prepare("SELECT count(*) AS n FROM connection_model_locks").get().n;
    assert.strictEqual(carried, 1);
    assert.strictEqual(getConnections("mistral").length, 1);
  } finally {
    closeDb();
    try { rmSync(tmp, { force: true }); } catch {}
  }
});

test("Cooldown locks - neither kind of lock is ever shortened or widened", () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "mistral", name: "M", credentials: { api_key: "k" } });

  // Lock model yang aktif tidak boleh dipendekkan oleh deadline yang lebih singkat.
  const modelLong = Date.now() + 3600_000;
  setConnectionCooldown(conn.id, modelLong, "mistral-large-latest");
  setConnectionCooldown(conn.id, Date.now() + 60_000, "mistral-large-latest");
  assert.ok(
    getModelLockUntil(conn.id, "mistral-large-latest") >= modelLong - 100,
    "lock model tidak boleh dipendekkan"
  );

  // Lock akun yang aktif tidak boleh dipendekkan, dan lock model lain tidak
  // boleh menyempitkannya jadi lock satu model.
  const accountLong = Date.now() + 600_000;
  setConnectionCooldown(conn.id, accountLong);
  setConnectionCooldown(conn.id, Date.now() + 60_000, "mistral-small-latest");
  assert.ok(getConnectionById(conn.id).cooldown_until >= accountLong - 100, "lock akun harus bertahan");
  assert.ok(getModelLockUntil(conn.id, "mistral-small-latest") > Date.now());
  assert.strictEqual(
    getModelLockUntil(conn.id, "mistral-code-latest"),
    null,
    "model yang tidak kena error tidak ikut terkunci"
  );

  // Lock yang sudah lewat waktu tidak lagi menghalangi apa pun (dan deadline
  // lampau memang tidak bisa menghapus lock yang masih aktif — itu bagian dari
  // aturan tidak pernah dipendekkan).
  setConnectionCooldown(conn.id, Date.now() - 1000, "mistral-code-latest");
  assert.strictEqual(getModelLockUntil(conn.id, "mistral-code-latest"), null);
  assert.ok(getModelLockUntil(conn.id, "mistral-large-latest") > Date.now(), "lock aktif tetap utuh");
});

test("Antigravity inventory - replace per account, union across active accounts", async () => {
  const { replaceAntigravityAccountModels, getAntigravityModelInventory } = await import("../src/db/index.js");
  initDb(":memory:");
  const a = addConnection({ provider: "antigravity", name: "a", auth_type: "oauth", credentials: {} });
  const b = addConnection({ provider: "antigravity", name: "b", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Gemini 4 Argon (Medium)", recommended: true, quotaRemaining: 1 },
    { modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", recommended: true, quotaRemaining: 0.9 },
    { modelId: "old-model", displayName: "Old", recommended: false, quotaRemaining: 1 },
  ]);
  replaceAntigravityAccountModels(b.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Gemini 4 Argon (Medium)", recommended: true, quotaRemaining: 0 },
    { modelId: "claude-opus-5-5-low", displayName: "Claude Opus 5.5 (Low)", recommended: true, quotaRemaining: 1 },
  ]);
  // Sync ulang mengganti penuh: model yang hilang tidak tertinggal.
  replaceAntigravityAccountModels(a.id, "free-tier", [
    { modelId: "gemini-4-argon-medium", displayName: "Gemini 4 Argon (Medium)", recommended: true, quotaRemaining: 1 },
  ]);
  let inv = getAntigravityModelInventory();
  assert.ok(!inv.has("claude-sonnet-4-6"), "model yang hilang dari sync ikut hilang");
  assert.ok(!inv.has("old-model"), "non-recommended tidak masuk inventaris");
  assert.strictEqual(inv.get("gemini-4-argon-medium").accounts.length, 2);
  assert.strictEqual(inv.get("claude-opus-5-5-low").accounts[0].connection_id, b.id);
  // Akun nonaktif tidak ikut.
  updateConnection(b.id, { is_active: 0 });
  inv = getAntigravityModelInventory();
  assert.strictEqual(inv.get("gemini-4-argon-medium").accounts.length, 1);
});

test("replaceAntigravityAccountModels - quota_reset_at menerima ISO dan epoch ms, menolak nilai tak valid", async () => {
  const { initDb, addConnection } = await import("../src/db/index.js");
  const { replaceAntigravityAccountModels, getAntigravityAccountModels } = await import("../src/db/index.js");
  initDb(":memory:");
  const c = addConnection({ provider: "antigravity", name: "iso", auth_type: "oauth", credentials: {} });
  const ms = Date.now() + 3600_000;
  replaceAntigravityAccountModels(c.id, "free-tier", [
    { modelId: "iso", recommended: true, quotaRemaining: 0, quotaResetAt: new Date(ms).toISOString() },
    { modelId: "ms", recommended: true, quotaRemaining: 0, quotaResetAt: ms },
    { modelId: "junk", recommended: true, quotaRemaining: 0, quotaResetAt: "bukan-tanggal" },
    { modelId: "kosong", recommended: true, quotaRemaining: 0 },
  ]);
  const rows = getAntigravityAccountModels(c.id);
  assert.strictEqual(rows.get("iso").quota_reset_at, rows.get("ms").quota_reset_at);
  assert.strictEqual(rows.get("junk").quota_reset_at, null);
  assert.strictEqual(rows.get("kosong").quota_reset_at, null);
});
