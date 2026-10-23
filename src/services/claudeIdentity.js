// Single source for the Claude Code client identity. The upstream keys the
// OAuth scope, the beta flags and the account tier on this client shape, so
// the login flow and the runtime request must agree on it.
export const CLAUDE_CLI_VERSION = "2.1.280";

// The CLI identifies itself the same way in every request it makes, so the
// login, the bootstrap lookup and the runtime call share one string.
export function claudeUserAgent() {
  return `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
}

// A session id travels in an HTTP header, so control characters and an
// unbounded length would either break the request or let a client push
// arbitrary content into the upstream headers.
const MAX_SESSION_ID_LENGTH = 200;

// Control characters cannot appear in a header value; everything else the
// client sends is passed on as it is.
function stripControlCharacters(value) {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

function normalizeClaudeSessionId(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripControlCharacters(value.replace(/^claude:/i, "")).trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_SESSION_ID_LENGTH);
}

/**
 * Read a Claude Code session id out of the client's `metadata.user_id`.
 * The value is either a JSON blob with a `session_id` field or the session id
 * itself, optionally prefixed with "claude:". Returns null when it holds no
 * usable id.
 */
export function extractClaudeSessionId(userId) {
  if (typeof userId !== "string" || !userId.trim()) return null;
  const raw = userId.trim();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      return normalizeClaudeSessionId(parsed?.session_id);
    } catch {
      return null;
    }
  }
  return normalizeClaudeSessionId(raw);
}
