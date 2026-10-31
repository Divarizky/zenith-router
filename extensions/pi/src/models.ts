import fs from "node:fs";
import path from "node:path";

/** Dipakai hanya bila gateway mati dan belum pernah ada cache. Contoh id dari README gateway. */
export const FALLBACK_MODEL_IDS: readonly string[] = ["dsw/deepseek-chat"];

export type ModelSource = "live" | "cache" | "fallback";

export interface ModelSelection {
  readonly source: ModelSource;
  readonly ids: readonly string[];
}

export interface ModelCache {
  readonly savedAt: string;
  readonly ids: readonly string[];
}

/** Ambil id dari `{ data: [{ id }] }`. Mengembalikan null bila bentuknya tidak cocok. */
export function parseModelIds(payload: unknown): string[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const item of data) {
    const id = typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  return [...ids];
}

/** Urutan prioritas: live, lalu cache, lalu fallback. Daftar kosong dianggap tidak ada. */
export function selectModels(live: readonly string[] | null, cached: readonly string[]): ModelSelection {
  if (live && live.length > 0) return { source: "live", ids: live };
  if (cached.length > 0) return { source: "cache", ids: cached };
  return { source: "fallback", ids: FALLBACK_MODEL_IDS };
}

/** Cache rusak atau tidak terbaca diperlakukan sama dengan tidak ada cache. */
export function readModelCache(file: string): ModelCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ModelCache>;
    if (typeof parsed.savedAt !== "string" || !Array.isArray(parsed.ids)) return null;
    const ids = parsed.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    return { savedAt: parsed.savedAt, ids };
  } catch {
    return null;
  }
}

/** Menulis cache hanya bila ada id. Daftar kosong tidak boleh menimpa cache yang berisi. */
export function writeModelCache(file: string, ids: readonly string[], now: Date): boolean {
  if (ids.length === 0) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body: ModelCache = { savedAt: now.toISOString(), ids: [...ids] };
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

/** Gateway tidak mengirim metadata model di `/v1/models`, jadi nilai di sini konservatif. */
export function toProviderModel(id: string): ProviderModelDefinition {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}
