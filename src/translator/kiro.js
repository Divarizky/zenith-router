import { randomUUID } from "node:crypto";
import { decodeEventStreamBuffer } from "../utils/eventstream.js";

/**
 * Translate OpenAI Chat Completions request to AWS CodeWhisperer (Kiro) format
 */
export function openaiToKiroRequest(body, targetModel, profileArn = "") {
  if (!body) return {};

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const history = [];
  let currentUserText = "";
  const tools = [];
  const toolResults = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    const isLast = i === messages.length - 1;

    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      if (text) {
        currentUserText = currentUserText ? `${text}\n\n${currentUserText}` : text;
      }
      continue;
    }

    if (msg.role === "tool") {
      let content = "";
      try {
        content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      } catch {
        content = String(msg.content);
      }
      toolResults.push({
        toolUseId: msg.tool_call_id || "",
        content: [{ text: content }],
        status: "success",
      });
      continue;
    }

    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("\n") : "";
      if (isLast) {
        currentUserText = currentUserText ? `${currentUserText}\n\n${text}` : text;
      } else {
        history.push({
          userInputMessage: {
            content: text,
          },
        });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : "";
      history.push({
        assistantResponseMessage: {
          content: text,
        },
      });
    }
  }

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t.type === "function" && t.function) {
        tools.push({
          toolSpecification: {
            name: t.function.name,
            description: t.function.description || "",
            inputSchema: {
              json: t.function.parameters || {},
            },
          },
        });
      }
    }
  }

  const currentMessageContext = {};
  if (tools.length > 0) currentMessageContext.tools = tools;
  if (toolResults.length > 0) currentMessageContext.toolResults = toolResults;

  const conversationState = {
    conversationId: randomUUID(),
    currentMessage: {
      userInputMessage: {
        content: currentUserText || "Hello",
        modelId: targetModel || body.model || "claude-3-7-sonnet",
        origin: "KIRO_CLI",
        ...(Object.keys(currentMessageContext).length > 0 ? { userInputMessageContext: currentMessageContext } : {}),
      },
    },
    chatTriggerType: "MANUAL",
  };

  if (history.length > 0) {
    conversationState.history = history;
  }

  const payload = { conversationState };
  if (profileArn) {
    payload.profileArn = profileArn;
  }

  return payload;
}

/**
 * Transform binary AWS EventStream from Kiro into OpenAI SSE chunks
 */
export function createKiroToOpenAITransformStream(model = "kiro") {
  let pendingBuffer = new Uint8Array(0);
  const textEncoder = new TextEncoder();
  const responseId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  let currentToolIndex = 0;

  return new TransformStream({
    transform(chunk, controller) {
      let combined;
      if (chunk instanceof Uint8Array) {
        combined = new Uint8Array(pendingBuffer.length + chunk.length);
        combined.set(pendingBuffer, 0);
        combined.set(chunk, pendingBuffer.length);
      } else {
        const bytes = new Uint8Array(chunk);
        combined = new Uint8Array(pendingBuffer.length + bytes.length);
        combined.set(pendingBuffer, 0);
        combined.set(bytes, pendingBuffer.length);
      }

      const { events, remainder } = decodeEventStreamBuffer(combined);
      pendingBuffer = remainder;

      for (const ev of events) {
        const payload = ev.payload;
        if (!payload) continue;

        // assistantResponseEvent
        if (payload.assistantResponseEvent?.content) {
          const content = payload.assistantResponseEvent.content;
          const openAIChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
        }

        // toolUseEvent
        if (payload.toolUseEvent) {
          const t = payload.toolUseEvent;
          const toolCallId = t.toolUseId || `call_${randomUUID().slice(0, 8)}`;
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
                      index: currentToolIndex++,
                      id: toolCallId,
                      type: "function",
                      function: {
                        name: t.name || "",
                        arguments: typeof t.input === "string" ? t.input : JSON.stringify(t.input || {}),
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
    },
    flush(controller) {
      const finalChunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: currentToolIndex > 0 ? "tool_calls" : "stop",
          },
        ],
      };
      controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`));
    },
  });
}
