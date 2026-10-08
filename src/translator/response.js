function claudeContentToOpenAIFinish(content, stopReason) {
  let text = "";
  const toolCalls = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c) continue;
      if (c.type === "text") text += c.text || "";
      if (c.type === "tool_use") {
        toolCalls.push({
          id: c.id,
          type: "function",
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input || {}),
          },
        });
      }
    }
  } else if (typeof content === "string") {
    text = content;
  }

  const message = { role: "assistant", content: text || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    message,
    finish_reason: stopReason === "tool_use" || stopReason === "tool_calls" ? "tool_calls" : (stopReason === "end_turn" ? "stop" : (stopReason || "stop")),
    tool_calls: toolCalls,
  };
}

/**
 * Convert Claude message JSON to OpenAI chat.completion JSON
 */
export function claudeToOpenAIResponse(data, defaultModel = "claude") {
  const { message, finish_reason } = claudeContentToOpenAIFinish(data.content, data.stop_reason);

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model || defaultModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason,
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

/**
 * Convert OpenAI chat.completion JSON to Claude message JSON
 */
export function openAIToClaudeResponse(data, defaultModel = "gpt-4o") {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id || `call_${Date.now()}`,
        name: tc.function?.name || "tool_call",
        input: typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments || "{}") : (tc.function?.arguments || {}),
      });
    }
  }

  return {
    id: data.id || `msg_${Date.now()}`,
    type: "message",
    role: msg.role || "assistant",
    model: data.model || defaultModel,
    content,
    stop_reason: choice.finish_reason === "stop" || choice.finish_reason === "end_turn" ? "end_turn" : (choice.finish_reason === "tool_calls" ? "tool_use" : (choice.finish_reason || "end_turn")),
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Create TransformStream to translate SSE lines in real-time
 */
export function createResponseTransformStream(sourceFormat, targetFormat, model) {
  if (sourceFormat === targetFormat) {
    return new TransformStream();
  }

  let buffer = "";
  let currentEvent = null;
  let doneSent = false;
  const chunkId = `chatcmpl-${Date.now()}`;
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  let claudeStarted = false;
  let claudeUsage = null;
  let nextContentIndex = 0;
  let textBlockOpen = false;
  let textBlockIndex = null;
  const toolBlockIndexByOpenAI = new Map();

  function claudeEvent(type, data) {
    return textEncoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function ensureClaudeStart(controller) {
    if (claudeStarted) return;
    claudeStarted = true;
    controller.enqueue(claudeEvent("message_start", {
      type: "message_start",
      message: { id: chunkId, type: "message", role: "assistant", model: model || "unknown", content: [], stop_reason: null, usage: claudeUsage || { input_tokens: 0, output_tokens: 0 } },
    }));
  }

  function closeTextBlock(controller) {
    if (!textBlockOpen) return;
    controller.enqueue(claudeEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex }));
    textBlockOpen = false;
  }

  function closeToolBlocks(controller) {
    for (const idx of toolBlockIndexByOpenAI.values()) {
      controller.enqueue(claudeEvent("content_block_stop", { type: "content_block_stop", index: idx }));
    }
    toolBlockIndexByOpenAI.clear();
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      // Keep unfinished line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (trimmed.startsWith("event:")) {
          currentEvent = trimmed.slice(6).trim();
          continue;
        }

        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice(5).trim();

          // Translation from Claude SSE to OpenAI SSE
          if (sourceFormat === "claude" && targetFormat === "openai") {
            if (dataStr === "[DONE]") {
              if (!doneSent) {
                controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
                doneSent = true;
              }
              continue;
            }

            if (currentEvent === "ping") continue;

            try {
              const parsed = JSON.parse(dataStr);
              if (currentEvent === "content_block_delta") {
                const delta = parsed.delta || {};
                if (delta.text) {
                  const openAIChunk = {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model || "claude",
                    choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
                  };
                  controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                }
              } else if (currentEvent === "message_stop" || currentEvent === "content_block_stop") {
                if (currentEvent === "message_stop" && !doneSent) {
                  const finishChunk = {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model || "claude",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  };
                  controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
                  controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
                  doneSent = true;
                }
              } else if (currentEvent === "message_delta") {
                const stopReason = parsed.delta?.stop_reason;
                if (stopReason) {
                  const finishChunk = {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model || "claude",
                    choices: [{ index: 0, delta: {}, finish_reason: stopReason === "tool_use" ? "tool_calls" : "stop" }],
                  };
                  controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
                }
              }
            } catch {}
          }

          // Translation from OpenAI SSE to Claude SSE
          else if (sourceFormat === "openai" && targetFormat === "claude") {
            if (dataStr === "[DONE]") {
              if (!doneSent) {
                ensureClaudeStart(controller);
                closeTextBlock(controller);
                closeToolBlocks(controller);
                controller.enqueue(
                  claudeEvent("message_delta", {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    ...(claudeUsage ? { usage: claudeUsage } : {}),
                  })
                );
                controller.enqueue(claudeEvent("message_stop", { type: "message_stop" }));
                doneSent = true;
              }
              continue;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const choice = parsed.choices?.[0] || {};
              const delta = choice.delta || {};
              if (parsed.usage) claudeUsage = { input_tokens: parsed.usage.prompt_tokens || 0, output_tokens: parsed.usage.completion_tokens || 0 };
              ensureClaudeStart(controller);

              const deltaText = delta.content;
              if (deltaText) {
                if (!textBlockOpen) {
                  textBlockOpen = true;
                  textBlockIndex = nextContentIndex++;
                  controller.enqueue(claudeEvent("content_block_start", { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } }));
                }
                controller.enqueue(claudeEvent("content_block_delta", { type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: deltaText } }));
              }

              if (Array.isArray(delta.tool_calls)) {
                closeTextBlock(controller);
                for (const tc of delta.tool_calls) {
                  const key = tc.index ?? 0;
                  let idx = toolBlockIndexByOpenAI.get(key);
                  if (idx === undefined) {
                    idx = nextContentIndex++;
                    toolBlockIndexByOpenAI.set(key, idx);
                    controller.enqueue(claudeEvent("content_block_start", {
                      type: "content_block_start",
                      index: idx,
                      content_block: { type: "tool_use", id: tc.id || `toolu_${idx}`, name: tc.function?.name || "tool_call", input: {} },
                    }));
                  }
                  const args = tc.function?.arguments;
                  if (args) {
                    controller.enqueue(claudeEvent("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: args } }));
                  }
                }
              }

              if (choice.finish_reason) {
                closeTextBlock(controller);
                closeToolBlocks(controller);
                const stop = choice.finish_reason === "tool_calls" ? "tool_use" : (choice.finish_reason === "stop" ? "end_turn" : (choice.finish_reason === "length" ? "max_tokens" : "end_turn"));
                controller.enqueue(claudeEvent("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, ...(claudeUsage ? { usage: claudeUsage } : {}) }));
                controller.enqueue(claudeEvent("message_stop", { type: "message_stop" }));
                doneSent = true;
              }
            } catch {}
          }
        }
      }
    },

    flush(controller) {
      if (sourceFormat === "claude" && targetFormat === "openai") {
        if (!doneSent) {
          controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
          doneSent = true;
        }
      }
      if (sourceFormat === "openai" && targetFormat === "claude" && !doneSent) {
        ensureClaudeStart(controller);
        closeTextBlock(controller);
        closeToolBlocks(controller);
        controller.enqueue(claudeEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, ...(claudeUsage ? { usage: claudeUsage } : {}) }));
        controller.enqueue(claudeEvent("message_stop", { type: "message_stop" }));
        doneSent = true;
      }
    },
  });
}
