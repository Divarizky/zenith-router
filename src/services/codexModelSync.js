import { getDb } from "../db/index.js";
import { BaseExecutor } from "../executors/base.js";
import { getProvider } from "../providers/index.js";
import { applyConnectionAuth } from "./auth.js";
import { requireResolvedProxy } from "./proxyPools.js";

/** Discover models for the newly connected ChatGPT account. Never remove models
 * from another account's catalog or replace the builtin fallback on failure. */
export async function syncCodexModels(connection) {
  if (connection?.provider !== "codex" || !connection.credentials?.access_token) return;
  const provider = getProvider("codex");
  const headers = { ...provider.transport.headers, Accept: "application/json" };
  applyConnectionAuth(headers, connection);
  const accountId = connection.credentials.account_id || connection.credentials.accountId;
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(provider.transport.cliVersion)}`;
  const response = await new BaseExecutor().execute({
    url, method: "GET", headers, timeoutMs: 20000, proxyUrl: requireResolvedProxy(connection),
  });
  if (!response.ok) return;
  const payload = await response.json();
  if (!Array.isArray(payload?.models)) return;
  const models = payload.models.filter((m) => typeof m?.slug === "string" && m.slug.trim() && m.visibility !== "hide");
  if (!models.length) return;

  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO synced_models (provider, model_id, name, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider, model_id) DO UPDATE SET name = excluded.name, synced_at = excluded.synced_at"
  );
  db.exec("BEGIN");
  try {
    for (const m of models) insert.run("codex", m.slug, m.display_name || m.slug, Date.now());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
