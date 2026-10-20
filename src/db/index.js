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
  if (process.env.ZENITH_DB_PATH) return process.env.ZENITH_DB_PATH;
  if (isTestRun()) return ":memory:";
  return join(PROJECT_ROOT, "data", "zenith.db");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'apikey',
  credentials TEXT NOT NULL DEFAULT '{}',
  proxy_url TEXT,
  proxy_pool_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER DEFAULT 0,
  cooldown_until INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connections_provider_active ON connections (provider, is_active);

-- Per-model rate-limit locks. A lock lives per (connection, model) pair so a 429
-- on one model cannot park or unpark another model on the same account, and an
-- account-wide credential lock on connections.cooldown_until cannot be narrowed
-- by a shorter model lock.
CREATE TABLE IF NOT EXISTS connection_model_locks (
  connection_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  locked_until INTEGER NOT NULL,
  PRIMARY KEY (connection_id, model)
);

CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'fallback',
  models TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Central proxy registry. One row = one proxy URL; connections point
-- back through proxy_pool_id (list beats the per-account proxy_url, which stays
-- as a lower-priority fallback and is never migrated).
CREATE TABLE IF NOT EXISTS proxy_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_test_at INTEGER,
  last_test_ok INTEGER,
  last_test_ms INTEGER,
  last_test_error TEXT,
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
  combo_name TEXT,
  fallback_from TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_connection ON usage_history (connection_id, timestamp);
-- Usage stats filter on a time window and the recent panel sorts by time.
CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_history (timestamp);

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
  capabilities TEXT,   -- JSON from the provider API, e.g. {"vision":true,"reasoning":false}
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model_id)
);

-- Antigravity account inventory: the Recommended agent model list and per-model
-- quota/attributes from fetchAvailableModels, one row per (account, model).
-- Rows are replaced on every sync, so a model that vanishes from the account
-- disappears instead of lingering.
CREATE TABLE IF NOT EXISTS antigravity_account_models (
  connection_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT,
  recommended INTEGER NOT NULL DEFAULT 0,
  quota_remaining REAL,
  quota_reset_at INTEGER,
  max_tokens INTEGER,
  max_output_tokens INTEGER,
  supports_images INTEGER,
  supports_thinking INTEGER,
  current_tier TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_ag_models_model ON antigravity_account_models (model_id);

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
  if (!usageColumns.some((col) => col.name === "provider")) {
    db.exec("ALTER TABLE usage_history ADD COLUMN provider TEXT");
  }
  if (!usageColumns.some((col) => col.name === "combo_name")) {
    db.exec("ALTER TABLE usage_history ADD COLUMN combo_name TEXT");
  }
  // Kolom terpisah, bukan menumpang combo_name: combo_name menyimpan combo yang
  // benar-benar menjawab, sedangkan baris ini menyimpan target yang diminta klien.
  if (!usageColumns.some((col) => col.name === "fallback_from")) {
    db.exec("ALTER TABLE usage_history ADD COLUMN fallback_from TEXT");
  }
  for (const col of ["cache_read_tokens", "cache_write_tokens", "reasoning_tokens"]) {
    if (!usageColumns.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE usage_history ADD COLUMN ${col} INTEGER DEFAULT 0`);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_history (api_key_id, timestamp)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_history (provider, timestamp)");

  const syncedColumns = db.prepare("PRAGMA table_info(synced_models)").all();
  if (syncedColumns.length && !syncedColumns.some((col) => col.name === "capabilities")) {
    db.exec("ALTER TABLE synced_models ADD COLUMN capabilities TEXT");
  }

  const comboColumns = db.prepare("PRAGMA table_info(combos)").all();
  if (comboColumns.length && !comboColumns.some((col) => col.name === "enabled")) {
    db.exec("ALTER TABLE combos ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  }
  if (comboColumns.length && !comboColumns.some((col) => col.name === "updated_at")) {
    db.exec("ALTER TABLE combos ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
  }

  // Move model-scoped locks written by the previous single-column design
  // (connections.cooldown_model) into the per-pair table, then drop the column.
  const connectionColumns = db.prepare("PRAGMA table_info(connections)").all();
  if (!connectionColumns.some((col) => col.name === "proxy_pool_id")) {
    db.exec("ALTER TABLE connections ADD COLUMN proxy_pool_id INTEGER");
  }
  // Accounts were picked by last use before priorities existed; numbering them in
  // creation order keeps the oldest account as #1 instead of a five-way tie at 0.
  if (!connectionColumns.some((col) => col.name === "priority")) {
    db.exec("ALTER TABLE connections ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE connections SET priority = (
        SELECT COUNT(*) FROM connections AS earlier
        WHERE earlier.provider = connections.provider AND earlier.id <= connections.id
      )
    `);
  }
  const proxyPoolColumns = db.prepare("PRAGMA table_info(proxy_pools)").all();
  if (proxyPoolColumns.length && !proxyPoolColumns.some((col) => col.name === "last_test_ms")) {
    db.exec("ALTER TABLE proxy_pools ADD COLUMN last_test_ms INTEGER");
  }
  if (connectionColumns.some((col) => col.name === "cooldown_model")) {
    const orphaned = db
      .prepare(`SELECT id, cooldown_until, cooldown_model FROM connections WHERE cooldown_model IS NOT NULL`)
      .all();
    const carry = db.prepare(
      `INSERT INTO connection_model_locks (connection_id, model, locked_until) VALUES (?, ?, ?)
       ON CONFLICT(connection_id, model) DO UPDATE SET locked_until = MAX(locked_until, excluded.locked_until)`
    );
    for (const row of orphaned) carry.run(row.id, row.cooldown_model, row.cooldown_until);
    // In that design cooldown_until held the model's lock, not an account lock;
    // carrying it over as-is would silently widen the lock to the whole account.
    db.exec(`UPDATE connections SET cooldown_until = 0 WHERE cooldown_model IS NOT NULL`);
    // Best effort: the column is unused after the move, and an old SQLite without
    // DROP COLUMN support simply keeps a harmless NULL column behind.
    try {
      db.exec("ALTER TABLE connections DROP COLUMN cooldown_model");
    } catch {}
  }
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
  proxy_pool_id = null,
  is_active = 1,
}) {
  const db = getDb();
  const now = Date.now();
  const credsJson = JSON.stringify(credentials || {});

  // A new account always joins at the bottom, so adding a spare never takes
  // traffic away from the account the user already ranked first.
  const stmt = db.prepare(`
    INSERT INTO connections (provider, name, auth_type, credentials, proxy_url, proxy_pool_id, is_active, priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(priority), 0) + 1 FROM connections WHERE provider = ?), ?)
  `);

  const info = stmt.run(
    provider,
    name,
    auth_type,
    credsJson,
    proxy_url,
    proxy_pool_id ?? null,
    is_active ? 1 : 0,
    provider,
    now
  );
  return getConnectionById(Number(info.lastInsertRowid));
}

/**
 * Get all connections, optionally filtered by provider.
 *
 * A provider's accounts come back in priority order (#1 first), which is the
 * order routing tries them in. The unfiltered list stays in id order because it
 * spans providers, where priorities are not comparable.
 */
export function getConnections(provider = null) {
  const db = getDb();
  let stmt;
  let rows;

  if (provider) {
    stmt = db.prepare(`SELECT * FROM connections WHERE provider = ? ORDER BY priority ASC, id ASC`);
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
  const proxy_pool_id = fields.proxy_pool_id !== undefined ? fields.proxy_pool_id ?? null : current.proxy_pool_id;
  const is_active = fields.is_active !== undefined ? (fields.is_active ? 1 : 0) : current.is_active;

  const stmt = db.prepare(`
    UPDATE connections
    SET name = ?, auth_type = ?, credentials = ?, proxy_url = ?, proxy_pool_id = ?, is_active = ?
    WHERE id = ?
  `);

  stmt.run(name, auth_type, credentials, proxy_url, proxy_pool_id, is_active, Number(id));
  return getConnectionById(id);
}

/**
 * Merge `patch` into the stored credentials and return the updated connection.
 *
 * Callers that awaited the network (token refresh, quota sync) must use this
 * instead of writing back their own snapshot: the read and the write happen in
 * one synchronous step, so a refresh token rotated meanwhile by another task is
 * kept rather than overwritten with a stale one.
 */
export function mergeConnectionCredentials(id, patch = {}) {
  const current = getConnectionById(id);
  if (!current) return null;
  const credentials = { ...(current.credentials || {}), ...patch };
  getDb()
    .prepare(`UPDATE connections SET credentials = ? WHERE id = ?`)
    .run(JSON.stringify(credentials), Number(id));
  return getConnectionById(id);
}

/**
 * Delete a connection
 */
export function deleteConnection(id) {
  const db = getDb();
  const key = Number(id);
  // Baris per koneksi ikut dibersihkan. Tanpa ini, inventaris yang ditinggalkan
  // tetap terbaca sebagai milik akun yang sudah tidak ada.
  const provider = getConnectionById(key)?.provider;
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM antigravity_account_models WHERE connection_id = ?`).run(key);
    db.prepare(`DELETE FROM connection_model_locks WHERE connection_id = ?`).run(key);
    const res = db.prepare(`DELETE FROM connections WHERE id = ?`).run(key);
    if (provider) renumberConnections(db, provider);
    db.exec("COMMIT");
    return res.changes > 0;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

/**
 * Rewrite a provider's priorities as 1..n in their current order. The caller
 * owns the transaction.
 */
function renumberConnections(db, provider, orderedIds = null) {
  const ids =
    orderedIds ||
    db
      .prepare(`SELECT id FROM connections WHERE provider = ? ORDER BY priority ASC, id ASC`)
      .all(provider)
      .map((row) => row.id);
  const update = db.prepare(`UPDATE connections SET priority = ? WHERE id = ?`);
  ids.forEach((id, index) => update.run(index + 1, id));
}

/**
 * Swap an account with its neighbour in its provider's priority order.
 * Returns false when the account is unknown or already at that end.
 */
export function moveConnection(id, direction) {
  const db = getDb();
  const current = getConnectionById(id);
  if (!current || (direction !== "up" && direction !== "down")) return false;

  db.exec("BEGIN");
  try {
    const ids = db
      .prepare(`SELECT id FROM connections WHERE provider = ? ORDER BY priority ASC, id ASC`)
      .all(current.provider)
      .map((row) => row.id);
    const from = ids.indexOf(current.id);
    const to = direction === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= ids.length) {
      db.exec("ROLLBACK");
      return false;
    }
    [ids[from], ids[to]] = [ids[to], ids[from]];
    renumberConnections(db, current.provider, ids);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

/**
 * Cool a connection down until a timestamp.
 *
 * Pass a model when the failure is about that model only (rate limit, upstream
 * 5xx): the lock is stored per (connection, model) pair, so other models on the
 * account stay usable — which is what a combo chain needs to reach its next
 * member. Pass nothing when the credential itself is broken (401/402/403 that did
 * not survive a refresh) and the whole account must stay parked.
 *
 * Neither kind of lock is ever shortened: a shorter deadline over an active lock
 * would unpark an account a previous failure had already ruled unusable.
 */
export function setConnectionCooldown(id, cooldownUntilTimestamp, model = null) {
  const db = getDb();
  if (model) {
    db.prepare(`DELETE FROM connection_model_locks WHERE connection_id = ? AND locked_until <= ?`).run(
      Number(id),
      Date.now()
    );
    db.prepare(
      `INSERT INTO connection_model_locks (connection_id, model, locked_until) VALUES (?, ?, ?)
       ON CONFLICT(connection_id, model) DO UPDATE SET locked_until = MAX(locked_until, excluded.locked_until)`
    ).run(Number(id), String(model), Number(cooldownUntilTimestamp));
    return true;
  }
  const now = Date.now();
  db.prepare(
    `UPDATE connections SET cooldown_until = CASE WHEN cooldown_until > ? THEN cooldown_until ELSE ? END WHERE id = ?`
  ).run(now, Number(cooldownUntilTimestamp), Number(id));
  return true;
}

/**
 * Active per-model lock deadline for a connection, or null when the model is
 * not locked (never locked, lock expired, or unknown pair).
 */
export function getModelLockUntil(connectionId, model) {
  if (!connectionId || !model) return null;
  const row = getDb()
    .prepare(
      `SELECT locked_until FROM connection_model_locks
       WHERE connection_id = ? AND model = ? AND locked_until > ?`
    )
    .get(Number(connectionId), String(model), Date.now());
  return row ? Number(row.locked_until) : null;
}

/**
 * Reset times arrive as ISO strings from parseResetTime and as epoch ms from
 * tests; the column is INTEGER, so both are normalized here.
 */
function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Whole-list replacement, so a model that vanished upstream stops routing.
 */
export function replaceAntigravityAccountModels(connectionId, currentTier, entries) {
  const db = getDb();
  const now = Date.now();
  const del = db.prepare("DELETE FROM antigravity_account_models WHERE connection_id = ?");
  const ins = db.prepare(`INSERT INTO antigravity_account_models
    (connection_id, model_id, display_name, recommended, quota_remaining, quota_reset_at,
     max_tokens, max_output_tokens, supports_images, supports_thinking, current_tier, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  try {
    del.run(Number(connectionId));
    for (const e of entries || []) {
      ins.run(
        Number(connectionId),
        String(e.modelId),
        e.displayName ?? null,
        e.recommended ? 1 : 0,
        typeof e.quotaRemaining === "number" ? e.quotaRemaining : null,
        toEpochMs(e.quotaResetAt),
        typeof e.maxTokens === "number" ? e.maxTokens : null,
        typeof e.maxOutputTokens === "number" ? e.maxOutputTokens : null,
        e.supportsImages === undefined ? null : e.supportsImages ? 1 : 0,
        e.supportsThinking === undefined ? null : e.supportsThinking ? 1 : 0,
        currentTier ?? null,
        now
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
  return (entries || []).length;
}

/**
 * Cross-account union of synced Antigravity models, with the accounts carrying each.
 */
export function getAntigravityModelInventory() {
  const rows = getDb()
    .prepare(
      `SELECT a.connection_id, a.model_id, a.display_name, a.quota_remaining, a.quota_reset_at,
              a.max_tokens, a.max_output_tokens, a.supports_images, a.supports_thinking,
              a.current_tier, c.is_active
       FROM antigravity_account_models a
       JOIN connections c ON c.id = a.connection_id
       WHERE a.recommended = 1 AND c.provider = 'antigravity'`
    )
    .all();
  const inventory = new Map();
  for (const r of rows) {
    if (!inventory.has(r.model_id)) inventory.set(r.model_id, { displayName: r.display_name, accounts: [] });
    inventory.get(r.model_id).accounts.push(r);
  }
  for (const entry of inventory.values()) {
    entry.accounts = entry.accounts.filter((a) => a.is_active === 1);
  }
  return inventory;
}

/** Every synced Antigravity model row, used to rebuild the family catalog. */
export function getAntigravityInventoryRows() {
  return getDb()
    .prepare(
      `SELECT a.connection_id, a.model_id, a.display_name, a.supports_images, a.supports_thinking,
              a.max_tokens, a.max_output_tokens, c.is_active
       FROM antigravity_account_models a
       JOIN connections c ON c.id = a.connection_id
       WHERE c.provider = 'antigravity' AND c.is_active = 1`
    )
    .all();
}

/**
 * Per-account model ids for routing: every model the account can see, not just
 * the Recommended ones, because catalog aliases resolve to upstream ids
 * (e.g. gemini-3.8-flash -> gemini-3.8-flash-tiered).
 */
export function getAntigravityModelsByConnection() {
  const rows = getDb()
    .prepare(
      `SELECT a.connection_id, a.model_id, a.display_name, a.recommended, a.current_tier,
              a.quota_remaining, a.quota_reset_at
       FROM antigravity_account_models a
       JOIN connections c ON c.id = a.connection_id
       WHERE c.provider = 'antigravity' AND c.is_active = 1`
    )
    .all();
  const byConnection = new Map();
  for (const r of rows) {
    if (!byConnection.has(r.connection_id)) byConnection.set(r.connection_id, new Map());
    byConnection.get(r.connection_id).set(r.model_id, r);
  }
  return byConnection;
}

/**
 * Synced Antigravity models of one account, keyed by runtime model id.
 */
export function getAntigravityAccountModels(connectionId) {
  const rows = getDb()
    .prepare(
      `SELECT model_id, display_name, quota_remaining, quota_reset_at
       FROM antigravity_account_models WHERE connection_id = ?`
    )
    .all(connectionId);
  return new Map(rows.map((r) => [r.model_id, r]));
}

/**
 * Stamp last used timestamp on a connection
 */
export function updateConnectionLastUsed(id) {
  const db = getDb();
  const stmt = db.prepare(`UPDATE connections SET last_used_at = ? WHERE id = ?`);
  stmt.run(Date.now(), Number(id));
}

/**
 * Proxy pool registry
 */
export function addProxyPool({ name, url, is_active = 1 }) {
  const db = getDb();
  const info = db
    .prepare(
      "INSERT INTO proxy_pools (name, url, is_active, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(String(name), String(url), is_active ? 1 : 0, Date.now());
  return getProxyPoolById(Number(info.lastInsertRowid));
}

export function getProxyPools() {
  return getDb().prepare("SELECT * FROM proxy_pools ORDER BY id ASC").all();
}

export function getProxyPoolById(id) {
  return getDb().prepare("SELECT * FROM proxy_pools WHERE id = ?").get(Number(id)) || null;
}

/** How many accounts route through a pool (displayed on the Proxy tab). */
export function countProxyAccounts(poolId) {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM connections WHERE proxy_pool_id = ?")
    .get(Number(poolId));
  return Number(row?.n || 0);
}

/** Partial update of a proxy pool row (name, url, flags, last test result). */
export function updateProxyPool(id, fields) {
  const current = getProxyPoolById(id);
  if (!current) return null;
  const value = (key) => (fields[key] !== undefined ? fields[key] : current[key]);
  getDb()
    .prepare(
      `UPDATE proxy_pools
       SET name = ?, url = ?, is_active = ?, last_test_at = ?, last_test_ok = ?, last_test_ms = ?, last_test_error = ?
       WHERE id = ?`
    )
    .run(
      value("name"),
      value("url"),
      value("is_active"),
      value("last_test_at"),
      value("last_test_ok"),
      value("last_test_ms"),
      value("last_test_error"),
      Number(id)
    );
  return getProxyPoolById(id);
}

/** Remove a pool row. Callers must check account usage first. */
export function removeProxyPool(id) {
  getDb().prepare("DELETE FROM proxy_pools WHERE id = ?").run(Number(id));
}
