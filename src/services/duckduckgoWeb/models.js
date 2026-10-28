/**
 * Wire ids for the Duck.ai free chat roster.
 *
 * duck.ai answers GET /duckchat/v1/models without a challenge token, so the live
 * list wins whenever it is reachable. The static entries below are only the
 * fallback for the first request after boot.
 */
export const DUCKDUCKGO_BASE = "https://duck.ai";
export const DUCKDUCKGO_MODELS_URL = `${DUCKDUCKGO_BASE}/duckchat/v1/models`;
export const DUCKDUCKGO_STATUS_URL = `${DUCKDUCKGO_BASE}/duckchat/v1/status`;
export const DUCKDUCKGO_CHAT_URL = `${DUCKDUCKGO_BASE}/duckchat/v1/chat`;
export const DUCKDUCKGO_AUTH_URL = `${DUCKDUCKGO_BASE}/duckchat/v1/auth/token`;

export const DUCKDUCKGO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Default x-fe-version. The homepage serves the current one; this keeps boot working. */
export const DUCKDUCKGO_DEFAULT_FE_VERSION =
  "serp_20260424_180649_ET-0bdc33b2a02ebf8f235def65d887787f694720a1";

/** Matches the build stamp the frontend embeds in its bundle URL. */
export const DUCKDUCKGO_FE_VERSION_PATTERN = /serp_\d{8}_\d{6}_ET-[0-9a-f]{40}/;

export const DUCKDUCKGO_STATIC_MODELS = [
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "mistral-small-2603", name: "Mistral Small 4" },
  { id: "tinfoil/gpt-oss-120b", name: "gpt-oss 120B" },
  { id: "tinfoil/gemma4-31b", name: "Gemma 4 31B" },
];

const MODEL_IDS_CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, ids: null, efforts: new Map() };

/** Live roster, cached briefly so a combo fan-out does not refetch per request. */
export async function fetchDuckDuckGoModelIds(fetchFn = globalThis.fetch, headers = {}) {
  if (cache.ids && Date.now() - cache.at < MODEL_IDS_CACHE_TTL_MS) return cache.ids;
  try {
    const res = await fetchFn(DUCKDUCKGO_MODELS_URL, { headers });
    if (!res.ok) return cache.ids;
    const json = await res.json();
    const models = (json?.models ?? []).filter((m) => typeof m?.id === "string");
    const ids = new Set(models.map((m) => m.id));
    if (ids.size > 0) {
      const efforts = new Map(
        models.map((m) => [m.id, Array.isArray(m.supportedReasoningEffort) ? m.supportedReasoningEffort : []])
      );
      cache = { at: Date.now(), ids, efforts };
      return ids;
    }
  } catch {
    // Upstream unreachable; the static list and the caller's requested id still apply.
  }
  return cache.ids;
}

/**
 * The roster rotates upstream without notice. When a caller asks for an id the
 * live list no longer serves, reroute to a same-family live id before burning a
 * doomed chat POST, which comes back as an opaque 400.
 */
export function pickLiveModel(requested, liveIds) {
  if (!liveIds || liveIds.size === 0) return requested;
  if (liveIds.has(requested)) return requested;
  const family = String(requested).split("-")[0];
  for (const id of liveIds) {
    if (id === family || id.startsWith(`${family}-`)) return id;
  }
  if (liveIds.has("gpt-5.4-mini")) return "gpt-5.4-mini";
  return [...liveIds][0];
}

/**
 * The chat POST answers 400 ERR_BAD_REQUEST when `reasoningEffort` is missing for a
 * model that has efforts, and again when the value is one that model does not list
 * (gpt-oss-120b has only "low"). Pick "none" where it exists, else the first listed
 * effort. A model that lists none takes no field at all. Before the roster has been
 * read, "none" is the value most of the roster accepts.
 */
export function pickReasoningEffort(modelId) {
  const efforts = cache.efforts.get(modelId);
  if (!efforts) return "none";
  if (efforts.length === 0) return undefined;
  return efforts.includes("none") ? "none" : efforts[0];
}
