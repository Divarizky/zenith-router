import { BaseExecutor, registerExecutor } from "./base.js";

export class AntigravityExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl }) {
    const antigravityHeaders = {
      ...headers,
      "User-Agent": "antigravity/ide/0.0.1 darwin/arm64",
      Accept: "text/event-stream",
    };

    const res = await super.execute({
      url,
      method,
      headers: antigravityHeaders,
      body,
      signal,
      timeoutMs,
      proxyUrl,
    });

    return res;
  }
}

export const antigravityExecutorInstance = new AntigravityExecutor();
registerExecutor("antigravity", antigravityExecutorInstance);
registerExecutor("gemini", antigravityExecutorInstance);
