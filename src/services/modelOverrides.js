import { getDb } from "../db/index.js";

/**
 * Custom models + disabled models repository.
 * Custom models ride along in the route table; disabled entries are filtered out.
 */
export function addCustomModel({ provider, model_id, name = null }) {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO custom_models (provider, model_id, name, created_at) VALUES (?, ?, ?, ?)`
  ).run(provider, model_id, name, Date.now());
  return listCustomModels().find((m) => m.provider === provider && m.model_id === model_id) || null;
}

export function listCustomModels() {
  const db = getDb();
  return db.prepare(`SELECT * FROM custom_models ORDER BY provider, model_id`).all();
}

export function deleteCustomModel(id) {
  const db = getDb();
  db.prepare(`DELETE FROM custom_models WHERE id = ?`).run(id);
}

export function disableModel(provider, model_id) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO disabled_models (provider, model_id) VALUES (?, ?)`).run(provider, model_id);
}

export function enableModel(provider, model_id) {
  const db = getDb();
  db.prepare(`DELETE FROM disabled_models WHERE provider = ? AND model_id = ?`).run(provider, model_id);
}

export function getDisabledModels() {
  const db = getDb();
  const rows = db.prepare(`SELECT provider, model_id FROM disabled_models`).all();
  const map = {};
  for (const row of rows) {
    if (!map[row.provider]) map[row.provider] = [];
    map[row.provider].push(row.model_id);
  }
  return map;
}

const PROVIDER_ALIASES = {
  claude: ["cc"],
  codex: ["cx"],
  github: ["gh"],
  kiro: ["kr"],
  antigravity: ["ag"],
  glm: ["glm"],
  opencode: ["oc"],
  kilocode: ["kc"],
};

export function isModelDisabled(provider, model_id) {
  const map = getDisabledModels();
  const aliases = [provider, ...(PROVIDER_ALIASES[provider] || [])];
  return aliases.some((alias) => (map[alias] || []).includes(model_id));
}
