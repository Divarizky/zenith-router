import { randomUUID } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";

const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_UA = "antigravity/ide/2.11.0 darwin/arm64";

function actionFor(stream) {
  return stream ? "streamGenerateContent?alt=sse" : "generateContent";
}

// Registry ids are client-facing; upstream wants the tiered/suffixed name.
async function upstreamModelFor(model) {
  try {
    const { getProvider } = await import("../providers/index.js");
    const entry = getProvider("antigravity")?.models?.find((m) => m.id === model);
    return entry?.upstreamModelId || model;
  } catch {
    return model;
  }
}

function generateProjectId() {
  return `bright-core-${randomUUID().slice(0, 5)}`;
}

export class AntigravityExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, stream = false, targetModel }) {
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {}

    const sourceRequest = parsed?.request || parsed || {};
    const model = await upstreamModelFor(targetModel || parsed?.model || sourceRequest?.model || "");
    const projectId =
      connection?.credentials?.project_id || connection?.credentials?.projectId || parsed?.project || generateProjectId();

    const finalUrl = `${ANTIGRAVITY_BASE_URL}/v1internal:${actionFor(Boolean(stream))}`;
    const wrapped = {
      project: projectId,
      model,
      userAgent: "antigravity",
      request: sourceRequest,
    };

    const antigravityHeaders = {
      ...headers,
      "User-Agent": headers["User-Agent"] || ANTIGRAVITY_UA,
      Accept: stream ? "text/event-stream" : "application/json",
    };

    return super.execute({
      url: finalUrl,
      method,
      headers: antigravityHeaders,
      body: JSON.stringify(wrapped),
      signal,
      timeoutMs,
      proxyUrl,
    });
  }
}

export const antigravityExecutorInstance = new AntigravityExecutor();
registerExecutor("antigravity", antigravityExecutorInstance);
registerExecutor("gemini", antigravityExecutorInstance);
