import { randomUUID } from "node:crypto";
import { decodeEventStreamBuffer } from "../utils/eventstream.js";

// Concatenate every system message (usually just one preamble) so the Kiro
// first user turn keeps the full agent instructions.
function collectSystemText(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg?.role === "system" && typeof msg.content === "string" && msg.content) parts.push(msg.content);
  }
  return parts.join("\n\n");
}

/**
 * Translate OpenAI Chat Completions request to AWS CodeWhisperer (Kiro) format
 */
export function openaiToKiroRequest(body, targetModel, profileArn = "") {
  if (!body) return {};

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const history = [];
  let currentUserText = "";
  let currentUserContext = null;
  const tools = [];

  // Tool results belong to the user turn that answers the assistant which
  // issued the calls, so they ride the next user entry (or the current
  // message when nothing follows). Entries strictly alternate user and
  // assistant; consecutive assistant turns are merged.
  let pendingToolResults = [];
  let sawFirstUserTurn = false;

  const attachResults = (userInputMessage) => {
    if (pendingToolResults.length === 0) return;
    userInputMessage.userInputMessageContext = { toolResults: pendingToolResults };
    pendingToolResults = [];
  };

  const pushAssistantTurn = (text, toolCalls) => {
    const toolUses = [];
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        let args = {};
        try {
          args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
        } catch {
          args = {};
        }
        toolUses.push({
          toolUseId: tc.id || "",
          name: tc.function?.name || "",
          input: args,
        });
      }
    }
    const last = history[history.length - 1];
    if (last?.assistantResponseMessage && !toolUses.length && !text) return;
    if (last?.assistantResponseMessage) {
      // Merge back-to-back assistant turns so history keeps alternating.
      if (text) last.assistantResponseMessage.content = [last.assistantResponseMessage.content, text].filter(Boolean).join("\n");
      if (toolUses.length > 0) {
        last.assistantResponseMessage.toolUses = [...(last.assistantResponseMessage.toolUses || []), ...toolUses];
      }
      return;
    }
    history.push({
      assistantResponseMessage: {
        content: text,
        ...(toolUses.length > 0 ? { toolUses } : {}),
      },
    });
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;

    const isLast = i === messages.length - 1;

    if (msg.role === "system") {
      // System prompt joins the first user turn, mirroring how Kiro CLI folds
      // the agent preamble into the opening message rather than a separate role.
      continue;
    }

    if (msg.role === "tool") {
      let content = "";
      try {
        content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      } catch {
        content = String(msg.content);
      }
      pendingToolResults.push({
        toolUseId: msg.tool_call_id || "",
        content: [{ text: content }],
        status: "success",
      });
      continue;
    }

    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c?.text || "").join("\n") : "";
      // Prepend the system preamble to the very first user turn only.
      let content = text;
      if (!sawFirstUserTurn) {
        sawFirstUserTurn = true;
        const sysText = collectSystemText(messages);
        if (sysText) content = `${sysText}\n\n${text}`;
      }
      // Images have no verified Kiro field; their text survives, the bytes do
      // not (documented limitation, not silent corruption).
      const userInputMessage = { content };
      attachResults(userInputMessage);
      if (isLast) {
        currentUserText = content;
        if (userInputMessage.userInputMessageContext) {
          currentUserContext = userInputMessage.userInputMessageContext;
        }
      } else {
        history.push({ userInputMessage });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : "";
      pushAssistantTurn(text, msg.tool_calls);
    }
  }

  // Trailing tool results (no user text after them) sit on the current turn.
  const currentToolResults = pendingToolResults;
  pendingToolResults = [];

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
  if (currentUserContext?.toolResults) currentMessageContext.toolResults = currentUserContext.toolResults;
  if (currentToolResults.length > 0) currentMessageContext.toolResults = currentToolResults;

  const conversationState = {
    conversationId: randomUUID(),
    currentMessage: {
      userInputMessage: {
        // No fabricated greeting: a pure tool-result turn carries empty text
        // with the results in context. "Hello" would reach the model as a
        // fake user message and corrupt its context.
        content: currentUserText,
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
  const toolCallById = new Map();

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

        // toolUseEvent: Kiro streams one tool call across several fragments that
        // share a toolUseId. Fragments are merged by id into a single OpenAI
        // tool call: the first fragment opens it, later ones append arguments.
        if (payload.toolUseEvent) {
          const t = payload.toolUseEvent;
          const toolCallId = t.toolUseId || `call_${randomUUID().slice(0, 8)}`;
          // Stop/intermediate fragments can omit `input`; only fragments that
          // carry one append to the argument buffer.
          const fragment = t.input === undefined ? "" : typeof t.input === "string" ? t.input : JSON.stringify(t.input);
          let entry = toolCallById.get(toolCallId);
          if (!entry) {
            entry = { index: currentToolIndex++, args: "" };
            toolCallById.set(toolCallId, entry);
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
                        index: entry.index,
                        id: toolCallId,
                        type: "function",
                        function: { name: t.name || "", arguments: "" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
          }
          if (fragment) {
            entry.args += fragment;
            const deltaChunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [{ index: entry.index, function: { arguments: fragment } }],
                  },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(deltaChunk)}\n\n`));
          }
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
