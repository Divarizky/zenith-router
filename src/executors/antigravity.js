import { randomUUID } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";
import { antigravityUserAgent } from "../services/antigravityIdentity.js";
import { flattenToolUnionsForClaude, stripToolCallIds } from "../translator/gemini.js";
import { applyAntigravityPromptCompatibility } from "../services/antigravityPromptCompatibility.js";
import { createPrefixTracer } from "../services/prefixTrace.js";
import { captureLine } from "../services/logger.js";

// Opt-in diagnostics: ZENITH_CACHE_TRACE=1 logs how each session's upstream prefix changes between turns.
const prefixTracer = createPrefixTracer({
  enabled: process.env.ZENITH_CACHE_TRACE === "1",
  log: captureLine,
});

const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

function actionFor(stream) {
  return stream ? "streamGenerateContent?alt=sse" : "generateContent";
}

// Registry ids are client-facing; upstream wants the real model name, and tier
// variants (thinkingLevel) share one *-tiered model.
async function upstreamModelFor(model, effort, connection) {
  try {
    const { getProvider, resolveProviderRuntime } = await import("../providers/index.js");
    const { getAntigravityAccountModels } = await import("../db/index.js");
    const accountRows = connection?.id ? getAntigravityAccountModels(connection.id) : null;
    const picked = resolveProviderRuntime(getProvider("antigravity"), model, effort, accountRows?.size ? accountRows : null);
    if (picked) return { id: picked.id, thinkingLevel: picked.thinkingLevel };
    // A raw runtime id (suffixed or internal) is still accepted verbatim.
    return { id: model };
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

export function isAntigravityPromptRejection(status, bodyText) {
  if (status !== 429 || typeof bodyText !== "string") return false;
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (!json || typeof json !== "object") return false;
  const err = json.error && typeof json.error === "object" ? json.error : json;
  const code = err.status ?? json.status;
  if (code !== "RESOURCE_EXHAUSTED") return false;
  if (typeof err.message !== "string" || !/resource has been exhausted/i.test(err.message)) return false;
  const details = err.details ?? json.details;
  return details === undefined || details === null || (Array.isArray(details) && details.length === 0);
}

export function moveSystemInstructionToContents(request) {
  const sys = request?.systemInstruction;
  if (!sys) return request;
  const moved = (Array.isArray(sys.parts) ? sys.parts : []).filter((p) => typeof p?.text === "string").map((p) => ({ text: p.text }));
  const { systemInstruction, ...rest } = request;
  const contents = Array.isArray(request.contents) ? [...request.contents] : [];
  if (!moved.length) return { ...rest, contents };
  const idx = contents.findIndex((c) => c?.role === "user");
  if (idx === -1) {
    contents.unshift({ role: "user", parts: moved });
  } else {
    const turn = contents[idx];
    contents[idx] = { ...turn, parts: [...moved, ...(Array.isArray(turn.parts) ? turn.parts : [])] };
  }
  return { ...rest, contents };
}

function promptRejectedResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "Antigravity rejected the prompt content. This is not a quota error.",
        reason: "antigravity_prompt_rejected",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function rebuild(response, text) {
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export class AntigravityExecutor extends BaseExecutor {
  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, stream = false, targetModel, effort, sessionKey = null, sessionSource = null }) {
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {}

    const sourceRequest = parsed?.request || parsed || {};
    const { id: model, thinkingLevel } = await upstreamModelFor(
      targetModel || parsed?.model || sourceRequest?.model || "",
      effort,
      connection
    );
    const projectId = connection?.credentials?.project_id || connection?.credentials?.projectId || parsed?.project;
    if (!projectId) return missingProjectResponse();

    const finalUrl = `${ANTIGRAVITY_BASE_URL}/v1internal:${actionFor(Boolean(stream))}`;
    const compatibilityRequest = isClaudeModel(model)
      ? flattenToolUnionsForClaude(sourceRequest)
      : stripToolCallIds(sourceRequest);
    const upstreamRequest = applyThinkingLevel(
      applyAntigravityPromptCompatibility(compatibilityRequest),
      thinkingLevel
    );
    // An apikey-derived key is shared by every conversation on that key, so comparing
    // turns under it would report false divergence. Trace only client-declared sessions.
    if (sessionSource === "header" || sessionSource === "body") {
      prefixTracer.observe({ provider: "antigravity", sessionKey, model, request: upstreamRequest });
    }
    const wrapped = {
      project: projectId,
      model,
      userAgent: "antigravity",
      requestId: `agent-${randomUUID()}`,
      requestType: "agent",
      request: upstreamRequest,
    };

    const antigravityHeaders = {
      ...headers,
      "User-Agent": headers["User-Agent"] || antigravityUserAgent(),
      Accept: stream ? "text/event-stream" : "application/json",
    };

    const send = (payload) =>
      super.execute({
        url: finalUrl,
        method,
        headers: antigravityHeaders,
        body: JSON.stringify(payload),
        signal,
        timeoutMs,
        proxyUrl,
      });

    const response = await send(wrapped);
    if (response?.status !== 429) return response;

    const text = await response.text();
    if (!isAntigravityPromptRejection(response.status, text)) return rebuild(response, text);
    if (!upstreamRequest?.systemInstruction) return promptRejectedResponse();

    captureLine(`[ANTIGRAVITY] model=${model} prompt rejected, retrying with system text in first user turn`);
    const retry = await send({
      ...wrapped,
      requestId: `agent-${randomUUID()}`,
      request: moveSystemInstructionToContents(upstreamRequest),
    });
    if (retry?.status !== 429) return retry;
    const retryText = await retry.text();
    if (!isAntigravityPromptRejection(retry.status, retryText)) return rebuild(retry, retryText);
    return promptRejectedResponse();
  }
}

export const antigravityExecutorInstance = new AntigravityExecutor();
registerExecutor("antigravity", antigravityExecutorInstance);
registerExecutor("gemini", antigravityExecutorInstance);
