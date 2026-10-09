import { randomUUID } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";

const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_UA = "antigravity/ide/2.11.0 darwin/arm64";

function actionFor(stream) {
  return stream ? "streamGenerateContent?alt=sse" : "generateContent";
}

// Registry ids are client-facing; upstream wants the real model name, and tier
// variants (thinkingLevel) share one *-tiered model.
async function upstreamModelFor(model) {
  try {
    const { getProvider } = await import("../providers/index.js");
    const entry = getProvider("antigravity")?.models?.find((m) => m.id === model);
    return { id: entry?.upstreamModelId || model, thinkingLevel: entry?.thinkingLevel };
  } catch {
    return { id: model };
  }
}

// Set the tier unless the client already chose its own thinking settings.
function applyThinkingLevel(request, level) {
  if (!level) return request;
  const gen = request.generationConfig || {};
  const tc = gen.thinkingConfig || {};
  if (tc.thinkingLevel || tc.thinkingBudget !== undefined) return request;
  return {
    ...request,
    generationConfig: { ...gen, thinkingConfig: { includeThoughts: false, ...tc, thinkingLevel: level } },
  };
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
    const { id: model, thinkingLevel } = await upstreamModelFor(targetModel || parsed?.model || sourceRequest?.model || "");
    const projectId =
      connection?.credentials?.project_id || connection?.credentials?.projectId || parsed?.project || generateProjectId();

    const finalUrl = `${ANTIGRAVITY_BASE_URL}/v1internal:${actionFor(Boolean(stream))}`;
    const wrapped = {
      project: projectId,
      model,
      userAgent: "antigravity",
      request: applyThinkingLevel(sourceRequest, thinkingLevel),
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
