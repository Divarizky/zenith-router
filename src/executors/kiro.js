import { randomUUID } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";

export class KiroExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl }) {
    const kiroHeaders = {
      ...headers,
      "X-Amz-Target": "AmazonCodeWhispererService.GenerateAssistantResponse",
      "Amz-Sdk-Invocation-Id": randomUUID(),
      "Amz-Sdk-Request": "attempt=1; max=3",
      "x-amzn-kiro-agent-mode": "spec",
      "x-amzn-codewhisperer-machine-id": "kiro-desktop",
      Accept: "application/vnd.amazon.eventstream",
    };

    const res = await super.execute({
      url,
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
