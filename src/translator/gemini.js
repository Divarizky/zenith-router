import { randomUUID } from "node:crypto";

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
  let systemInstruction = undefined;

  const messages = Array.isArray(body.messages) ? body.messages : [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("\n") : "";
      if (text) {
        systemInstruction = { parts: [{ text }] };
      }
      continue;
    }

    if (msg.role === "user") {
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
              parts.push({
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              });
            }
          }
        }
      }
      contents.push({ role: "user", parts: parts.length > 0 ? parts : [{ text: "" }] });
      continue;
    }

    if (msg.role === "assistant") {
      const parts = [];
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          let args = {};
          try {
            args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : call.function?.arguments || {};
          } catch {}
          parts.push({
            functionCall: {
              name: sanitizeGeminiFunctionName(call.function?.name),
              args,
            },
          });
        }
      }
      contents.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] });
      continue;
    }

    if (msg.role === "tool") {
      let parsed = {};
      try {
        parsed = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content || {};
      } catch {
        parsed = { content: msg.content };
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: sanitizeGeminiFunctionName(msg.name || "tool_result"),
              response: { name: msg.name || "tool_result", content: parsed },
            },
          },
        ],
      });
    }
  }

  let tools = undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const declarations = [];
    for (const t of body.tools) {
      if (t.type === "function" && t.function) {
        declarations.push({
          name: sanitizeGeminiFunctionName(t.function.name),
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
                              name: part.functionCall.name,
                              arguments: JSON.stringify(part.functionCall.args || {}),
                            },
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
      toolCalls.push({
        id: `call_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: {
          name: p.functionCall.name,
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
