import { oauthFetch } from "../oauth/providers.js";

/**
 * Fetch live quota for Google Antigravity (Gemini Code Assist)
 */
export async function fetchAntigravityQuota(connection) {
  const token = connection.credentials?.access_token;
  if (!token) return null;

  const projectId = connection.credentials?.project_id || "";
  const url = "https://cloudaicompanion.googleapis.com/v1internal:fetchAvailableModels";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "antigravity/ide/0.0.1 darwin/arm64",
  };

  const body = projectId ? JSON.stringify({ project: projectId }) : "{}";
  const res = await oauthFetch(url, { method: "POST", headers, body }, { proxyUrl: connection.proxy_url });
  if (!res.ok) {
    throw new Error(`Antigravity fetchAvailableModels returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const models = data.models || [];
  const defaultTier = data.allowedTiers?.find((t) => t.isDefault)?.id || "standard";

  return {
    provider: "antigravity",
    tier: defaultTier,
    available_models_count: models.length,
    project_id: projectId,
    is_exhausted: false,
    unit: "tier",
  };
}
