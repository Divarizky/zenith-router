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
 * Picks the most specific identity the client offers: an explicit session
 * header, then the conversation markers agents put in the body (Claude Code
 * metadata.user_id, Codex prompt_cache_key, OpenAI `user`), then the gateway
 * API key. Returns null when the request carries none of them.
 */
export function clientSessionKey({ header, body, apiKeyId } = {}) {
  if (typeof header === "function") {
    for (const name of SESSION_HEADERS) {
      const value = clean(header(name));
      if (value) return value;
    }
  }
  const fromBody =
    clean(body?.metadata?.user_id) || clean(body?.prompt_cache_key) || clean(body?.user);
  if (fromBody) return fromBody;
  if (apiKeyId !== undefined && apiKeyId !== null && apiKeyId !== "") return `apikey:${apiKeyId}`;
  return null;
}
