import { getDb } from "../db/index.js";
import { getProvider, resolveModel } from "../providers/index.js";

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Bare names the gateway would otherwise guess to a provider by prefix
 * (see resolveModel). A combo with one of those names would silently reroute
 * every existing client request, so creating one is refused.
 */
const RESERVED_PREFIXES = ["claude-", "gpt-", "o1", "o3", "gemini-", "glm-", "codegeex"];

const STRATEGIES = ["fallback", "round-robin"];

function parseRow(row) {
  if (!row) return null;
  let models = [];
  try {
    const parsed = JSON.parse(row.models);
    if (Array.isArray(parsed)) models = parsed.filter((m) => typeof m === "string");
  } catch {
    models = [];
  }
  return {
    id: row.id,
    name: row.name,
    strategy: row.strategy,
    models,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCombos() {
  return getDb()
    .prepare(`SELECT * FROM combos ORDER BY name`)
    .all()
    .map(parseRow);
}

export function getComboByName(name) {
  if (!name || typeof name !== "string") return null;
  return parseRow(getDb().prepare(`SELECT * FROM combos WHERE name = ?`).get(name));
}

/** The combo a request may be routed to, or null when it does not exist or is off. */
export function getActiveComboByName(name) {
  const combo = getComboByName(name);
  return combo && combo.enabled ? combo : null;
}

/**
 * Turn user input into the canonical `provider/model` form every member must be
 * stored in, so a combo never depends on an alias staying registered.
 *
 * A separator is required and its prefix must be a known provider: falling back
 * to the model-name guess would silently file `gpt-oss:20b` under codex when the
 * writer meant ollama.
 */
export function canonicalizeMember(raw) {
  const value = String(raw || "").trim();
  if (!value) return { error: "anggota kosong" };

  const slashIdx = value.indexOf("/");
  const colonIdx = value.indexOf(":");
  if (slashIdx === -1 && colonIdx === -1) {
    const nested = getComboByName(value);
    if (nested) return { error: `"${value}" adalah combo di dalam combo, belum didukung` };
    return { error: `tulis anggota "${value}" sebagai provider/model, misalnya "mistral/mistral-large-latest"` };
  }

  const sepIdx = slashIdx === -1 ? colonIdx : slashIdx;
  const prefix = value.slice(0, sepIdx);
  const targetModel = value.slice(sepIdx + 1);
  if (!getProvider(prefix)) {
    return { error: `provider "${prefix}" tidak dikenal; tulis anggota sebagai provider/model` };
  }
  // A blank or whitespace-riddled model would sail through resolution and die at
  // the upstream as a 400, stopping the chain on a typo instead of a real error.
  if (!targetModel || /\s/.test(targetModel)) {
    return { error: `nama model pada anggota "${value}" tidak boleh kosong atau mengandung spasi` };
  }

  const resolved = resolveModel(value);
  if (!resolved?.provider) return { error: `anggota "${value}" tidak bisa dipetakan ke provider mana pun` };
  return { member: `${resolved.provider.id}/${resolved.targetModel}` };
}

function validateName(name) {
  if (!NAME_PATTERN.test(String(name || ""))) {
    return "nama combo hanya boleh huruf, angka, titik, garis, dan garis bawah, maksimal 64 karakter";
  }
  const lowered = String(name).toLowerCase();
  if (RESERVED_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return `nama "${name}" berawalan nama model yang dipetakan otomatis ke provider`;
  }
  return null;
}

export function validateComboInput({ name, models, strategy = "fallback", allowSameName = false }) {
  const nameError = validateName(name);
  if (nameError) return { error: nameError };

  // Only meaningful on update: there, the combo being edited already owns the name.
  if (getComboByName(name) && !allowSameName) return { error: `nama "${name}" sudah dipakai combo lain` };

  if (!STRATEGIES.includes(strategy)) return { error: `strategi "${strategy}" tidak dikenal` };

  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) return { error: "combo harus punya minimal satu model" };

  const members = [];
  for (const raw of list) {
    const { member, error } = canonicalizeMember(raw);
    if (error) return { error };
    if (!members.includes(member)) members.push(member);
  }

  return { name, strategy, models: members };
}

export function createCombo({ name, models, strategy = "fallback" }) {
  const validated = validateComboInput({ name, models, strategy });
  if (validated.error) throw new Error(validated.error);

  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO combos (name, strategy, models, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    )
    .run(validated.name, validated.strategy, JSON.stringify(validated.models), now, now);

  return getComboByName(validated.name);
}

/**
 * Rewrite a combo in place. Validation runs before the write so a rejected
 * change leaves the previous chain exactly as it was.
 *
 * Members the caller sent are re-resolved; members already stored are not. A
 * provider that left the registry, or a model that got disabled, would otherwise
 * freeze every edit to the combo — including the strategy form, which does not
 * touch the chain at all.
 */
export function updateCombo(name, { models, strategy } = {}) {
  const current = getComboByName(name);
  if (!current) throw new Error(`combo "${name}" tidak ada`);

  const nextStrategy = strategy ?? current.strategy;
  if (!STRATEGIES.includes(nextStrategy)) {
    throw new Error(`strategi "${nextStrategy}" tidak dikenal`);
  }

  let nextModels = current.models;
  if (models !== undefined) {
    const validated = validateComboInput({
      name,
      models,
      strategy: nextStrategy,
      allowSameName: true,
    });
    if (validated.error) throw new Error(validated.error);
    nextModels = validated.models;
  }

  getDb()
    .prepare(`UPDATE combos SET strategy = ?, models = ?, updated_at = ? WHERE name = ?`)
    .run(nextStrategy, JSON.stringify(nextModels), Date.now(), name);

  return getComboByName(name);
}

/**
 * Swap a member with its neighbour. Out-of-range moves are no-ops rather than
 * errors: the buttons are rendered for every row, including the locked ends.
 */
export function moveComboMember(name, index, direction) {
  const current = getComboByName(name);
  if (!current) throw new Error(`combo "${name}" tidak ada`);
  if (direction !== "up" && direction !== "down") {
    throw new Error(`arah "${direction}" tidak dikenal`);
  }

  const target = direction === "up" ? index - 1 : index + 1;
  if (!Number.isInteger(index) || index < 0 || index >= current.models.length) return current;
  if (target < 0 || target >= current.models.length) return current;

  const models = [...current.models];
  [models[index], models[target]] = [models[target], models[index]];

  getDb()
    .prepare(`UPDATE combos SET models = ?, updated_at = ? WHERE name = ?`)
    .run(JSON.stringify(models), Date.now(), name);

  return getComboByName(name);
}

export function setComboEnabled(name, enabled) {
  const current = getComboByName(name);
  if (!current) throw new Error(`combo "${name}" tidak ada`);

  const value = enabled ? 1 : 0;
  getDb()
    .prepare(`UPDATE combos SET enabled = ?, updated_at = ? WHERE name = ?`)
    .run(value, Date.now(), name);

  return getComboByName(name);
}

/**
 * Give a combo a new name. The chain, strategy, and status stay untouched —
 * the name is only the routing key, so clients switch by calling the new one.
 * Renaming to its own name is a no-op, so saving the prefilled form unchanged
 * never errors.
 */
export function renameCombo(name, newName) {
  const current = getComboByName(name);
  if (!current) throw new Error(`combo "${name}" tidak ada`);
  if (name === newName) return current;

  const nameError = validateName(newName);
  if (nameError) throw new Error(nameError);
  if (getComboByName(newName)) throw new Error(`nama "${newName}" sudah dipakai combo lain`);

  getDb()
    .prepare(`UPDATE combos SET name = ?, updated_at = ? WHERE name = ?`)
    .run(newName, Date.now(), name);

  return getComboByName(newName);
}

export function deleteCombo(name) {
  const result = getDb().prepare(`DELETE FROM combos WHERE name = ?`).run(name);
  if (!result.changes) throw new Error(`combo "${name}" tidak ada`);
  return true;
}
