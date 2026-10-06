/**
 * Convert Claude message JSON to OpenAI chat.completion JSON
 */
export function claudeToOpenAIResponse(data, defaultModel = "claude") {
  const content = Array.isArray(data.content)
    ? data.content.map((c) => c.text || "").join("")
    : (typeof data.content === "string" ? data.content : "");

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model || defaultModel,
    choices: [
      {
        index: 0,
        message: {
          role: data.role || "assistant",
          content,
        },
        finish_reason: data.stop_reason === "end_turn" ? "stop" : (data.stop_reason || "stop"),
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
  const contentText = choice.message?.content || "";

  return {
    id: data.id || `msg_${Date.now()}`,
    type: "message",
    role: choice.message?.role || "assistant",
    model: data.model || defaultModel,
    content: [{ type: "text", text: contentText }],
    stop_reason: choice.finish_reason === "stop" ? "end_turn" : (choice.finish_reason || "end_turn"),
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
  const chunkId = `chatcmpl-${Date.now()}`;
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += textDecoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      // Keep unfinished line in buffer
      buffer = lines.pop() || "";

      let currentEvent = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          currentEvent = null;
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
            if (currentEvent === "content_block_delta") {
              try {
                const parsed = JSON.parse(dataStr);
                const text = parsed.delta?.text || "";
                if (text) {
                  const openAIChunk = {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model || "claude",
                    choices: [
                      {
                        index: 0,
                        delta: { content: text },
                        finish_reason: null,
                      },
                    ],
                  };
                  controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                }
              } catch {}
            } else if (currentEvent === "message_stop") {
              const finishChunk = {
                id: chunkId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model || "claude",
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              };
              controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
              controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
            }
          }

          // Translation from OpenAI SSE to Claude SSE
          else if (sourceFormat === "openai" && targetFormat === "claude") {
            if (dataStr === "[DONE]") {
              controller.enqueue(
                textEncoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                  })}\n\n`
                )
              );
              controller.enqueue(
                textEncoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
              );
            } else {
              try {
                const parsed = JSON.parse(dataStr);
                const deltaText = parsed.choices?.[0]?.delta?.content;
                if (deltaText) {
                  const claudeEvent = {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: deltaText },
                  };
                  controller.enqueue(
                    textEncoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify(claudeEvent)}\n\n`
                    )
                  );
                }
              } catch {}
            }
          }
        }
      }
    },

    flush(controller) {
      if (sourceFormat === "claude" && targetFormat === "openai") {
        controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
      }
    },
  });
}
