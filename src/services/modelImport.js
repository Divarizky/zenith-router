import { getDb, getConnections } from "../db/index.js";
import { getProvider } from "../providers/index.js";
import { getExecutor } from "../executors/base.js";
import { applyConnectionAuth } from "./auth.js";

const IMPORT_TIMEOUT_MS = 20000;

// OpenCode free models that don't use the "-free" suffix (9router suggested-models/filters.js).
const KNOWN_FREE_OPENCODE = new Set(["big-pickle"]);
// GLM free-tier models from OmniRoute's free model catalog.
const FREE_GLM = new Set(["glm-4.7-flash", "glm-4.5-flash"]);

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

/**
 * Providers whose live model list can be imported.
 * `modes` lists the import choices the dashboard offers; `public` means the
 * list endpoint works without an account.
 */
const IMPORTERS = {
  opencode: {
    url: "https://opencode.ai/zen/v1/models",
    public: true,
    // Paid Zen models in the same list need an API key; only free ones work without an account.
    modes: ["free"],
    headers: { "x-opencode-client": "desktop" },
    parse: (json) =>
      listOf(json).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        isFree: m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE.has(m.id),
      })),
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
};

export function getImporter(providerId) {
  return IMPORTERS[providerId] || null;
}

/**
 * Fetch the provider's model list and replace its imported rows.
 * Returns `{ code, count }`; codes: imported, unsupported, no_account, upstream_error, empty.
 */
export async function importProviderModels(providerId, mode = "all") {
  const provider = getProvider(providerId);
  const importer = provider && IMPORTERS[provider.id];
  if (!importer || !importer.modes.includes(mode)) return { code: "unsupported", count: 0 };

  const connection = getConnections(provider.id).find((c) => c.is_active === 1) || null;
  if (!connection && !importer.public && !provider.noAuth) return { code: "no_account", count: 0 };

  const headers = {
    Accept: "application/json",
    ...(importer.useTransportHeaders ? provider.transport?.headers : {}),
    ...importer.headers,
    ...(connection?.auth_type === "oauth" ? importer.oauthHeaders : {}),
  };
  delete headers["Content-Type"];
  applyConnectionAuth(headers, connection);

  let models;
  try {
    const res = await getExecutor(provider.id).execute({
      url: importer.url,
      method: "GET",
      headers,
      timeoutMs: IMPORT_TIMEOUT_MS,
      proxyUrl: connection?.proxy_url || null,
    });
    if (!res.ok) return { code: "upstream_error", count: 0, status: res.status };
    models = importer.parse(await res.json()).filter((m) => typeof m.id === "string" && m.id);
  } catch {
    return { code: "upstream_error", count: 0 };
  }

  if (mode === "free") models = models.filter((m) => m.isFree);
  if (models.length === 0) return { code: "empty", count: 0 };

  // Built-in registry models stay as they are; only extra ids are stored.
  const builtIn = new Set(provider.models.map((m) => m.id));
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
