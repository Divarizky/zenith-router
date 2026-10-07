import { BaseExecutor, registerExecutor } from "./base.js";
import { createResponsesToOpenAITransformStream, responsesToOpenAIResponse } from "../translator/responses.js";

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

export class CodexExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl }) {
    const codexHeaders = {
      ...headers,
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.159.0",
      version: "0.159.0",
      Accept: "text/event-stream",
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
