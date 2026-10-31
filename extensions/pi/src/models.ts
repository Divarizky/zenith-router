import fs from "node:fs";
import path from "node:path";

/** Dipakai hanya bila gateway mati dan belum pernah ada cache. Contoh id dari README gateway. */
export const FALLBACK_MODEL_IDS: readonly string[] = ["dsw/deepseek-chat"];

export type ModelSource = "live" | "cache" | "fallback";

export interface ModelSelection {
  readonly source: ModelSource;
  readonly ids: readonly string[];
}

/**
 * Metadata opsional per model dari `/v1/models`. Setiap field hanya terisi bila
 * gateway mengirim nilai yang valid; field yang kosong memakai default konservatif.
 */
export interface ModelInfo {
  readonly id: string;
  readonly reasoning?: boolean;
  readonly vision?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface ModelCache {
  readonly savedAt: string;
  readonly ids: readonly string[];
  /** Kosong pada cache lama yang hanya berisi `ids`. */
  readonly models: readonly ModelInfo[];
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Baca satu entri `{ id, capabilities, context_length, max_completion_tokens }`. */
function parseModelInfo(item: unknown): ModelInfo | null {
  if (typeof item !== "object" || item === null) return null;
  const entry = item as { id?: unknown; capabilities?: unknown; context_length?: unknown; max_completion_tokens?: unknown };
  if (typeof entry.id !== "string" || !entry.id.trim()) return null;
  const caps = typeof entry.capabilities === "object" && entry.capabilities !== null
    ? (entry.capabilities as { reasoning?: unknown; vision?: unknown })
    : {};
  return {
    id: entry.id.trim(),
    ...(typeof caps.reasoning === "boolean" ? { reasoning: caps.reasoning } : {}),
    ...(typeof caps.vision === "boolean" ? { vision: caps.vision } : {}),
    ...(positiveNumber(entry.context_length) !== undefined ? { contextWindow: positiveNumber(entry.context_length) } : {}),
    ...(positiveNumber(entry.max_completion_tokens) !== undefined ? { maxTokens: positiveNumber(entry.max_completion_tokens) } : {}),
  };
}

/** Ambil model dari `{ data: [...] }` beserta metadatanya. Id unik, yang pertama menang. Null bila bentuk tidak cocok. */
export function parseModelInfos(payload: unknown): ModelInfo[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const infos = new Map<string, ModelInfo>();
  for (const item of data) {
    const info = parseModelInfo(item);
    if (info && !infos.has(info.id)) infos.set(info.id, info);
  }
  return [...infos.values()];
}

/** Ambil id dari `{ data: [{ id }] }`. Mengembalikan null bila bentuknya tidak cocok. */
export function parseModelIds(payload: unknown): string[] | null {
  return parseModelInfos(payload)?.map((info) => info.id) ?? null;
}

/** Urutan prioritas: live, lalu cache, lalu fallback. Daftar kosong dianggap tidak ada. */
export function selectModels(live: readonly string[] | null, cached: readonly string[]): ModelSelection {
  if (live && live.length > 0) return { source: "live", ids: live };
  if (cached.length > 0) return { source: "cache", ids: cached };
  return { source: "fallback", ids: FALLBACK_MODEL_IDS };
}

/** Baca entri cache yang memakai bentuk internal `ModelInfo` (bukan bentuk wire gateway). */
function parseCachedModelInfo(item: unknown): ModelInfo | null {
  if (typeof item !== "object" || item === null) return null;
  const entry = item as Partial<Record<keyof ModelInfo, unknown>>;
  if (typeof entry.id !== "string" || !entry.id) return null;
  return {
    id: entry.id,
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.vision === "boolean" ? { vision: entry.vision } : {}),
    ...(positiveNumber(entry.contextWindow) !== undefined ? { contextWindow: positiveNumber(entry.contextWindow) } : {}),
    ...(positiveNumber(entry.maxTokens) !== undefined ? { maxTokens: positiveNumber(entry.maxTokens) } : {}),
  };
}

/**
 * Cache rusak atau tidak terbaca diperlakukan sama dengan tidak ada cache.
 * Cache lama yang hanya berisi `ids` tetap dibaca, dengan `models` kosong.
 */
export function readModelCache(file: string): ModelCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<{ savedAt: unknown; ids: unknown; models: unknown }>;
    if (typeof parsed.savedAt !== "string" || !Array.isArray(parsed.ids)) return null;
    const ids = parsed.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    const models = Array.isArray(parsed.models)
      ? parsed.models.map(parseCachedModelInfo).filter((info): info is ModelInfo => info !== null)
      : [];
    return { savedAt: parsed.savedAt, ids, models };
  } catch {
    return null;
  }
}

/** Menulis cache hanya bila ada id. Daftar kosong tidak boleh menimpa cache yang berisi. */
export function writeModelCache(
  file: string,
  ids: readonly string[],
  now: Date,
  models: readonly ModelInfo[] = [],
): boolean {
  if (ids.length === 0) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body: ModelCache = { savedAt: now.toISOString(), ids: [...ids], models: [...models] };
    fs.writeFileSync(file, `${JSON.stringify(body)}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface ProviderModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/**
 * Model tanpa metadata memakai default konservatif: tanpa reasoning, tanpa gambar.
 * Reasoning bernilai true hanya bila gateway menyatakannya lewat `capabilities.reasoning`,
 * karena Pi tidak mengirim atau menampilkan thinking untuk model dengan `reasoning: false`.
 */
export function toProviderModel(id: string, info?: ModelInfo): ProviderModelDefinition {
  return {
    id,
    name: id,
    reasoning: info?.reasoning ?? false,
    input: info?.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info?.contextWindow ?? 128_000,
    maxTokens: info?.maxTokens ?? 8_192,
  };
}
