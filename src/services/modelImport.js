import { getDb, getConnections } from "../db/index.js";
import { getProvider, getProviderModels } from "../providers/index.js";
import { getExecutor, BaseExecutor } from "../executors/base.js";
import { applyConnectionAuth } from "./auth.js";
import { MODEL_ACCESS_DENIED_403 } from "../providers/params.js";
import { requireResolvedProxy } from "./proxyPools.js";
import { capabilitiesFromApi } from "../providers/capabilities.js";
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

const ACCESS_CHECK_CONCURRENCY = 5;

/**
 * Mistral checks the rate limit before validating the body, so a request with
 * no messages costs no tokens: a usable model answers 400, a model outside the
 * tier answers 429 with a 0/minute limit or 403 tier_not_allowed/labs_not_enabled. Those are
 * marked not free. Any other answer (network error, 5xx) keeps the model.
 */
async function mistralAccessCheck(models, { executor, headers, proxyUrl }) {
  const refused = async (model) => {
    try {
      const res = await executor.execute({
        url: "https://api.mistral.ai/v1/chat/completions",
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.id, messages: [] }),
        timeoutMs: IMPORT_TIMEOUT_MS,
        proxyUrl,
      });
      const text = await res.text();
      if (res.status === 429) {
        return (
          res.headers.get("x-ratelimit-limit-req-minute") === "0" ||
          res.headers.get("x-ratelimit-limit-tokens-minute") === "0"
        );
      }
      return res.status === 403 && MODEL_ACCESS_DENIED_403.test(text);
    } catch {
      return false;
    }
  };

  const out = [...models];
  for (let i = 0; i < out.length; i += ACCESS_CHECK_CONCURRENCY) {
    const batch = out.slice(i, i + ACCESS_CHECK_CONCURRENCY);
    const results = await Promise.all(batch.map(refused));
    results.forEach((no, j) => {
      if (no) out[i + j] = { ...out[i + j], isFree: false };
    });
  }
  return out;
}

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
  llm7: {
    url: "https://api.llm7.io/v1/models",
    modes: ["all"],
    parse: (json) => listOf(json).map((m) => ({ id: m.id, name: m.name || m.id, isFree: false })),
  },
  mistral: {
    url: "https://api.mistral.ai/v1/models",
    // No manual import: sync already lists every chat model this account can use.
    modes: [],
    // /v1/models returns no pricing fields and lists models the account's tier
    // can't call. Only routable chat models are kept (no embeddings/OCR), and
    // deprecated models are skipped; checkAccess then drops the ones the tier refuses.
    // capabilities.reasoning / .vision ride along and are stored with the synced
    // row, so the router never has to guess these from the model name.
    parse: (json) =>
      listOf(json)
        .filter((m) => m.capabilities?.completion_chat === true && !m.deprecation)
        .map((m) => ({ id: m.id, name: m.name || m.id, isFree: true, capabilities: capabilitiesFromApi(m) })),
    checkAccess: mistralAccessCheck,
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
  return IMPORTERS[providerId] || null;
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
 * Returns `{ ok: true, models }` or `{ ok: false, code, status? }` with code
 * unsupported, no_account, or upstream_error.
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
    let models = importer.parse(await res.json()).filter((m) => typeof m.id === "string" && m.id);
    if (importer.checkAccess) {
      const executor = getExecutor(provider.id);
      models = await importer.checkAccess(models, { executor, headers, proxyUrl: requireResolvedProxy(connection) });
    }
    return { ok: true, models };
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
