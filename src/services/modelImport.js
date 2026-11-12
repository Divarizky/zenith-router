import { getDb, getConnections } from "../db/index.js";
import { getProvider, getProviderModels } from "../providers/index.js";
import { getExecutor, BaseExecutor } from "../executors/base.js";
import { applyConnectionAuth } from "./auth.js";
import { requireResolvedProxy } from "./proxyPools.js";
import { parseOpencodeCatalogFreeModels } from "./opencodeDiscovery.js";
import { OPENCODE_CATALOG_URL } from "./opencodeCatalog.js";

const IMPORT_TIMEOUT_MS = 20000;

// GLM free-tier models from OmniRoute's free model catalog.
const FREE_GLM = new Set(["glm-4.7-flash", "glm-4.5-flash"]);

// Ollama Cloud models a free-plan key can actually call. Verified 27-10-2026
// with GET /v1/models plus a real chat completion per id: everything else listed
// there answers 402 "not included in your free usage", 410 for retired ids, or
// 403 while a model is still rolling out. Re-check when upstream changes the
// plan: a model that starts answering 402 must be dropped here, otherwise sync
// keeps advertising it as free and combos fail at the upstream.
const FREE_OLLAMA = new Set([
  "beam",
  "gemma4:31b",
  "gemma4:31b-cloud",
  "gpt-oss:20b",
  "gpt-oss:120b",
  "nemotron-3-nano:30b",
  "nemotron-3-super",
  "nemotron-3-ultra",
]);

function listOf(json) {
  const raw = json?.data ?? json?.models ?? json;
  return Array.isArray(raw) ? raw : [];
}

/** OmniRoute payload evidence: an explicit boolean wins, then ":free" suffix, then zero prices. */
function payloadSaysFree(m) {
  for (const v of [m.isFree, m.is_free, m.free, m.pricing?.isFree]) {
    if (typeof v === "boolean") return v;
  }
  if (String(m.id).endsWith(":free")) return true;
  const p = m.pricing;
  return Boolean(p) && Number(p.prompt) === 0 && Number(p.completion) === 0;
}

function cleanClineDisplayName(rawName, id) {
  let name = rawName || id || "";
  for (const prefix of ["cline-free/", "cline-pass/", "cline-cloud/"]) {
    if (name.startsWith(prefix)) {
      const stripped = name.slice(prefix.length);
      const tag = prefix === "cline-pass/" ? " (ClinePass)" : prefix === "cline-cloud/" ? " (ClineCloud)" : "";
      const formatted = stripped
        .split("-")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
        .join(" ")
        .replace(/\bVl\b/i, "VL")
        .trim() || stripped;
      return `${formatted}${tag}`;
    }
  }
  return name;
}

/**
 * Providers whose live model list can be imported.
 * `modes` lists the import choices the dashboard offers; `public` means the
 * list endpoint works without an account.
 */
const IMPORTERS = {
  cline: {
    url: "https://api.cline.bot/api/v1/ai/cline/recommended-models",
    public: true,
    // The feed publishes `recommended`, `free`, `clinePass`, and `clineCloud`.
    // All sections are merged so users can access the full catalog.
    modes: ["all", "free"],
    parse: (json) => {
      const free = Array.isArray(json?.free) ? json.free : [];
      const freeIds = new Set(free.map((m) => m.id));
      const pool = [
        ...(Array.isArray(json?.recommended) ? json.recommended : []),
        ...free,
        ...(Array.isArray(json?.clinePass) ? json.clinePass : []),
        ...(Array.isArray(json?.clineCloud) ? json.clineCloud : []),
      ];
      const byId = new Map();
      for (const m of pool) {
        if (m && typeof m.id === "string" && m.id && !byId.has(m.id)) {
          byId.set(m.id, m);
        }
      }
      return Array.from(byId.values()).map((m) => ({
        id: m.id,
        name: cleanClineDisplayName(m.name, m.id),
        isFree: freeIds.has(m.id) || String(m.id).startsWith("cline-free/"),
      }));
    },
  },
  opencode: {
    // The authoritative catalog, not the inference gateway's own model list:
    // it marks retired models and prices every entry, so `isFree` is decided by
    // cost instead of by name suffix. Parsing also installs the endpoint
    // snapshot (services/opencodeCatalog.js).
    url: OPENCODE_CATALOG_URL,
    public: true,
    // Paid Zen models in the same payload need an API key; only free ones work
    // without an account.
    modes: ["free"],
    headers: { "x-opencode-client": "cli" },
    parse: parseOpencodeCatalogFreeModels,
  },
  kilocode: {
    url: "https://api.kilo.ai/api/openrouter/models",
    public: true,
    modes: ["all", "free"],
    parse: (json) => listOf(json).map((m) => ({ id: m.id, name: m.name || m.id, isFree: payloadSaysFree(m) })),
  },
  glm: {
    url: "https://api.z.ai/api/coding/paas/v4/models",
    modes: ["all", "free"],
    parse: (json) => listOf(json).map((m) => ({ id: m.id, name: m.name || m.id, isFree: FREE_GLM.has(m.id) })),
  },
  github: {
    url: "https://api.githubcopilot.com/models",
    modes: ["all"],
    useTransportHeaders: true,
    // Keep chat models the account can pick, like the Copilot model picker.
    parse: (json) =>
      listOf(json)
        .filter(
          (m) =>
            (m.capabilities?.type ?? "chat") === "chat" &&
            m.model_picker_enabled !== false &&
            m.policy?.state !== "disabled"
        )
        .map((m) => ({ id: m.id, name: m.name || m.id, isFree: false })),
  },
  claude: {
    url: "https://api.anthropic.com/v1/models?limit=1000",
    modes: ["all"],
    headers: { "anthropic-version": "2023-06-01" },
    oauthHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    parse: (json) =>
      listOf(json)
        .filter((m) => /^claude-/.test(m.id))
        .map((m) => ({ id: m.id, name: m.display_name || m.id, isFree: false })),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    public: true,
    modes: ["all", "free"],
    parse: (json) => listOf(json).map((m) => ({ id: m.id, name: m.name || m.id, isFree: payloadSaysFree(m) })),
  },
  together: {
    url: "https://api.together.xyz/v1/models",
    modes: ["all"],
    parse: (json) => listOf(json).map((m) => ({ id: m.id, name: m.display_name || m.id, isFree: false })),
  },
  "kilo-free": {
    url: "https://api.kilo.ai/api/gateway/models",
    public: true,
    modes: ["all"],
    parse: (json) => listOf(json).map((m) => ({ id: m.id, name: m.name || m.id, isFree: payloadSaysFree(m) })),
  },
  llm7: {
    url: "https://api.llm7.io/v1/models",
    public: true,
    modes: ["all"],
    headers: { Authorization: "Bearer unused" },
    parse: (json) => {
      const list = listOf(json);
      const turboModels = list
        .filter((m) => m.tier === "turbo" || payloadSaysFree(m))
        .map((m) => ({ id: m.id, name: m.name || m.id, isFree: true }));
      // default dan fast adalah alias gratis bawaan di endpoint chat
      const builtins = [
        { id: "default", name: "LLM7 Default", isFree: true },
        { id: "fast", name: "LLM7 Fast", isFree: true },
      ];
      return [...builtins, ...turboModels];
    },
    // The chat endpoint rejects retired ids with `model_unavailable`, and those
    // ids are absent from this list, so the raw payload decides what is gone.
    // The aliases above are callable without being listed (see registry
    // builtinAliases), hence they never appear here.
    liveIds: (json) => listOf(json).map((m) => m.id).filter((id) => typeof id === "string" && id),
  },
  ollama: {
    url: "https://ollama.com/v1/models",
    public: true,
    modes: ["all", "free"],
    // The public list carries no pricing fields, so it cannot say which models a
    // free key may call; FREE_OLLAMA decides that instead.
    parse: (json) =>
      listOf(json).map((m) => {
        const id = m.id || m.name;
        return {
          id,
          name: m.name || m.id,
          isFree: payloadSaysFree(m) || FREE_OLLAMA.has(id),
        };
      }),
  },
  ovhcloud: {
    url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models",
    public: true,
    // Free access is account-level credit, not a per-model free tier, so there
    // is nothing honest to sync as "free"; import offers the full chat list.
    modes: ["all"],
    parse: (json) =>
      listOf(json)
        // OVH returns embeddings, TTS, ASR, image and safety-guard models too;
        // only routable chat models expose a positive completion/context budget.
        .filter((m) => {
          if (/guard/i.test(m.id)) return false;
          // If a provider returns context/completion budgets, require a positive chat budget.
          // Older fixture payloads without those fields remain importable.
          const hasBudget = m.context_length !== undefined || m.max_completion_tokens !== undefined;
          return !hasBudget || (Number(m.context_length) > 0 && Number(m.max_completion_tokens) > 0);
        })
        .map((m) => ({ id: m.id, name: m.name || m.id, isFree: payloadSaysFree(m) })),
  },
  nvidia: {
    url: "https://integrate.api.nvidia.com/v1/models",
    modes: ["all"],
    parse: (json) => listOf(json).map((m) => ({ id: m.id, name: m.name || m.id, isFree: payloadSaysFree(m) })),
  },
  xkiro: {
    url: "https://api.xkiro.com/v1/models",
    public: true,
    modes: ["all", "free"],
    parse: (json) =>
      listOf(json).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        isFree: payloadSaysFree(m) || m.access_tier === "free" || String(m.id).endsWith(":free"),
      })),
  },
  commandcode: {
    url: "https://api.commandcode.ai/provider/v1/models",
    public: true,
    modes: ["all", "free"],
    // CommandCodeExecutor menerjemahkan semua request ke format /alpha/generate
    // dan menolak tanpa Authorization, jadi GET daftar model memakai transport
    // HTTP biasa lewat BaseExecutor.
    rawTransport: true,
    parse: (json) =>
      listOf(json)
        // Model Claude hanya melayani /messages di Provider API; endpoint CLI
        // /alpha/generate yang dipakai Zenith belum terbukti menerimanya.
        .filter((m) => {
          const eps = m.supported_endpoints;
          return !Array.isArray(eps) || eps.some((e) => e !== "/messages");
        })
        .map((m) => ({
          id: m.id,
          name: m.name || m.id,
          isFree: /:free$|-free$/.test(String(m.id)),
        })),
  },
};

export function getImporter(providerId) {
  if (!providerId) return null;
  if (IMPORTERS[providerId]) return IMPORTERS[providerId];

  // Dynamic importer untuk custom provider
  const provider = typeof providerId === "object" ? providerId : getProvider(providerId);
  if (provider && provider.isCustom) {
    let baseUrl = provider.transport?.baseUrl || "";
    try {
      const parsed = new URL(baseUrl);
      if (parsed.pathname.endsWith("/chat/completions")) {
        parsed.pathname = parsed.pathname.replace(/\/chat\/completions$/, "/models");
      } else if (parsed.pathname.endsWith("/messages")) {
        parsed.pathname = parsed.pathname.replace(/\/messages$/, "/models");
      } else if (!parsed.pathname.endsWith("/models")) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/models";
      }
      baseUrl = parsed.toString();
    } catch {
      baseUrl = baseUrl.replace(/\/(chat\/completions|messages)$/, "/models");
    }

    return {
      url: baseUrl,
      public: false,
      useTransportHeaders: true,
      modes: ["all"],
      parse: (json) => listOf(json).map((m) => ({ id: m.id, name: m.name || m.id, isFree: false })),
    };
  }

  return null;
}

/**
 * Import choices offered for a provider. Free-only import is dropped when the
 * provider already syncs its free models automatically (freeModelSync).
 */
export function getImportModes(provider) {
  const importer = provider && IMPORTERS[provider.id];
  if (!importer) return [];
  return importer.modes.filter((mode) => !(mode === "free" && provider.freeModelSync));
}

/**
 * Fetch and parse a provider's live model list, using its first active account
 * (credentials and proxy) when there is one.
 * Returns `{ ok: true, models, liveIds }` or `{ ok: false, code, status? }` with code
 * unsupported, no_account, or upstream_error. `liveIds` is every id the payload
 * carried, used by the catalog refresh to spot retired built-ins. It defaults to
 * the parsed list, so an importer that filters ids out (free-only, chat-only) must
 * declare its own hook or its filtered ids would look retired.
 */
export async function fetchProviderModels(provider) {
  const importer = provider && IMPORTERS[provider.id];
  if (!importer) return { ok: false, code: "unsupported" };

  const connection = getConnections(provider.id).find((c) => c.is_active === 1) || null;
  if (!connection && !importer.public && !provider.noAuth) return { ok: false, code: "no_account" };

  const headers = {
    Accept: "application/json",
    ...(importer.useTransportHeaders ? provider.transport?.headers : {}),
    ...importer.headers,
    ...(connection?.auth_type === "oauth" ? importer.oauthHeaders : {}),
  };
  delete headers["Content-Type"];
  applyConnectionAuth(headers, connection);

  try {
    // rawTransport: executor khusus provider (mis. CommandCodeExecutor)
    // menulis ulang request ke format endpoint chat-nya, jadi daftar model
    // diambil lewat transport HTTP biasa.
    const listExecutor = importer.rawTransport ? new BaseExecutor() : getExecutor(provider.id);
    const res = await listExecutor.execute({
      url: importer.url,
      method: "GET",
      headers,
      timeoutMs: IMPORT_TIMEOUT_MS,
      proxyUrl: requireResolvedProxy(connection),
    });
    if (!res.ok) return { ok: false, code: "upstream_error", status: res.status };
    const payload = await res.json();
    let models = importer.parse(payload).filter((m) => typeof m.id === "string" && m.id);
    if (importer.checkAccess) {
      const executor = getExecutor(provider.id);
      models = await importer.checkAccess(models, { executor, headers, proxyUrl: requireResolvedProxy(connection) });
    }
    const liveIds = importer.liveIds
      ? importer.liveIds(payload).filter((id) => typeof id === "string" && id)
      : models.map((m) => m.id);
    return { ok: true, models, liveIds };
  } catch {
    return { ok: false, code: "upstream_error" };
  }
}

/**
 * Fetch the provider's model list and replace its imported rows.
 * Returns `{ code, count }`; codes: imported, unsupported, no_account, upstream_error, empty.
 */
export async function importProviderModels(providerId, mode = "all") {
  const provider = getProvider(providerId);
  if (!provider || !getImportModes(provider).includes(mode)) return { code: "unsupported", count: 0 };

  const fetched = await fetchProviderModels(provider);
  if (!fetched.ok) {
    return fetched.status ? { code: fetched.code, count: 0, status: fetched.status } : { code: fetched.code, count: 0 };
  }

  let models = fetched.models;
  if (mode === "free") models = models.filter((m) => m.isFree);
  if (models.length === 0) return { code: "empty", count: 0 };

  // Built-in (static or synced) models stay as they are; only extra ids are stored.
  const builtIn = new Set(getProviderModels(provider).map((m) => m.id));
  const rows = models.filter((m) => !builtIn.has(m.id));

  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO imported_models (provider, model_id, name, is_free, imported_at) VALUES (?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM imported_models WHERE provider = ?").run(provider.id);
    for (const m of rows) insert.run(provider.id, m.id, m.name || null, m.isFree ? 1 : 0, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { code: "imported", count: rows.length };
}
