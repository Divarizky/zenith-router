/**
 * Token paste normaliser for browser-session providers.
 *
 * `localStorage.userToken` on chat.deepseek.com is a JSON string, not the token
 * itself: {"value":"eyJ...","__version":"0"}. People also paste the whole
 * `Bearer ...` header or a quoted value, and any of those reaches the upstream
 * as a broken Authorization header and comes back as a bare 401 that looks like
 * an expired session. Cleaning it here keeps both the gateway headers and the
 * transport working from whatever shape was pasted.
 */
// The SPA stores placeholders before a session exists; none of them is a token.
const PLACEHOLDERS = new Set(["", "null", "undefined", "false", "true", "0", "none", "[object object]"]);

export function normalizeSessionToken(raw) {
  if (typeof raw !== "string") return "";
  let token = raw.trim();
  if (!token) return "";
  token = token.replace(/^Bearer\s+/i, "").trim();
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) token = token.slice(1, -1).trim();
  }
  if (token.startsWith("{")) {
    try {
      const parsed = JSON.parse(token);
      const value = parsed?.value ?? parsed?.token ?? parsed?.userToken ?? parsed?.user_token;
      if (typeof value === "string" && value.trim()) token = value.trim();
    } catch {
      // Not the wrapper shape; a raw JWT never starts with "{", so leave it be.
    }
  }
  return PLACEHOLDERS.has(token.toLowerCase()) ? "" : token;
}
