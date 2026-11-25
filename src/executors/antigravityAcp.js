import path from "node:path";
import { randomUUID } from "node:crypto";
import pkg from "../../package.json" with { type: "json" };
import { createAntigravityAcpClient } from "../services/antigravityAcp/client.js";
import { createAntigravityAcpTransport } from "../services/antigravityAcp/transport.js";
import { registerExecutor } from "./base.js";
import {
  snapshotAntigravityAcpCandidates,
  isAntigravityAcpBindingCurrent,
  setAntigravityAcpProfileStatus,
  isAntigravityAcpEnabled,
} from "../services/antigravityAcp/profiles.js";

const MAX_STREAM_TEXT_BYTES = 1_048_576;
let transportFactory = null;
const createTrustedClient = (workerId, options) => createAntigravityAcpClient(workerId, createAntigravityAcpTransport, options);

/** Install a trusted server-side worker adapter; never populated from HTTP input. */
export function setAntigravityAcpTransportFactory(factory) {
  transportFactory = typeof factory === "function" ? factory : null;
}

export function getAntigravityAcpTransportFactory() {
  return transportFactory;
}

function openAiError(message, type, code, status) {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestText(body) {
  if (!body || Object.keys(body).some((key) => !["model", "messages", "stream"].includes(key))) return null;
  if (!Array.isArray(body.messages) || body.messages.length === 0 || (body.stream !== undefined && typeof body.stream !== "boolean")) return null;
  const turns = [];
  for (const message of body.messages) {
    if (!message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string") return null;
    if (message.content) turns.push(`${message.role}: ${message.content}`);
  }
  return turns.join("\n\n") || null;
}

function appendTextFromUpdate(params) {
  const update = params?.update;
  if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
    return update.content.text;
  }
  return "";
}

async function notifyCancel(client, sessionId) {
  try { await client.cancel({ sessionId }); } catch {}
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function errorFrame(code, message) {
  return sseFrame({ error: { message, type: "upstream_error", code } });
}

function createStreamingResponse({ client, sessionId, body, signal }) {
  const id = `chatcmpl-acp-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let controller;
  let outputBytes = 0;
  let settled = false;
  let consumerCancelled = false;
  let unsubscribe = () => {};
  let cleanupPromise = null;
  let abortCleanupPromise = null;

  const enqueue = (data) => {
    if (consumerCancelled || settled || !controller) return false;
    try { controller.enqueue(new TextEncoder().encode(data)); return true; }
    catch { consumerCancelled = true; return false; }
  };
  const finish = (tail) => {
    if (settled || consumerCancelled) return;
    if (tail && controller) {
      try { controller.enqueue(new TextEncoder().encode(tail)); } catch { consumerCancelled = true; }
    }
    settled = true;
    try { controller.close(); } catch {}
  };
  const finishError = (code, message) => finish(`${errorFrame(code, message)}data: [DONE]\n\n`);
  const closeClient = () => {
    if (!cleanupPromise) cleanupPromise = Promise.resolve().then(() => client.close?.()).catch(() => {});
    return cleanupPromise;
  };
  const abortTurn = (emitError) => {
    if (emitError) finishError("acp_turn_cancelled", "ACP turn was cancelled");
    if (!abortCleanupPromise) {
      abortCleanupPromise = Promise.resolve()
        .then(() => notifyCancel(client, sessionId))
        .then(() => closeClient())
        .catch(() => closeClient());
    }
    return abortCleanupPromise;
  };
  const cancelOnAbort = () => { void abortTurn(true); };

  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
      if (signal?.aborted) {
        void abortTurn(true);
        return;
      }
      enqueue(sseFrame({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
      unsubscribe = typeof client.onUpdate === "function" ? client.onUpdate((params) => {
        if (params?.sessionId !== sessionId || settled || consumerCancelled) return;
        const text = appendTextFromUpdate(params);
        if (!text) return;
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > MAX_STREAM_TEXT_BYTES) {
          finishError("acp_output_limit", "ACP response exceeded the supported output limit");
          void abortTurn(false);
          return;
        }
        enqueue(sseFrame({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
      }) : () => {};
      signal?.addEventListener("abort", cancelOnAbort, { once: true });
      if (signal?.aborted) {
        cancelOnAbort();
        return;
      }
      void (async () => {
        try {
          const result = await client.prompt({ sessionId, prompt: [{ type: "text", text: body.promptText }] });
          if (consumerCancelled || settled) return;
          if (signal?.aborted || result?.stopReason === "cancelled") {
            finishError("acp_turn_cancelled", "ACP turn was cancelled");
            return;
          }
          const stopReason = result?.stopReason;
          if (!["end_turn", "max_tokens", "max_turn_requests", "refusal"].includes(stopReason)) {
            finishError("acp_protocol_error", "ACP worker returned an invalid turn result");
            return;
          }
          const finishReason = ["max_tokens", "max_turn_requests"].includes(stopReason) ? "length" : "stop";
          finish(`${sseFrame({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}data: [DONE]\n\n`);
        } catch {
          if (!consumerCancelled && !settled) {
            finishError(signal?.aborted ? "acp_turn_cancelled" : "acp_outcome_unknown", signal?.aborted ? "ACP turn was cancelled" : "ACP worker request failed; no replay was attempted");
          }
        } finally {
          signal?.removeEventListener("abort", cancelOnAbort);
          unsubscribe?.();
          await closeClient();
        }
      })();
    },
    async cancel() {
      consumerCancelled = true;
      signal?.removeEventListener("abort", cancelOnAbort);
      unsubscribe?.();
      await abortTurn(false);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function errorStatus(error, stage) {
  if (stage === "prompt") return "acp_outcome_unknown";
  return `acp_${stage}_failed`;
}

/**
 * Runs the one supported OpenAI-shaped ACP model. Worker failover is only
 * possible before session/prompt for a local preflight failure or coded -32000.
 */
export async function executeAntigravityAcp({ body, signal, createClient = transportFactory || createTrustedClient }) {
  if (!isAntigravityAcpEnabled()) return openAiError("Antigravity ACP is disabled", "configuration_error", "acp_disabled", 503);
  if (!createClient) return openAiError("No trusted Antigravity ACP worker adapter is configured", "configuration_error", "acp_unavailable", 503);

  const promptText = requestText(body);
  if (!promptText) return openAiError("ACP accepts only model plus plain-text messages; tools and generation options are unsupported", "invalid_request_error", "acp_unsupported_request", 400);
  const candidates = snapshotAntigravityAcpCandidates();
  if (!candidates.length) return openAiError("No Antigravity ACP worker is configured", "configuration_error", "acp_unavailable", 503);

  let ready = null;
  for (const { profile, binding } of candidates) {
    if (signal?.aborted) return openAiError("Request cancelled", "client_closed", "client_closed_request", 499);
    if (!isAntigravityAcpBindingCurrent(binding)) continue;
    let client;
    const setStatus = (status) => setAntigravityAcpProfileStatus(profile.id, status, binding);
    let keepClient = false;
    let stage = "preflight";
    try {
      client = await createClient(profile.workerId, { signal });
      if (!client || typeof client.initialize !== "function" || typeof client.newSession !== "function" || typeof client.prompt !== "function" || typeof client.cancel !== "function" || typeof client.cwd !== "string" || !path.isAbsolute(client.cwd)) {
        throw Object.assign(new Error("Worker adapter unavailable"), { code: "ACP_LOCAL_UNAVAILABLE" });
      }
      if (signal?.aborted) return openAiError("Request cancelled", "client_closed", "client_closed_request", 499);
      if (!isAntigravityAcpBindingCurrent(binding)) continue;
      const initialized = await client.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "zenith-router", version: pkg.version },
      });
      if (signal?.aborted) return openAiError("Request cancelled", "client_closed", "client_closed_request", 499);
      if (!isAntigravityAcpBindingCurrent(binding)) continue;
      if (initialized?.protocolVersion !== 1) {
        setStatus("unavailable");
        return openAiError("ACP worker did not negotiate protocol version 1", "upstream_error", "acp_protocol_version", 502);
      }
      stage = "session";
      const session = await client.newSession({ cwd: client.cwd, mcpServers: [] });
      if (signal?.aborted) return openAiError("Request cancelled", "client_closed", "client_closed_request", 499);
      if (!isAntigravityAcpBindingCurrent(binding)) continue;
      if (!session || typeof session.sessionId !== "string" || !session.sessionId) {
        setStatus("unavailable");
        return openAiError("ACP worker returned an invalid session", "upstream_error", "acp_protocol_error", 502);
      }
      setStatus("ready");
      ready = { client, sessionId: session.sessionId };
      keepClient = true;
      break;
    } catch (error) {
      if (signal?.aborted) return openAiError("Request cancelled", "client_closed", "client_closed_request", 499);
      const preDispatchAuthRequired = stage !== "prompt" && error?.code === -32000;
      const localUnavailable = stage === "preflight" && error?.code === "ACP_LOCAL_UNAVAILABLE";
      if (preDispatchAuthRequired || localUnavailable) {
        setStatus(preDispatchAuthRequired ? "needs_login" : "unavailable");
        continue;
      }
      setStatus(error?.code === -32000 ? "needs_login" : "unavailable");
      return openAiError("ACP worker request failed; no automatic replay was attempted", "upstream_error", errorStatus(error, stage), 502);
    } finally {
      if (!keepClient) {
        try { await client?.close?.(); } catch {}
      }
    }
  }
  if (!ready) return openAiError("No configured Antigravity ACP worker is currently available", "upstream_error", "acp_workers_unavailable", 503);
  if (signal?.aborted) {
    try { await ready.client.close?.(); } catch {}
    return openAiError("Request cancelled", "client_closed", "client_closed_request", 499);
  }

  if (body.stream === true) {
    return createStreamingResponse({ client: ready.client, sessionId: ready.sessionId, body: { ...body, promptText }, signal });
  }

  const output = [];
  const onUpdate = (params) => {
    if (params?.sessionId === ready.sessionId) {
      const text = appendTextFromUpdate(params);
      if (text) output.push(text);
    }
  };
  const unsubscribe = typeof ready.client.onUpdate === "function" ? ready.client.onUpdate(onUpdate) : () => {};
  const cancelOnAbort = () => { void notifyCancel(ready.client, ready.sessionId).finally(() => ready.client.close?.()).catch(() => {}); };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    if (signal?.aborted) return openAiError("Request cancelled", "client_closed", "client_closed_request", 499);
    const result = await ready.client.prompt({ sessionId: ready.sessionId, prompt: [{ type: "text", text: promptText }] });
    if (signal?.aborted || result?.stopReason === "cancelled") return openAiError("ACP turn was cancelled", "request_cancelled", "acp_turn_cancelled", 499);
    const stopReason = result?.stopReason;
    if (!["end_turn", "max_tokens", "max_turn_requests", "refusal"].includes(stopReason)) {
      return openAiError("ACP worker returned an invalid turn result", "upstream_error", "acp_protocol_error", 502);
    }
    return new Response(JSON.stringify({
      id: `chatcmpl-acp-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: output.join("") }, finish_reason: ["max_tokens", "max_turn_requests"].includes(stopReason) ? "length" : "stop" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch {
    if (signal?.aborted) return openAiError("Request cancelled", "client_closed", "client_closed_request", 499);
    return openAiError("ACP worker request failed; no automatic replay was attempted", "upstream_error", "acp_outcome_unknown", 502);
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    unsubscribe?.();
    try { await ready.client.close?.(); } catch {}
  }
}

const executor = { execute: executeAntigravityAcp };
registerExecutor("antigravity-acp", executor);
export default executor;
