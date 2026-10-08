import { fetchCodexQuota } from "./codex.js";
import { fetchClaudeQuota } from "./claude.js";
import { fetchKiroQuota } from "./kiro.js";
import { fetchXkiroQuota } from "./xkiro.js";
import { fetchAntigravityQuota } from "./antigravity.js";
import { fetchGitHubQuota } from "./github.js";
import { fetchGlmQuota } from "./glm.js";
import { fetchOpenRouterQuota } from "./openrouter.js";

const QUOTA_FETCHERS = {
  codex: fetchCodexQuota,
  claude: fetchClaudeQuota,
  kiro: fetchKiroQuota,
  xkiro: fetchXkiroQuota,
  antigravity: fetchAntigravityQuota,
  github: fetchGitHubQuota,
  glm: fetchGlmQuota,
  openrouter: fetchOpenRouterQuota,
};

/**
 * Fetch live quota for any supported connection
 */
/** True when the provider has a live quota fetcher. */
export function hasQuotaFetcher(provider) {
  return Boolean(QUOTA_FETCHERS[provider]);
}

export async function fetchLiveQuota(connection) {
  if (!connection || !connection.provider) return null;
  const fetcher = QUOTA_FETCHERS[connection.provider];
  if (!fetcher) return null;
  return fetcher(connection);
}
