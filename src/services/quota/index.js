import { fetchCodexQuota } from "./codex.js";
import { fetchAntigravityQuota } from "./antigravity.js";
import { fetchGitHubQuota } from "./github.js";
import { fetchGlmQuota } from "./glm.js";
import { fetchOpenRouterQuota } from "./openrouter.js";

const QUOTA_FETCHERS = {
  codex: fetchCodexQuota,
  antigravity: fetchAntigravityQuota,
  github: fetchGitHubQuota,
  glm: fetchGlmQuota,
  openrouter: fetchOpenRouterQuota,
};

/**
 * Fetch live quota for any supported connection
 */
export async function fetchLiveQuota(connection) {
  if (!connection || !connection.provider) return null;
  const fetcher = QUOTA_FETCHERS[connection.provider];
  if (!fetcher) return null;
  return fetcher(connection);
}
