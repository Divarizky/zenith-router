import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let dbInstance = null;

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// node --test sets NODE_TEST_CONTEXT in every test process; without this check,
// tests that never call initDb(":memory:") would write into the real database.
function isTestRun() {
  return process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
}

function defaultDbPath() {
  if (process.env.ZENROUTE_DB_PATH) return process.env.ZENROUTE_DB_PATH;
  if (isTestRun()) return ":memory:";
  return join(PROJECT_ROOT, "data", "zenroute.db");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'apikey',
  credentials TEXT NOT NULL DEFAULT '{}',
  proxy_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER DEFAULT 0,
  cooldown_until INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connections_provider_active ON connections (provider, is_active);

CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'fallback',
  models TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER,
  api_key_id INTEGER,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_connection ON usage_history (connection_id, timestamp);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER DEFAULT 0
);

-- Custom models added by the operator; merged into the model route table.
CREATE TABLE IF NOT EXISTS custom_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, model_id)
);

-- Per-provider model disable list; filtered from /v1/models and routing.
CREATE TABLE IF NOT EXISTS disabled_models (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);

-- Models imported from a provider's live model list; each import replaces the provider's rows.
CREATE TABLE IF NOT EXISTS imported_models (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT,
  is_free INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model_id)
);

-- Free models synced automatically for providers with freeModelSync; each successful sync replaces the provider's rows.
CREATE TABLE IF NOT EXISTS synced_models (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model_id)
);

-- Last free model sync attempt per provider, shown on the provider page.
CREATE TABLE IF NOT EXISTS model_sync_state (
  provider TEXT PRIMARY KEY,
  last_attempt_at INTEGER NOT NULL,
  last_success_at INTEGER,
  ok INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
`;

/**
 * Initialize SQLite database and create schema
 */
export function initDb(dbPath = null) {
  const effectivePath = dbPath || defaultDbPath();

  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {}
    dbInstance = null;
  }

  if (effectivePath !== ":memory:") {
    const dir = dirname(effectivePath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
  }

  const db = new DatabaseSync(effectivePath);

  if (effectivePath !== ":memory:") {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
    } catch {}
  }

  try {
    db.exec(SCHEMA_SQL);
    migrateSchema(db);
  } catch (err) {
    db.close();
    throw err;
  }
  // Only publish the handle once the schema is complete, so a failed init is retried
  // instead of leaving a half-migrated database behind.
  dbInstance = db;
  return dbInstance;
}

/**
 * Bring databases created by older versions up to the current schema.
 * Indexes on added columns live here, not in SCHEMA_SQL: CREATE TABLE IF NOT EXISTS
 * skips existing tables, so an index on a new column would fail before the column exists.
 */
function migrateSchema(db) {
  const usageColumns = db.prepare("PRAGMA table_info(usage_history)").all();
  if (!usageColumns.some((col) => col.name === "api_key_id")) {
    db.exec("ALTER TABLE usage_history ADD COLUMN api_key_id INTEGER");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_history (api_key_id, timestamp)");
}

/**
 * Get active database instance
 */
export function getDb() {
  if (!dbInstance) {
    dbInstance = initDb();
  }
  return dbInstance;
}

/**
 * Close database instance
 */
export function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {}
    dbInstance = null;
  }
}

/**
 * Helper to deserialize JSON fields from a connection row
 */
function deserializeConnection(row) {
  if (!row) return null;
  let credentials = {};
  try {
    credentials = JSON.parse(row.credentials || "{}");
  } catch {}
  return {
    ...row,
    credentials,
  };
}

/**
 * Add a new connection
 */
export function addConnection({
  provider,
  name,
  auth_type = "apikey",
  credentials = {},
  proxy_url = null,
  is_active = 1,
}) {
  const db = getDb();
  const now = Date.now();
  const credsJson = JSON.stringify(credentials || {});

  const stmt = db.prepare(`
    INSERT INTO connections (provider, name, auth_type, credentials, proxy_url, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(provider, name, auth_type, credsJson, proxy_url, is_active ? 1 : 0, now);
  return getConnectionById(Number(info.lastInsertRowid));
}

/**
 * Get all connections, optionally filtered by provider
 */
export function getConnections(provider = null) {
  const db = getDb();
  let stmt;
  let rows;

  if (provider) {
    stmt = db.prepare(`SELECT * FROM connections WHERE provider = ? ORDER BY id ASC`);
    rows = stmt.all(provider);
  } else {
    stmt = db.prepare(`SELECT * FROM connections ORDER BY id ASC`);
    rows = stmt.all();
  }

  return rows.map(deserializeConnection);
}

/**
 * Get a connection by its ID
 */
export function getConnectionById(id) {
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM connections WHERE id = ? LIMIT 1`);
  const row = stmt.get(Number(id));
  return deserializeConnection(row);
}

/**
 * Update connection fields
 */
export function updateConnection(id, fields = {}) {
  const db = getDb();
  const current = getConnectionById(id);
  if (!current) return null;

  const name = fields.name !== undefined ? fields.name : current.name;
  const auth_type = fields.auth_type !== undefined ? fields.auth_type : current.auth_type;
  const credentials = fields.credentials !== undefined
    ? JSON.stringify(fields.credentials)
    : JSON.stringify(current.credentials);
  const proxy_url = fields.proxy_url !== undefined ? fields.proxy_url : current.proxy_url;
  const is_active = fields.is_active !== undefined ? (fields.is_active ? 1 : 0) : current.is_active;

  const stmt = db.prepare(`
    UPDATE connections
    SET name = ?, auth_type = ?, credentials = ?, proxy_url = ?, is_active = ?
    WHERE id = ?
  `);

  stmt.run(name, auth_type, credentials, proxy_url, is_active, Number(id));
  return getConnectionById(id);
}

/**
 * Delete a connection
 */
export function deleteConnection(id) {
  const db = getDb();
  const stmt = db.prepare(`DELETE FROM connections WHERE id = ?`);
  const res = stmt.run(Number(id));
  return res.changes > 0;
}

/**
 * Set temporary rate-limit cooldown for a connection
 */
export function setConnectionCooldown(id, cooldownUntilTimestamp) {
  const db = getDb();
  const stmt = db.prepare(`UPDATE connections SET cooldown_until = ? WHERE id = ?`);
  stmt.run(Number(cooldownUntilTimestamp), Number(id));
  return true;
}

/**
 * Stamp last used timestamp on a connection
 */
export function updateConnectionLastUsed(id) {
  const db = getDb();
  const stmt = db.prepare(`UPDATE connections SET last_used_at = ? WHERE id = ?`);
  stmt.run(Date.now(), Number(id));
}
