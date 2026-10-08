import { randomUUID } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";

const RUNTIME_URL = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";

export function kiroBaseUrls(credentials = {}) {
  const region = credentials.region || "us-east-1";
  return [
    `https://q.${region}.amazonaws.com/generateAssistantResponse`,
    `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`,
    RUNTIME_URL,
  ];
}

export function kiroHeadersForUrl(baseHeaders = {}, credentials = {}, url = "") {
  const headers = {
    ...baseHeaders,
    "Amz-Sdk-Invocation-Id": randomUUID(),
    "Amz-Sdk-Request": "attempt=1; max=3",
    "x-amzn-kiro-agent-mode": "spec",
    "x-amzn-codewhisperer-machine-id": "kiro-desktop",
    Accept: "application/vnd.amazon.eventstream",
  };

  delete headers["X-Amz-Target"];
  delete headers["TokenType"];

  if (url.includes("codewhisperer.")) {
    headers["X-Amz-Target"] = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
  } else if (url.includes(".amazonaws.com/generateAssistantResponse") && credentials.auth_method === "api_key") {
    headers.TokenType = "API_KEY";
  }

  return headers;
}

export class KiroExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection }) {
    const credentials = connection?.credentials || {};
    const finalUrl = credentials.auth_method ? kiroBaseUrls(credentials)[0] : url;
    const kiroHeaders = kiroHeadersForUrl(headers, credentials, finalUrl);

    const res = await super.execute({
      url: finalUrl,
      method,
      headers: kiroHeaders,
      body,
      signal,
      timeoutMs,
      proxyUrl,
    });

    return res;
  }
}

export const kiroExecutorInstance = new KiroExecutor();
registerExecutor("kiro", kiroExecutorInstance);
registerExecutor("codewhisperer", kiroExecutorInstance);
