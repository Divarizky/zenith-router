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
    for (const key of ["max_output_tokens", "temperature", "top_p", "top_k"]) {
      if (key in parsed) delete parsed[key];
    }
    if (parsed.store === undefined && Array.isArray(parsed.input)) {
      parsed.store = false;
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

export class CodexExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, stream = false, targetModel }) {
    body = stripUnsupportedFields(body);
    const accountId = extractAccountId(connection?.credentials);
    const codexHeaders = {
      ...headers,
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.159.0",
      version: "0.159.0",
      Accept: "text/event-stream",
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
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

    return res;
  }
}

export const codexExecutorInstance = new CodexExecutor();
registerExecutor("codex", codexExecutorInstance);
registerExecutor("openai-responses", codexExecutorInstance);
