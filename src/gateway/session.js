// Client conversation identity for upstreams that keep per-session state
// (OpenCode Zen). Client headers are never forwarded upstream; this
// value only keys a local cache. Auth headers are deliberately not used.

const MAX_SESSION_KEY_LENGTH = 256;

const SESSION_HEADERS = [
  "x-opencode-session",
  "x-session-id",
  "x-claude-code-session-id",
  "session_id",
  "session-id",
  "x-conversation-id",
  "conversation_id",
];

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_SESSION_KEY_LENGTH) : null;
}

/**
 * Picks the most specific identity the client offers and reports where it came
 * from: an explicit session header, then the conversation markers agents put in
 * the body (Claude Code metadata.user_id, Codex prompt_cache_key, OpenAI `user`),
 * then the gateway API key. `source` is "header", "body" or "apikey"; `key` is
 * null when the request carries none of them.
 */
export function clientSession({ header, body, apiKeyId } = {}) {
  if (typeof header === "function") {
    for (const name of SESSION_HEADERS) {
      const value = clean(header(name));
      if (value) return { key: value, source: "header" };
    }
  }
  const bodyMarker = clean(body?.metadata?.user_id) || clean(body?.prompt_cache_key) || clean(body?.user);
  if (bodyMarker) {
    const fromPrompt = !clean(body?.metadata?.user_id) && clean(body?.prompt_cache_key);
    return { key: bodyMarker, source: "body", promptCacheKey: Boolean(fromPrompt) };
  }
  if (apiKeyId !== undefined && apiKeyId !== null && apiKeyId !== "") {
    return { key: `apikey:${apiKeyId}`, source: "apikey" };
  }
  return { key: null, source: null };
}

/** String form for executors that only need the key. */
export function clientSessionKey(options = {}) {
  return clientSession(options).key;
}
