import { oauthFetch } from "../oauth/providers.js";

/**
 * Fetch live quota and subscription status for GitHub Copilot
 */
export async function fetchGitHubQuota(connection) {
  const token = connection.credentials?.github_token || connection.credentials?.access_token;
  if (!token) return null;

  const url = "https://api.github.com/copilot_internal/user";
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/json",
    "User-Agent": "GitHubCopilotChat/0.26.7",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const res = await oauthFetch(url, { headers }, { proxyUrl: connection.proxy_url });
  if (!res.ok) {
    throw new Error(`GitHub Copilot user API returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const plan = data.plan || (data.access_type ? `Copilot (${data.access_type})` : "Copilot");

  return {
    provider: "github",
    plan,
    login: data.login || data.user_id || "GitHub User",
    chat_enabled: data.chat_enabled !== false,
    is_exhausted: false,
    unit: "subscription",
  };
}
