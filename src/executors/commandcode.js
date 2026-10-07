import { randomUUID } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";

/**
 * CommandCodeExecutor
 *
 * Handles upstream communication with CommandCode CLI / alpha endpoint:
 *   Base URL: https://api.commandcode.ai/alpha/generate
 *
 * Security & Protocol Constraints:
 * 1. Per-request fresh session identity: generates unique `x-session-id` UUID per call
 *    to prevent cross-connection conversation linkage.
 * 2. CLI isolation: sets `x-command-code-version: 0.25.7` and `x-cli-environment: cli`
 *    matching the native CLI runtime environment.
 * 3. Request translation: translates OpenAI chat completion request to the
 *    CommandCode alpha/generate schema (system prompt at top level, NDJSON / stream).
 * 4. Response stream translation: converts CommandCode NDJSON AI SDK events into
 *    standard OpenAI SSE chat.completion.chunk data streams, protecting against
 *    mid-stream error leakage or malformed events.
 */

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

function toContentBlocks(content) {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: "text", text: part });
      } else if (part && typeof part === "object") {
        if (typeof part.text === "string") {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "image_url" || part.type === "image") {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url || part.image;
          if (url) {
            blocks.push({ type: "image", image: url, mimeType: "image/png" });
          }
        }
      }
    }
    return blocks.length ? blocks : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: String(content) }];
}

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function translateOpenAIToCommandCode(body, model) {
  const incomingMessages = Array.isArray(body?.messages) ? body.messages : [];
  const outMessages = [];
  const systemTexts = [];

  for (const m of incomingMessages) {
    if (!m) continue;
    const role = m.role;

    if (role === "system") {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === "tool") {
      const value = typeof m.content === "string" ? m.content : flattenText(m.content);
      outMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id || "",
            toolName: m.name || "",
            output: { type: "text", value },
          },
        ],
      });
      continue;
    }

    if (role === "assistant") {
      const blocks = [];
      const rc = m.reasoning_content || m.thought || m.reasoning;
      if (rc || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) {
        blocks.push({ type: "reasoning", text: rc || " " });
      }
      const text = flattenText(m.content);
      if (text) blocks.push({ type: "text", text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id || "",
            toolName: fn.name || "",
            input: safeParseJson(fn.arguments),
          });
        }
      }
      outMessages.push({
        role: "assistant",
        content: blocks.length ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }

    outMessages.push({ role: "user", content: toContentBlocks(m.content) });
  }

  const params = {
    model: model || body?.model,
    messages: outMessages,
    stream: true,
    max_tokens: body?.max_tokens ?? body?.max_output_tokens ?? 8192,
    temperature: body?.temperature ?? 0.3,
  };

  if (systemTexts.length) {
    params.system = systemTexts.join("\n\n");
  }

  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (t?.type === "function" && t.function) {
        tools.push({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters || { type: "object" },
        });
      }
    }
    if (tools.length) params.tools = tools;
  }

  const today = new Date().toISOString().slice(0, 10);

  // Isolate workspace context to prevent environment leakage
  return {
    threadId: randomUUID(),
    memory: "",
    config: {
      workingDir: process.cwd(),
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

export function parseCommandCodeError(event) {
  if (!event || typeof event !== "object") {
    return { statusCode: 503, message: "CommandCode upstream error", type: "server_error" };
  }

  const errVal = event.error ?? event.message ?? "unknown";
  let message = typeof errVal === "object" && errVal !== null ? errVal.message || errVal.error || JSON.stringify(errVal) : String(errVal);
  let statusCode = Number(event.statusCode || errVal?.statusCode || errVal?.status) || null;
  let type = errVal?.type || "server_error";

  if (!statusCode || statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing") || lower.includes("credit")) {
      statusCode = 402;
      type = "billing_error";
    } else if (lower.includes("quota") || lower.includes("forbidden") || lower.includes("permission")) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

function commandCodeEventToOpenAI(chunkStr, state) {
  const line = chunkStr.trim();
  if (!line) return null;
  const jsonStr = line.startsWith("data:") ? line.slice(5).trim() : line;
  if (!jsonStr || jsonStr === "[DONE]") return null;

  let event;
  try {
    event = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!event || typeof event !== "object" || !event.type) return null;

  if (!state.id) {
    state.id = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.chunkIndex = 0;
    state.toolIndex = 0;
    state.toolIndexById = new Map();
  }

  const makeChunk = (delta, finishReason = null) => ({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model || "commandcode",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  });

  const out = [];

  switch (event.type) {
    case "text-delta": {
      const text = event.text || event.delta || "";
      if (text) {
        const delta = state.chunkIndex === 0 ? { role: "assistant", content: text } : { content: text };
        state.chunkIndex++;
        out.push(makeChunk(delta));
      }
      break;
    }
    case "reasoning-delta": {
      const text = event.text || "";
      if (text) {
        const delta = state.chunkIndex === 0 ? { role: "assistant", reasoning_content: text } : { reasoning_content: text };
        state.chunkIndex++;
        out.push(makeChunk(delta));
      }
      break;
    }
    case "tool-input-start": {
      const id = event.id || event.toolCallId || `call_${state.toolIndex}`;
      let idx = state.toolIndexById.get(id);
      if (idx == null) {
        idx = state.toolIndex++;
        state.toolIndexById.set(id, idx);
      }
      const delta = {
        ...(state.chunkIndex === 0 ? { role: "assistant" } : {}),
        tool_calls: [
          {
            index: idx,
            id,
            type: "function",
            function: { name: event.toolName || "", arguments: "" },
          },
        ],
      };
      state.chunkIndex++;
      out.push(makeChunk(delta));
      break;
    }
    case "tool-input-delta": {
      const id = event.id || event.toolCallId;
      const idx = state.toolIndexById.get(id);
      if (idx != null) {
        out.push(
          makeChunk({
            tool_calls: [
              {
                index: idx,
                function: { arguments: event.delta || event.inputTextDelta || "" },
              },
            ],
          })
        );
      }
      break;
    }
    case "tool-call": {
      const id = event.toolCallId;
      if (!state.toolIndexById.has(id)) {
        const idx = state.toolIndex++;
        state.toolIndexById.set(id, idx);
        const argsStr = typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {});
        const delta = {
          ...(state.chunkIndex === 0 ? { role: "assistant" } : {}),
          tool_calls: [
            {
              index: idx,
              id,
              type: "function",
              function: { name: event.toolName || "", arguments: argsStr },
            },
          ],
        };
        state.chunkIndex++;
        out.push(makeChunk(delta));
      }
      break;
    }
    case "finish-step": {
      state.finishReason = event.finishReason === "tool-calls" ? "tool_calls" : "stop";
      if (event.usage) state.usage = event.usage;
      break;
    }
    case "finish": {
      const reason = state.finishReason || (event.finishReason === "tool-calls" ? "tool_calls" : "stop");
      const finalChunk = makeChunk({}, reason);
      const usage = event.totalUsage || state.usage;
      if (usage) {
        finalChunk.usage = {
          prompt_tokens: usage.promptTokens || usage.inputTokens || 0,
          completion_tokens: usage.completionTokens || usage.outputTokens || 0,
          total_tokens: (usage.promptTokens || usage.inputTokens || 0) + (usage.completionTokens || usage.outputTokens || 0),
        };
      }
      out.push(finalChunk);
      break;
    }
    case "error": {
      const { message } = parseCommandCodeError(event);
      throw new Error(`[CommandCode error: ${message}]`);
    }
  }

  return out;
}

export class CommandCodeExecutor extends BaseExecutor {
  constructor(options = {}) {
    super(options);
  }

  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl }) {
    const rawHeaders = headers instanceof Headers ? Object.fromEntries(headers.entries()) : { ...headers };
    const authHeader = rawHeaders["Authorization"] || rawHeaders["authorization"] || "";

    if (!authHeader) {
      return new Response(
        JSON.stringify({
          error: { message: "CommandCode API Key / Token required", type: "authentication_error" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    let parsedBody = {};
    if (typeof body === "string") {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = {};
      }
    } else if (body && typeof body === "object") {
      parsedBody = body;
    }

    const requestedModel = typeof parsedBody.model === "string" ? parsedBody.model.replace(/^(commandcode|cmc)\//, "") : "deepseek/deepseek-v4-pro";
    const commandCodePayload = translateOpenAIToCommandCode(parsedBody, requestedModel);

    // Isolate sessions: generate fresh session ID for each call
    const sessionId = randomUUID();

    const upstreamHeaders = {
      ...rawHeaders,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-command-code-version": "0.25.7",
      "x-cli-environment": "cli",
      "x-session-id": sessionId,
      Authorization: authHeader,
    };

    const targetUrl = url || "https://api.commandcode.ai/alpha/generate";

    const upstreamRes = await super.execute({
      url: targetUrl,
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(commandCodePayload),
      signal,
      timeoutMs,
      proxyUrl,
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      return upstreamRes;
    }

    // Inspect stream headers / first chunks for NDJSON errors or wrap into OpenAI SSE stream
    return this.wrapResponseStream(upstreamRes, requestedModel);
  }

  async wrapResponseStream(response, model) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const state = { model };
    let errorDetected = null;
    const initialChunks = [];

    // Peek the first chunk to catch immediate NDJSON errors
    try {
      const { value, done } = await reader.read();
      if (!done && value) {
        initialChunks.push(value);
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed);
            if (parsed?.type === "error") {
              errorDetected = parsed;
              break;
            }
          } catch {}
        }
      }
    } catch (err) {
      return response;
    }

    if (errorDetected) {
      try {
        await reader.cancel();
      } catch {}
      const { statusCode, message, type } = parseCommandCodeError(errorDetected);
      return new Response(
        JSON.stringify({
          error: {
            message: `[CommandCode error: ${message}]`,
            type,
            code: statusCode,
          },
        }),
        {
          status: statusCode,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Replay initial chunks then pipe through
    let initialIndex = 0;
    const replayedStream = new ReadableStream({
      async pull(controller) {
        if (initialIndex < initialChunks.length) {
          controller.enqueue(initialChunks[initialIndex++]);
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {}
      },
    });

    const transform = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const chunks = commandCodeEventToOpenAI(line, state);
          if (chunks) {
            for (const c of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
            }
          }
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          const chunks = commandCodeEventToOpenAI(buffer.trim(), state);
          if (chunks) {
            for (const c of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
            }
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    });

    return new Response(replayedStream.pipeThrough(transform), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

export const commandCodeExecutorInstance = new CommandCodeExecutor();
registerExecutor("commandcode", commandCodeExecutorInstance);
