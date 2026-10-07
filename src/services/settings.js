import { getDb } from "../db/index.js";

/**
 * Get a setting value from SQLite
 */
export function getSetting(key, defaultValue = "") {
  try {
    const db = getDb();
    const stmt = db.prepare(`SELECT value FROM settings WHERE key = ? LIMIT 1`);
    const row = stmt.get(String(key));
    return row ? String(row.value) : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Set a setting value in SQLite
 */
export function setSetting(key, value) {
  try {
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run(String(key), String(value), now);
    return String(value);
  } catch (err) {
    console.error(`[zenroute] Failed to set setting '${key}':`, err.message);
    return null;
  }
}

const DEFAULT_SETTINGS = {
  require_api_key: "false",
  token_saver_rtk: "true",
  token_saver_caveman: "false",
  default_fallback_model: "glm/glm-4-flash",
};

/**
 * Get all settings as key-value dictionary
 */
export function getAllSettings() {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    const result = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
