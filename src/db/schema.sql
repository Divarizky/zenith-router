-- zenroute SQLite database schema

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
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_connection ON usage_history (connection_id, timestamp);

-- Gateway API keys: only the SHA-256 hash is stored; the plaintext key is shown once on creation.
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
