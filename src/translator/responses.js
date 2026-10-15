import { randomUUID } from "node:crypto";

// Chat Completions names a forced tool under `function`; the Responses API
// expects the name at the top level. Strings ("auto", "none", "required") and
// choices already in Responses shape pass through.
function toResponsesToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "object" && choice.type === "function" && typeof choice.function?.name === "string") {
    return { type: "function", name: choice.function.name };
  }
  return choice;
}

/**
 * Translate OpenAI Chat Completions request to OpenAI Responses API format (Codex)
 */
export function openaiToResponsesRequest(body, targetModel) {
  if (!body) return {};

  const input = [];
  let instructions = "";

  const messages = Array.isArray(body.messages) ? body.messages : [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "system") {
      const contentText = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("\n") : "";
      if (contentText) {
        if (instructions) instructions += "\n\n" + contentText;
        else instructions = contentText;
      }
      continue;
    }

    if (msg.role === "user") {
      let content = msg.content;
      if (Array.isArray(msg.content)) {
        content = msg.content.map((part) => {
          if (typeof part === "string") return { type: "input_text", text: part };
          if (part.type === "text") return { type: "input_text", text: part.text || "" };
          if (part.type === "image_url") {
            return {
              type: "input_image",
              image_url: part.image_url?.url || part.image_url || "",
            };
          }
          return part;
        });
      }
      input.push({
        type: "message",
        role: "user",
        content: content || "",
      });
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: msg.content,
        });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          // Responses API pairs calls and outputs by `call_id`; `id` is optional and
          // must start with "fc", so the chat tool_call id goes into call_id only.
          input.push({
            type: "function_call",
            call_id: call.id || `call_${randomUUID().slice(0, 8)}`,
            name: call.function?.name || "unknown",
            arguments: typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.function?.arguments || {}),
          });
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || ""),
      });
    }
  }

  // Tools mapping
  let tools = undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = body.tools.map((t) => {
      if (t.type === "function" && t.function) {
        return {
          type: "function",
          name: t.function.name,
          description: t.function.description || undefined,
          parameters: t.function.parameters || undefined,
          strict: t.function.strict || undefined,
        };
      }
      return t;
    });
  }

  // The chat budget becomes the Responses field. Providers that refuse it (the
  // Codex backend) strip it in their executor; OpenCode clamps it there.
  const rawTokens = body.max_output_tokens ?? body.max_tokens;
  const max_output_tokens = typeof rawTokens === "number" && !Number.isNaN(rawTokens) ? rawTokens : undefined;

  return {
    model: targetModel || body.model,
    input,
    instructions: instructions || undefined,
    tools,
    tool_choice: toResponsesToolChoice(body.tool_choice),
    stream: true, // Codex requires stream
    store: false,
    parallel_tool_calls: body.parallel_tool_calls,
    ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
  };
}

// Text of a Responses content value (string or part array), for roles and
// outputs that Chat Completions only accepts as plain text.
function responsesText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function responsesPartToChat(part) {
  if (typeof part === "string") return { type: "text", text: part };
  if (!part || typeof part !== "object") return null;
  if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
    return { type: "text", text: part.text || "" };
  }
  if (part.type === "input_image") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (!url) return null;
    return { type: "image_url", image_url: part.detail ? { url, detail: part.detail } : { url } };
  }
  if (part.type === "image_url") return part;
  return null;
}

// User content keeps its parts only when an image needs them; plain text is
// sent as a string, which every Chat Completions upstream accepts.
function responsesUserContent(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts = content.map(responsesPartToChat).filter(Boolean);
  if (parts.some((p) => p.type === "image_url")) return parts;
  return parts.map((p) => p.text).join("\n");
}

function responsesToolToChat(tool) {
  if (tool?.type === "function" && !tool.function && typeof tool.name === "string") {
    const fn = { name: tool.name };
    if (tool.description) fn.description = tool.description;
    if (tool.parameters) fn.parameters = tool.parameters;
    if (tool.strict !== undefined) fn.strict = tool.strict;
    return { type: "function", function: fn };
  }
  return tool;
}

function responsesToolChoiceToChat(choice) {
  if (choice && typeof choice === "object" && choice.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return choice;
}

/**
 * Translate an OpenAI Responses API request into Chat Completions, the pivot
 * format. The inverse of openaiToResponsesRequest: function_call items become
 * assistant tool_calls, function_call_output items become tool messages, and
 * input_image parts become image_url parts. Reasoning items are dropped, since
 * Chat Completions has no place for them.
 */
export function responsesToOpenAIRequest(body) {
  if (!body) return {};
  const messages = [];

  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  const items = typeof body.input === "string" ? [body.input] : Array.isArray(body.input) ? body.input : [];
  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (typeof item !== "object") continue;

    if (item.type === "function_call") {
      const call = {
        id: item.call_id || item.id || `call_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: {
          name: item.name || "unknown",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      };
      // Parallel calls arrive as consecutive items; they share one assistant turn.
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
      else if (last?.role === "assistant" && !last.tool_calls) last.tool_calls = [call];
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || "",
        content: typeof item.output === "string" ? item.output : responsesText(item.output) || JSON.stringify(item.output ?? ""),
      });
      continue;
    }

    if (item.type && item.type !== "message") continue; // reasoning and other non-message items

    const role = item.role === "developer" ? "system" : item.role || "user";
    if (role === "user") {
      messages.push({ role, content: responsesUserContent(item.content) });
    } else {
      messages.push({ role, content: responsesText(item.content) });
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: " " });
  }

  const tools = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools.map(responsesToolToChat) : undefined;

  return {
    model: body.model,
    messages,
    stream: Boolean(body.stream),
    tools,
    tool_choice: responsesToolChoiceToChat(body.tool_choice),
    parallel_tool_calls: tools ? body.parallel_tool_calls : undefined,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens ?? body.max_output_tokens,
  };
}

/**
 * The `output` array of a non-streaming Responses API reply, built from a Chat
 * Completions message: its text as a message item, each tool call as a
 * function_call item.
 */
export function openAIMessageToResponsesOutput(message) {
  const output = [];
  const text = typeof message?.content === "string" ? message.content : responsesText(message?.content);
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

  if (text || toolCalls.length === 0) {
    output.push({
      type: "message",
      id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: text || "", annotations: [] }],
    });
  }
  for (const call of toolCalls) {
    const args = call.function?.arguments;
    output.push({
      type: "function_call",
      id: `fc_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      call_id: call.id || `call_${randomUUID().slice(0, 8)}`,
      name: call.function?.name || "unknown",
      arguments: typeof args === "string" ? args : JSON.stringify(args || {}),
      status: "completed",
    });
  }
  return output;
}

/**
 * Transform Responses API SSE events to standard OpenAI Chat Completion chunks
 */
export function createResponsesToOpenAITransformStream(model = "codex") {
  let buffer = "";
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  const responseId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  let currentToolCallIndex = 0;
  let activeToolCallId = null;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") {
            continue;
          }

          try {
            const parsed = JSON.parse(dataStr);
            const type = parsed.type;

            // Output text delta. The loose `parsed.delta` fallback only exists for
            // untyped text events; argument deltas must never be treated as content.
            const isArgsDelta = typeof type === "string" && type.endsWith("arguments.delta");
            if (type === "response.output_text.delta" || (!isArgsDelta && parsed.delta && typeof parsed.delta === "string")) {
              const textDelta = parsed.delta || parsed.text || "";
              const openAIChunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: textDelta },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            }

            // Function call item added (tool name + call_id)
            if (type === "response.output_item.added" && parsed.item?.type === "function_call") {
              activeToolCallId = parsed.item.call_id || parsed.item.id || `call_${randomUUID().slice(0, 8)}`;
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
                          index: currentToolCallIndex,
                          id: activeToolCallId,
                          type: "function",
                          function: {
                            name: parsed.item.name || "",
                            arguments: "",
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

            // Function call arguments delta
            if (type === "response.function_call_arguments.delta") {
              const argDelta = parsed.delta || "";
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
                          index: currentToolCallIndex,
                          function: {
                            arguments: argDelta,
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

            if (type === "response.output_item.done" && parsed.item?.type === "function_call") {
              currentToolCallIndex++;
              activeToolCallId = null;
            }

            // Completed response
            if (type === "response.completed" || type === "response.done") {
              const resp = parsed.response || parsed;
              const usage = resp.usage || {};
              const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
              const outputTokens = usage.output_tokens || usage.completion_tokens || 0;

              const openAIChunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: currentToolCallIndex > 0 ? "tool_calls" : "stop",
                  },
                ],
                usage: {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                },
              };
              controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            }
          } catch {}
        }
      }
    },
    flush(controller) {
      controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
    },
  });
}

/**
 * Transform OpenAI Chat Completion chunks to Responses API SSE events
 */
export function createOpenAIToResponsesTransformStream(model = "codex") {
  const state = {
    seq: 0,
    responseId: `resp_${randomUUID().slice(0, 12)}`,
    created: Math.floor(Date.now() / 1000),
    started: false,
    msgTextBuf: {},
    msgItemAdded: {},
    msgContentAdded: {},
    msgItemDone: {},
    funcArgsBuf: {},
    funcNames: {},
    funcCallIds: {},
    funcArgsDone: {},
    funcItemDone: {},
    buffer: "",
    completedSent: false,
  };

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const nextSeq = () => ++state.seq;

  const emit = (controller, eventType, data) => {
    data.sequence_number = nextSeq();
    controller.enqueue(textEncoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const closeMessage = (controller, idx) => {
    if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
      state.msgItemDone[idx] = true;
      const fullText = state.msgTextBuf[idx] || "";
      const msgId = `msg_${state.responseId}_${idx}`;

      emit(controller, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: msgId,
        output_index: parseInt(idx, 10),
        content_index: 0,
        text: fullText,
        logprobs: [],
      });

      emit(controller, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: parseInt(idx, 10),
        item: {
          id: msgId,
          type: "message",
          content: [{ type: "output_text", annotations: [], logprobs: [], text: fullText }],
          role: "assistant",
        },
      });
    }
  };

  const closeToolCall = (controller, idx) => {
    const callId = state.funcCallIds[idx];
    if (callId && !state.funcItemDone[idx]) {
      const args = state.funcArgsBuf[idx] || "{}";

      emit(controller, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: `fc_${callId}`,
        output_index: parseInt(idx, 10),
        arguments: args,
      });

      emit(controller, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: parseInt(idx, 10),
        item: {
          id: `fc_${callId}`,
          type: "function_call",
          arguments: args,
          call_id: callId,
          name: state.funcNames[idx] || "",
        },
      });

      state.funcItemDone[idx] = true;
      state.funcArgsDone[idx] = true;
    }
  };

  const sendCompleted = (controller) => {
    if (!state.completedSent) {
      state.completedSent = true;
      emit(controller, "response.completed", {
        type: "response.completed",
        response: {
          id: state.responseId,
          object: "response",
          model,
          created_at: state.created,
          status: "completed",
          background: false,
          error: null,
        },
      });
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      const text = typeof chunk === "string" ? chunk : textDecoder.decode(chunk, { stream: true });
      state.buffer += text;

      const lines = state.buffer.split("\n\n");
      state.buffer = lines.pop() || "";

      for (const msg of lines) {
        if (!msg.trim()) continue;

        const dataMatch = msg.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;

        const dataStr = dataMatch[1].trim();
        if (dataStr === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (!parsed.choices?.length) continue;

        const choice = parsed.choices[0];
        const idx = choice.index || 0;
        const delta = choice.delta || {};

        if (!state.started) {
          state.started = true;
          state.responseId = parsed.id ? `resp_${parsed.id}` : state.responseId;

          emit(controller, "response.created", {
            type: "response.created",
            response: {
              id: state.responseId,
              object: "response",
              model,
              created_at: state.created,
              status: "in_progress",
              background: false,
              error: null,
              output: [],
            },
          });
        }

        if (delta.content) {
          const content = delta.content;
          if (!state.msgItemAdded[idx]) {
            state.msgItemAdded[idx] = true;
            const msgId = `msg_${state.responseId}_${idx}`;

            emit(controller, "response.output_item.added", {
              type: "response.output_item.added",
              output_index: idx,
              item: { id: msgId, type: "message", content: [], role: "assistant" },
            });
          }

          if (!state.msgContentAdded[idx]) {
            state.msgContentAdded[idx] = true;
            emit(controller, "response.content_part.added", {
              type: "response.content_part.added",
              item_id: `msg_${state.responseId}_${idx}`,
              output_index: idx,
              content_index: 0,
              part: { type: "output_text", annotations: [], logprobs: [], text: "" },
            });
          }

          emit(controller, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: `msg_${state.responseId}_${idx}`,
            output_index: idx,
            content_index: 0,
            delta: content,
            logprobs: [],
          });

          if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
          state.msgTextBuf[idx] += content;
        }

        if (Array.isArray(delta.tool_calls)) {
          closeMessage(controller, idx);

          for (const tc of delta.tool_calls) {
            const tcIdx = tc.index ?? 0;
            const newCallId = tc.id;
            const funcName = tc.function?.name;

            if (funcName) state.funcNames[tcIdx] = funcName;

            if (!state.funcCallIds[tcIdx] && newCallId) {
              state.funcCallIds[tcIdx] = newCallId;

              emit(controller, "response.output_item.added", {
                type: "response.output_item.added",
                output_index: tcIdx,
                item: {
                  id: `fc_${newCallId}`,
                  type: "function_call",
                  arguments: "",
                  call_id: newCallId,
                  name: state.funcNames[tcIdx] || "",
                },
              });
            }

            if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

            if (tc.function?.arguments) {
              const refCallId = state.funcCallIds[tcIdx] || newCallId;
              if (refCallId) {
                emit(controller, "response.function_call_arguments.delta", {
                  type: "response.function_call_arguments.delta",
                  item_id: `fc_${refCallId}`,
                  output_index: tcIdx,
                  delta: tc.function.arguments,
                });
              }
              state.funcArgsBuf[tcIdx] += tc.function.arguments;
            }
          }
        }

        if (choice.finish_reason) {
          for (const i in state.msgItemAdded) closeMessage(controller, i);
          for (const i in state.funcCallIds) closeToolCall(controller, i);
          sendCompleted(controller);
        }
      }
    },

    flush(controller) {
      for (const i in state.msgItemAdded) closeMessage(controller, i);
      for (const i in state.funcCallIds) closeToolCall(controller, i);
      sendCompleted(controller);
      controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
    },
  });
}


/**
 * Aggregate Responses API SSE stream into single OpenAI Chat Completion response (non-streaming)
 */
export async function responsesToOpenAIResponse(streamOrData, model = "codex") {
  if (typeof streamOrData === "object" && !streamOrData.getReader && !streamOrData[Symbol.asyncIterator]) {
    return streamOrData;
  }

  const responseId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let fullContent = "";
  const toolCalls = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let finishReason = "stop";

  const reader = streamOrData.getReader();
  const textDecoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += textDecoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.type === "response.output_text.delta") {
          fullContent += parsed.delta || "";
        }
        if (parsed.type === "response.output_item.added" && parsed.item?.type === "function_call") {
          toolCalls.push({
            id: parsed.item.call_id || parsed.item.id || `call_${randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name: parsed.item.name || "",
              arguments: "",
            },
          });
        }
        if (parsed.type === "response.function_call_arguments.delta" && toolCalls.length > 0) {
          toolCalls[toolCalls.length - 1].function.arguments += parsed.delta || "";
        }
        if (parsed.type === "response.completed") {
          const resp = parsed.response || parsed;
          if (resp.usage) {
            const inTok = resp.usage.input_tokens || resp.usage.prompt_tokens || 0;
            const outTok = resp.usage.output_tokens || resp.usage.completion_tokens || 0;
            usage = { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok };
          }
          if (toolCalls.length > 0) finishReason = "tool_calls";
        }
      } catch {}
    }
  }

  const message = {
    role: "assistant",
    content: fullContent || (toolCalls.length > 0 ? null : ""),
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: responseId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}
