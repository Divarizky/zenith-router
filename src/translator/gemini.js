import { randomUUID } from "node:crypto";
import { captureLine } from "../services/logger.js";

// Original (client) tool names keyed by the sanitized wire name, so the
// response direction can hand the client the exact name it declared. Populated
// on every request translation; bounded to avoid unbounded growth.
const TOOL_NAME_CAP = 1024;
const ORIGINAL_TOOL_NAMES = new Map();

// Thought signatures returned by Gemini, keyed by the tool_call id Zenith
// handed the client. Read back on the next request so function calls keep
// their signature across turns.
const SIGNATURE_CAP = 512;
const THOUGHT_SIGNATURES = new Map();

function rememberToolName(sanitized, original) {
  if (!sanitized || !original || sanitized === original) return;
  if (ORIGINAL_TOOL_NAMES.has(sanitized)) return;
  if (ORIGINAL_TOOL_NAMES.size >= TOOL_NAME_CAP) {
    ORIGINAL_TOOL_NAMES.delete(ORIGINAL_TOOL_NAMES.keys().next().value);
  }
  ORIGINAL_TOOL_NAMES.set(sanitized, original);
}

function restoreToolName(name) {
  if (typeof name !== "string") return name;
  return ORIGINAL_TOOL_NAMES.get(name) || name;
}

// Record a thought signature Gemini returned for a tool call, keyed by the
// tool_call id the client received. Entries expire after 24h (lazy eviction).
const SIGNATURE_TTL_MS = 24 * 60 * 60 * 1000;

export function rememberThoughtSignature(toolCallId, signature) {
  if (typeof toolCallId !== "string" || !toolCallId || typeof signature !== "string" || !signature) return;
  if (THOUGHT_SIGNATURES.size >= SIGNATURE_CAP) {
    THOUGHT_SIGNATURES.delete(THOUGHT_SIGNATURES.keys().next().value);
  }
  THOUGHT_SIGNATURES.set(toolCallId, { signature, at: Date.now() });
}

function cachedThoughtSignature(toolCallId) {
  const entry = THOUGHT_SIGNATURES.get(toolCallId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > SIGNATURE_TTL_MS) {
    THOUGHT_SIGNATURES.delete(toolCallId);
    return undefined;
  }
  return entry.signature;
}

/** Reset translator module state (test hook). */
export function resetGeminiTranslatorState() {
  ORIGINAL_TOOL_NAMES.clear();
  THOUGHT_SIGNATURES.clear();
}

// The wire must carry the sanitized declared name; clients see the original.
function clientThoughtSignature(call) {
  const sig = call?.extra_content?.google?.thought_signature;
  return typeof sig === "string" && sig ? sig : undefined;
}

// Keys Gemini's Schema proto rejects ("Unknown name ... Cannot find field").
const UNSUPPORTED_SCHEMA_KEYS = [
  "$schema", "$id", "$ref", "$defs", "definitions", "additionalProperties", "default",
  "patternProperties", "propertyNames", "unevaluatedProperties", "const", "not", "if", "then", "else",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "examples", "contentEncoding", "contentMediaType",
];

function cleanJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanJsonSchema);
  const copy = { ...schema };
  if ("const" in copy && !copy.enum) copy.enum = [copy.const];
  for (const key of UNSUPPORTED_SCHEMA_KEYS) delete copy[key];

  if (copy.properties && typeof copy.properties === "object") {
    const newProps = {};
    for (const [k, v] of Object.entries(copy.properties)) {
      newProps[k] = cleanJsonSchema(v);
    }
    copy.properties = newProps;
  }
  if (copy.items) copy.items = cleanJsonSchema(copy.items);
  if (Array.isArray(copy.oneOf)) {
    copy.anyOf = [...(copy.anyOf || []), ...copy.oneOf];
    delete copy.oneOf;
  }
  if (Array.isArray(copy.anyOf)) copy.anyOf = copy.anyOf.map(cleanJsonSchema);
  if (Array.isArray(copy.enum)) copy.enum = copy.enum.map(String);
  return copy;
}

function sanitizeGeminiFunctionName(name) {
  if (!name) return "_unknown";
  let s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.slice(0, 64);
}

/**
 * Translate OpenAI Chat Completions request to Gemini / Cloud Code request format
 */
export function openaiToGeminiRequest(body, targetModel, projectId = "") {
  if (!body) return {};

  const contents = [];
  const systemTexts = [];

  const messages = Array.isArray(body.messages) ? body.messages : [];

  // tool_call id -> sanitized name, so functionResponse can carry the matching
  // function name (Gemini requires the pair to agree).
  const toolNameById = new Map();
  // id -> signature: client-provided extra_content wins, else cache from the
  // previous response.
  const signatureById = new Map();
  for (const msg of messages) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const sanitized = sanitizeGeminiFunctionName(call.function?.name);
        rememberToolName(sanitized, call.function?.name);
        if (call.id) toolNameById.set(call.id, sanitized);
        const provided = clientThoughtSignature(call);
        const cached = typeof call.id === "string" ? cachedThoughtSignature(call.id) : undefined;
        const signature = provided || cached;
        if (signature && call.id) signatureById.set(call.id, signature);
      }
    }
  }

  // Index of the last real user text message. functionCall steps after it are
  // the current turn, the only ones Gemini validates for signatures.
  let lastUserTextIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const text = typeof msg.content === "string" ? msg.content : "";
    if (text.trim()) { lastUserTextIdx = i; break; }
    if (Array.isArray(msg.content) && msg.content.some((p) => p?.type === "text" && p.text?.trim())) {
      lastUserTextIdx = i;
      break;
    }
  }

  // Pending functionResponse parts for the current model step; flushed as one
  // user content right after the step they answer.
  let pendingResponses = null;
  const flushResponses = () => {
    if (pendingResponses && pendingResponses.length > 0) {
      contents.push({ role: "user", parts: pendingResponses });
    }
    pendingResponses = null;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c?.text || "").join("\n") : "";
      if (text) systemTexts.push(text);
      continue;
    }

    if (msg.role === "user") {
      flushResponses();
      const parts = [];
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (typeof p === "string") parts.push({ text: p });
          else if (p.type === "text") parts.push({ text: p.text || "" });
          else if (p.type === "image_url") {
            const url = p.image_url?.url || p.image_url || "";
            if (url.startsWith("data:")) {
              const [header, base64Data] = url.split(",");
              const mimeType = header.split(";")[0].replace("data:", "") || "image/jpeg";
              parts.push({ inlineData: { mimeType, data: base64Data } });
            }
          }
        }
      }
      contents.push({ role: "user", parts: parts.length > 0 ? parts : [{ text: "" }] });
      continue;
    }

    if (msg.role === "assistant") {
      flushResponses();
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      if (Array.isArray(msg.tool_calls)) {
        const isCurrentTurn = i > lastUserTextIdx;
        let firstOfStep = true;
        for (const call of msg.tool_calls) {
          let args = {};
          try {
            args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : call.function?.arguments || {};
          } catch {}
          const functionCall = {
            name: sanitizeGeminiFunctionName(call.function?.name),
            args,
          };
          // Gemini 3+ rejects a current-turn step whose first functionCall has
          // no signature. The client's or cached value is used when present;
          // otherwise the documented validator-skip sentinel keeps the request
          // legal at the cost of a weaker step (see F-11 / ADR-3).
          let signature = signatureById.get(call.id);
          if (!signature && isCurrentTurn && firstOfStep) {
            signature = "skip_thought_signature_validator";
            captureLine("[GEMINI] thought_signature cache miss -> dummy skip_thought_signature_validator");
          }
          if (signature) functionCall.thoughtSignature = signature;
          firstOfStep = false;
          parts.push({ functionCall });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      let parsed = {};
      try {
        parsed = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content || {};
      } catch {
        parsed = { content: msg.content };
      }
      const name = toolNameById.get(msg.tool_call_id) || sanitizeGeminiFunctionName(msg.name || "tool_result");
      if (!pendingResponses) pendingResponses = [];
      pendingResponses.push({
        functionResponse: {
          name,
          response: { name, content: parsed },
        },
      });
    }
  }
  flushResponses();

  // Every system message is kept: Gemini merges the parts into one preamble.
  let systemInstruction = undefined;
  if (systemTexts.length > 0) {
    systemInstruction = { parts: systemTexts.map((text) => ({ text })) };
  }

  let tools = undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const declarations = [];
    for (const t of body.tools) {
      if (t.type === "function" && t.function) {
        const sanitized = sanitizeGeminiFunctionName(t.function.name);
        rememberToolName(sanitized, t.function.name);
        declarations.push({
          name: sanitized,
          description: t.function.description || undefined,
          parameters: cleanJsonSchema(t.function.parameters) || undefined,
        });
      }
    }
    if (declarations.length > 0) {
      tools = [{ functionDeclarations: declarations }];
    }
  }

  const generationConfig = {};
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  if (typeof body.top_p === "number") generationConfig.topP = body.top_p;
  if (typeof body.max_tokens === "number" || typeof body.max_completion_tokens === "number") {
    generationConfig.maxOutputTokens = body.max_tokens || body.max_completion_tokens;
  }

  const innerRequest = {
    contents,
    systemInstruction,
    tools,
    generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
  };

  if (projectId) {
    return {
      project: projectId,
      model: targetModel || body.model,
      request: innerRequest,
    };
  }

  return innerRequest;
}

/**
 * Transform Gemini / Cloud Code SSE chunks to OpenAI Chat Completion chunks
 */
export function createGeminiToOpenAITransformStream(model = "gemini") {
  let buffer = "";
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  const responseId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  let currentToolCallIndex = 0;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        try {
          const raw = JSON.parse(dataStr);
          const payload = raw.response || raw;
          const candidate = payload.candidates?.[0];

          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) {
                const openAIChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: part.text },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
              }

              if (part.functionCall) {
                const callId = `call_${randomUUID().slice(0, 8)}`;
                if (part.functionCall.thoughtSignature) {
                  rememberThoughtSignature(callId, part.functionCall.thoughtSignature);
                }
                const openAIChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: currentToolCallIndex++,
                            id: callId,
                            type: "function",
                            function: {
                              name: restoreToolName(part.functionCall.name),
                              arguments: JSON.stringify(part.functionCall.args || {}),
                            },
                            // Signature rides back to the client so its next
                            // request survives a Zenith restart (cache cold).
                            ...(part.functionCall.thoughtSignature
                              ? { extra_content: { google: { thought_signature: part.functionCall.thoughtSignature } } }
                              : {}),
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
              }
            }
          }

          if (candidate?.finishReason) {
            const finishReason = candidate.finishReason === "STOP" ? (currentToolCallIndex > 0 ? "tool_calls" : "stop") : "stop";
            const usage = payload.usageMetadata;
            const openAIChunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: finishReason,
                },
              ],
              ...(usage
                ? {
                    usage: {
                      prompt_tokens: usage.promptTokenCount || 0,
                      completion_tokens: usage.candidatesTokenCount || 0,
                      total_tokens: usage.totalTokenCount || (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
                    },
                  }
                : {}),
            };
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
          }
        } catch {}
      }
    },
    flush(controller) {
      controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
    },
  });
}

/**
 * Aggregate non-streaming Gemini response into OpenAI format
 */
export async function geminiToOpenAIResponse(data, model = "gemini") {
  const payload = data.response || data;
  const candidate = payload.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  let text = "";
  const toolCalls = [];

  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) {
      const callId = `call_${randomUUID().slice(0, 8)}`;
      if (p.functionCall.thoughtSignature) {
        rememberThoughtSignature(callId, p.functionCall.thoughtSignature);
      }
      toolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: restoreToolName(p.functionCall.name),
          arguments: JSON.stringify(p.functionCall.args || {}),
        },
      });
    }
  }

  const message = {
    role: "assistant",
    content: text || (toolCalls.length > 0 ? null : ""),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usageMeta = payload.usageMetadata || {};

  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usageMeta.promptTokenCount || 0,
      completion_tokens: usageMeta.candidatesTokenCount || 0,
      total_tokens: usageMeta.totalTokenCount || (usageMeta.promptTokenCount || 0) + (usageMeta.candidatesTokenCount || 0),
    },
  };
}
