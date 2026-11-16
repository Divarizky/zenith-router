import { createHash } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";

function extractAccountId(credentials) {
  if (!credentials) return null;
  if (credentials.account_id) return credentials.account_id;
  if (credentials.accountId) return credentials.accountId;

  // Try parsing JWT id_token payload
  const token = credentials.id_token || credentials.access_token;
  if (typeof token === "string" && token.includes(".")) {
    try {
      const parts = token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        const acc = payload["https://api.openai.com/auth"]?.account_id || payload.account_id;
        if (acc) return acc;
      }
    } catch {}
  }
  return null;
}

// The ChatGPT Codex backend rejects an output budget (upstream codex executor
// drops it for the same reason) and sampling params (codex_cli_rs never sends
// them). Since the /v1/responses passthrough forwards the raw body, a
// generic Responses client could introduce fields the backend refuses; these
// are stripped to keep the effective request identical to what the Codex CLI
// itself sends. store must be false on this backend; clients that omit it get
// the backend's required default rather than the OpenAI API default (true).
export function stripUnsupportedFields(body) {
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return body;
    for (const key of ["max_output_tokens", "temperature", "top_p", "top_k", "user"]) {
      if (key in parsed) delete parsed[key];
    }
    if (parsed.metadata && typeof parsed.metadata === "object") {
      delete parsed.metadata.user_id;
      if (Object.keys(parsed.metadata).length === 0) delete parsed.metadata;
    }
    if (parsed.store === undefined && Array.isArray(parsed.input)) {
      parsed.store = false;
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

// Session identity for the Codex backend's session affinity. Only ids the client
// chose qualify: a session header, or prompt_cache_key from the body. Other body
// markers (metadata.user_id, OpenAI `user`) and the gateway fallback
// `apikey:<id>` can merge unrelated conversations or carry personal data, so
// they are never forwarded.
const CODEX_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const FORWARDABLE_SESSION_SOURCES = new Set(["header"]);

export function codexSessionId(sessionKey, { source = null, promptCacheKey = false } = {}) {
  if (typeof sessionKey !== "string") return null;
  if (sessionKey.startsWith("apikey:")) return null;
  if (!CODEX_SESSION_ID_PATTERN.test(sessionKey)) return null;
  if (FORWARDABLE_SESSION_SOURCES.has(source)) return sessionKey;
  if (source === "body" && promptCacheKey) return sessionKey;
  return null;
}

// Derives a deterministic prompt_cache_key from available client identity,
// instructions, tools definition, and the first input item.
// Format: "zr-" + first 32 hex chars of SHA-256 (matches ^[A-Za-z0-9._-]{1,128}$).
export function derivePromptCacheKey({ clientIdentity = "", instructions = "", tools = null, firstInput = null } = {}) {
  const hash = createHash("sha256");
  if (clientIdentity) {
    hash.update(String(clientIdentity));
  }
  hash.update(":");
  if (typeof instructions === "string") {
    hash.update(instructions);
  }
  hash.update(":");
  if (tools) {
    hash.update(typeof tools === "string" ? tools : JSON.stringify(tools));
  }
  hash.update(":");
  if (firstInput !== null && firstInput !== undefined) {
    hash.update(typeof firstInput === "string" ? firstInput : JSON.stringify(firstInput));
  }
  const hex = hash.digest("hex").slice(0, 32);
  return `zr-${hex}`;
}

// Gives the request a stable prompt_cache_key when the client sent none, so the
// backend can key its prompt cache by conversation. A client-supplied key is
// left untouched. If no client key or session exists, derives a deterministic key.
export function withPromptCacheKey(body, sessionId, { clientIdentity = null } = {}) {
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return body;
    if (parsed.prompt_cache_key !== undefined) return body;
    if (sessionId) {
      parsed.prompt_cache_key = sessionId;
      return JSON.stringify(parsed);
    }
    const firstInput = Array.isArray(parsed.input) ? parsed.input[0] : (parsed.input ?? null);
    parsed.prompt_cache_key = derivePromptCacheKey({
      clientIdentity,
      instructions: parsed.instructions,
      tools: parsed.tools,
      firstInput,
    });
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

export class CodexExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, stream = false, targetModel, sessionKey = null, sessionSource = null, sessionPromptCacheKey = false }) {
    let clientIdentity = sessionKey;
    if (!clientIdentity && typeof body === "string") {
      try {
        const p = JSON.parse(body);
        clientIdentity = p.metadata?.user_id || p.user || null;
      } catch {}
    }
    body = stripUnsupportedFields(body);
    const accountId = extractAccountId(connection?.credentials);
    const sessionId = codexSessionId(sessionKey, { source: sessionSource, promptCacheKey: sessionPromptCacheKey });
    body = withPromptCacheKey(body, sessionId, { clientIdentity });

    let effectivePromptCacheKey = sessionId;
    if (!effectivePromptCacheKey && typeof body === "string") {
      try {
        const p = JSON.parse(body);
        effectivePromptCacheKey = p.prompt_cache_key || null;
      } catch {}
    }

    const codexHeaders = {
      ...headers,
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.159.0",
      version: "0.159.0",
      Accept: "text/event-stream",
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      ...(sessionId ? { session_id: sessionId, conversation_id: sessionId } : {}),
    };

    const res = await super.execute({
      url,
      method,
      headers: codexHeaders,
      body,
      signal,
      timeoutMs,
      proxyUrl,
    });

    if (effectivePromptCacheKey && res) {
      try {
        res.headers?.set?.("x-zenith-prompt-cache-key", effectivePromptCacheKey);
        res._promptCacheKey = effectivePromptCacheKey;
      } catch {}
    }

    return res;
  }
}

export const codexExecutorInstance = new CodexExecutor();
registerExecutor("codex", codexExecutorInstance);
registerExecutor("openai-responses", codexExecutorInstance);
