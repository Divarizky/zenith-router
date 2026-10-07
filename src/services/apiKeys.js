import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";

export const API_KEY_PREFIX = "zr_";
const DISPLAY_PREFIX_LENGTH = 10;

/**
 * Hash a gateway API key for storage and lookup.
 * Keys carry 256 bits of randomness, so a fast hash is enough here;
 * slow password hashing (scrypt/argon2) only matters for low-entropy secrets.
 */
export function hashApiKey(key) {
  return createHash("sha256").update(String(key)).digest("hex");
}

/**
 * Create a gateway API key. The plaintext key is returned only once and never stored.
 */
export function createApiKey(name) {
  const label = String(name || "").trim();
  if (!label) {
    throw new Error("API key name is required");
  }

  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  const keyPrefix = key.slice(0, DISPLAY_PREFIX_LENGTH);
  const now = Date.now();

  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO api_keys (name, key_prefix, key_hash, is_active, created_at)
       VALUES (?, ?, ?, 1, ?)`
    )
    .run(label, keyPrefix, hashApiKey(key), now);

  return {
    id: Number(info.lastInsertRowid),
    name: label,
    key,
    key_prefix: keyPrefix,
    is_active: 1,
    created_at: now,
  };
}

/**
 * List gateway API keys without their hashes
 */
export function listApiKeys() {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, name, key_prefix, is_active, created_at, last_used_at
       FROM api_keys ORDER BY id ASC`
    )
    .all()
    .map((row) => ({ ...row }));
}

/**
 * Count active gateway API keys
 */
export function countActiveApiKeys() {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE is_active = 1`).get();
  return Number(row?.n || 0);
}

/**
 * Enable or disable a gateway API key
 */
export function setApiKeyActive(id, isActive) {
  const db = getDb();
  const res = db
    .prepare(`UPDATE api_keys SET is_active = ? WHERE id = ?`)
    .run(isActive ? 1 : 0, Number(id));
  return res.changes > 0;
}

/**
 * Delete a gateway API key
 */
export function deleteApiKey(id) {
  const db = getDb();
  const res = db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(Number(id));
  return res.changes > 0;
}

/**
 * Verify a presented key. Returns { id, name } for an active key, otherwise null.
 */
export function verifyApiKey(key) {
  if (!key || typeof key !== "string" || !key.startsWith(API_KEY_PREFIX)) {
    return null;
  }

  const db = getDb();
  const row = db
    .prepare(`SELECT id, name, is_active FROM api_keys WHERE key_hash = ? LIMIT 1`)
    .get(hashApiKey(key));

  if (!row || row.is_active !== 1) return null;

  db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(Date.now(), row.id);
  return { id: row.id, name: row.name };
}

/**
 * Read the client-presented gateway key from Authorization (Bearer) or x-api-key
 */
export function extractClientApiKey(headers) {
  const auth = headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xApiKey = headers.get("x-api-key");
  return xApiKey ? xApiKey.trim() : null;
}
