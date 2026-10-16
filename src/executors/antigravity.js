import { randomUUID } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";
import { antigravityUserAgent } from "../services/antigravityIdentity.js";
import { flattenToolUnionsForClaude, stripToolCallIds } from "../translator/gemini.js";

const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

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

// Claude models behind Antigravity validate tool schemas as Claude's input_schema,
// which rejects some anyOf shapes that Gemini accepts.
function isClaudeModel(model) {
  return typeof model === "string" && /^claude/i.test(model);
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

// The official client sends a fresh requestId per call and requestType "agent" in
// the wrapper. sessionId is not added: the sources disagree on whether it goes
// upstream, so it stays out until verified against a live capture.
function missingProjectResponse() {
  return new Response(
    JSON.stringify({
      error: {
        message: "Antigravity project_id tidak tersedia. Hubungkan ulang akun Antigravity agar loadCodeAssist mengembalikan project.",
        type: "authentication_error",
      },
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}

export class AntigravityExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, stream = false, targetModel }) {
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {}

    const sourceRequest = parsed?.request || parsed || {};
    const { id: model, thinkingLevel } = await upstreamModelFor(targetModel || parsed?.model || sourceRequest?.model || "");
    const projectId = connection?.credentials?.project_id || connection?.credentials?.projectId || parsed?.project;
    if (!projectId) return missingProjectResponse();

    const finalUrl = `${ANTIGRAVITY_BASE_URL}/v1internal:${actionFor(Boolean(stream))}`;
    const wrapped = {
      project: projectId,
      model,
      userAgent: "antigravity",
      requestId: `agent-${randomUUID()}`,
      requestType: "agent",
      request: applyThinkingLevel(
        isClaudeModel(model) ? flattenToolUnionsForClaude(sourceRequest) : stripToolCallIds(sourceRequest),
        thinkingLevel
      ),
    };

    const antigravityHeaders = {
      ...headers,
      "User-Agent": headers["User-Agent"] || antigravityUserAgent(),
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
