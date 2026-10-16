function claudeContentToOpenAIFinish(content, stopReason) {
  let text = "";
  let reasoning = "";
  const toolCalls = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c) continue;
      if (c.type === "text") text += c.text || "";
      if (c.type === "thinking" && typeof c.thinking === "string") reasoning += c.thinking;
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
  if (reasoning) message.reasoning_content = reasoning;
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

  // Anthropic splits input into fresh + cache buckets; OpenAI folds them into
  // one prompt_tokens with a cached detail counter.
  const inputTokens = data.usage?.input_tokens || 0;
  const cacheRead = data.usage?.cache_read_input_tokens || 0;
  const cacheCreation = data.usage?.cache_creation_input_tokens || 0;
  const promptTokens = inputTokens + cacheRead + cacheCreation;
  const completionTokens = data.usage?.output_tokens || 0;

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
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(cacheRead > 0 ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
    },
  };
}

/**
 * Normalize common parameter alias hallucinations from non-Anthropic models
 * when calling Claude Code built-in tools. Names are matched exactly as Claude
 * Code declares them, so clients with their own lowercase `read`/`write` tools
 * (and their own parameter names) are left alone.
 */
export function normalizeClaudeToolInput(toolName, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const name = String(toolName || "");

  if (name === "Bash") {
    if (args.command === undefined) {
      const alt = args.cmd ?? args.script ?? args.command_line ?? args.commandLine ?? args.input ?? args.code;
      if (typeof alt === "string") args.command = alt;
    }
    for (const k of ["cmd", "script", "command_line", "commandLine", "input", "code"]) {
      if (args.command !== undefined && k in args) delete args[k];
    }
  } else if (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit") {
    if (args.file_path === undefined) {
      const alt = args.path ?? args.file ?? args.filepath ?? args.filePath ?? args.filename;
      if (typeof alt === "string") args.file_path = alt;
    }
    for (const k of ["path", "file", "filepath", "filePath", "filename"]) {
      if (args.file_path !== undefined && k in args) delete args[k];
    }
    if (name === "Edit") {
      if (args.old_string === undefined && typeof args.old_text === "string") args.old_string = args.old_text;
      if (args.new_string === undefined && typeof args.new_text === "string") args.new_string = args.new_text;
      delete args.old_text;
      delete args.new_text;
    }
    if (name === "Write") {
      if (args.content === undefined && typeof args.text === "string") args.content = args.text;
      delete args.text;
    }
  } else if (name === "Glob" || name === "Grep") {
    // Grep has a real `glob` parameter (file filter), so `glob` is an alias for
    // the pattern only on the Glob tool.
    const aliases = name === "Glob" ? ["query", "search", "regex", "glob"] : ["query", "search", "regex"];
    if (args.pattern === undefined) {
      const alt = aliases.map((k) => args[k]).find((v) => typeof v === "string");
      if (alt !== undefined) args.pattern = alt;
    }
    for (const k of aliases) {
      if (args.pattern !== undefined && k in args) delete args[k];
    }
    if (args.path === undefined) {
      const alt = args.dir ?? args.directory;
      if (typeof alt === "string") args.path = alt;
    }
    for (const k of ["dir", "directory"]) {
      if (args.path !== undefined && k in args) delete args[k];
    }
  }

  return args;
}

export function sanitizeClaudeToolArgs(toolName, argsJson) {
  try {
    const parsed = JSON.parse(argsJson);
    normalizeClaudeToolInput(toolName, parsed);
    return JSON.stringify(parsed);
  } catch {
    return argsJson;
  }
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
      let parsed = {};
      try {
        parsed =
          typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments || "{}")
            : tc.function?.arguments || {};
      } catch {
        parsed = {};
      }
      normalizeClaudeToolInput(tc.function?.name || "", parsed);
      content.push({
        type: "tool_use",
        id: tc.id || `call_${Date.now()}`,
        name: tc.function?.name || "tool_call",
        input: parsed,
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
    usage: openAIUsageToClaude(data.usage),
  };
}

/**
 * OpenAI prompt_tokens includes cached tokens; Claude keeps them out of
 * input_tokens and reports them in cache_read_input_tokens.
 */
function openAIUsageToClaude(usage) {
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  return {
    input_tokens: Math.max(0, (usage?.prompt_tokens || 0) - cached),
    output_tokens: usage?.completion_tokens || 0,
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
  };
}

/**
 * Create TransformStream to translate SSE lines in real-time
 */
export function createResponseTransformStream(sourceFormat, targetFormat, model, opts = {}) {
  if (sourceFormat === targetFormat) {
    return new TransformStream();
  }

  // OpenAI protocol: the final usage chunk (choices: []) is only sent when the
  // client asked for it via stream_options.include_usage.
  const includeUsage = opts.includeUsage === true;
  let buffer = "";
  let currentEvent = null;
  let doneSent = false;
  // finish_reason already emitted by the message_delta handler (real
  // stop_reason); message_stop only sends the [DONE] sentinel.
  let finishSent = false;
  const chunkId = `chatcmpl-${Date.now()}`;
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  let claudeStarted = false;
  let claudeUsage = null;
  let claudeInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let nextContentIndex = 0;
  let textBlockOpen = false;
  let textBlockIndex = null;
  let thinkingBlockOpen = false;
  let thinkingBlockIndex = null;
  const toolBlockIndexByOpenAI = new Map();
  const toolNamesByIndex = new Map();
  const toolArgBuffers = new Map();

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

  function closeThinkingBlock(controller) {
    if (!thinkingBlockOpen) return;
    controller.enqueue(claudeEvent("content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex }));
    thinkingBlockOpen = false;
    thinkingBlockIndex = null;
  }

  function closeToolBlocks(controller) {
    for (const [key, idx] of toolBlockIndexByOpenAI.entries()) {
      const rawArgs = toolArgBuffers.get(idx);
      if (rawArgs !== undefined && rawArgs !== "") {
        const sanitized = sanitizeClaudeToolArgs(toolNamesByIndex.get(idx) || "", rawArgs);
        controller.enqueue(
          claudeEvent("content_block_delta", {
            type: "content_block_delta",
            index: idx,
            delta: { type: "input_json_delta", partial_json: sanitized },
          })
        );
      }
      controller.enqueue(claudeEvent("content_block_stop", { type: "content_block_stop", index: idx }));
    }
    toolBlockIndexByOpenAI.clear();
    toolNamesByIndex.clear();
    toolArgBuffers.clear();
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
              if (currentEvent === "message_start") {
                const u = parsed.message?.usage;
                if (typeof u?.input_tokens === "number") claudeInputTokens = u.input_tokens;
                if (typeof u?.cache_read_input_tokens === "number") cachedInputTokens = u.cache_read_input_tokens;
              } else if (currentEvent === "content_block_delta") {
                const delta = parsed.delta || {};
                if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                  const openAIChunk = {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model || "claude",
                    choices: [{ index: 0, delta: { reasoning_content: delta.thinking }, finish_reason: null }],
                  };
                  controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
                } else if (delta.text) {
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
                  if (!finishSent) {
                    // Fallback for upstreams that end without a stop_reason:
                    // close the choice as a plain stop.
                    const finishChunk = {
                      id: chunkId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model || "claude",
                      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    };
                    controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
                    finishSent = true;
                  }
                  controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
                  doneSent = true;
                }
              } else if (currentEvent === "message_delta") {
                const stopReason = parsed.delta?.stop_reason;
                if (typeof parsed.usage?.output_tokens === "number") claudeUsage = parsed.usage;
                if (typeof parsed.usage?.cache_creation_input_tokens === "number") {
                  cacheCreationTokens = parsed.usage.cache_creation_input_tokens;
                }
                if (stopReason) {
                  // OpenAI ordering: finish_reason chunk first (with the real
                  // stop reason), then the final usage chunk (choices: [])
                  // right before [DONE]; message_stop only sends [DONE].
                  const finishChunk = {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model || "claude",
                    choices: [{ index: 0, delta: {}, finish_reason: stopReason === "tool_use" ? "tool_calls" : "stop" }],
                  };
                  controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
                  finishSent = true;
                  if (includeUsage) {
                    const inputTokens = (claudeUsage?.input_tokens || 0) || claudeInputTokens;
                    const promptTokens = inputTokens + cachedInputTokens + cacheCreationTokens;
                    const completionTokens = claudeUsage?.output_tokens || 0;
                    const usageChunk = {
                      id: chunkId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model || "claude",
                      choices: [],
                      usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens,
                        ...(cachedInputTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedInputTokens } } : {}),
                      },
                    };
                    controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
                  }
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
              if (parsed.usage) claudeUsage = openAIUsageToClaude(parsed.usage);
              ensureClaudeStart(controller);

              const deltaText = delta.content;
              if (deltaText) {
                if (thinkingBlockOpen) closeThinkingBlock(controller);
                if (!textBlockOpen) {
                  textBlockOpen = true;
                  textBlockIndex = nextContentIndex++;
                  controller.enqueue(claudeEvent("content_block_start", { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } }));
                }
                controller.enqueue(claudeEvent("content_block_delta", { type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: deltaText } }));
              }

              // reasoning_content from a reasoning-aware chat upstream becomes
              // ONE Claude thinking block per response: deltas accumulate into
              // the open block, and a text block is closed before thinking
              // starts (Anthropic forbids interleaved open blocks). The block
              // carries no signature; Zenith drops thinking blocks from
              // history on the next pivot, so unsigned blocks never reach a
              // real Anthropic endpoint.
              if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                if (!thinkingBlockOpen) {
                  if (textBlockOpen) {
                    controller.enqueue(claudeEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex }));
                    textBlockOpen = false;
                    textBlockIndex = null;
                  }
                  thinkingBlockOpen = true;
                  thinkingBlockIndex = nextContentIndex++;
                  controller.enqueue(claudeEvent("content_block_start", { type: "content_block_start", index: thinkingBlockIndex, content_block: { type: "thinking", thinking: "" } }));
                }
                controller.enqueue(claudeEvent("content_block_delta", { type: "content_block_delta", index: thinkingBlockIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_content } }));
              }

              if (Array.isArray(delta.tool_calls)) {
                closeTextBlock(controller);
                closeThinkingBlock(controller);
                for (const tc of delta.tool_calls) {
                  const key = tc.index ?? 0;
                  let idx = toolBlockIndexByOpenAI.get(key);
                  if (idx === undefined) {
                    idx = nextContentIndex++;
                    toolBlockIndexByOpenAI.set(key, idx);
                    toolNamesByIndex.set(idx, tc.function?.name || "tool_call");
                    toolArgBuffers.set(idx, "");
                    controller.enqueue(claudeEvent("content_block_start", {
                      type: "content_block_start",
                      index: idx,
                      content_block: { type: "tool_use", id: tc.id || `toolu_${idx}`, name: tc.function?.name || "tool_call", input: {} },
                    }));
                  }
                  if (tc.function?.name) {
                    toolNamesByIndex.set(idx, tc.function.name);
                  }
                  const args = tc.function?.arguments;
                  if (args) {
                    toolArgBuffers.set(idx, (toolArgBuffers.get(idx) || "") + args);
                  }
                }
              }

              if (choice.finish_reason) {
                closeTextBlock(controller);
                closeThinkingBlock(controller);
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
        closeThinkingBlock(controller);
        closeToolBlocks(controller);
        controller.enqueue(claudeEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, ...(claudeUsage ? { usage: claudeUsage } : {}) }));
        controller.enqueue(claudeEvent("message_stop", { type: "message_stop" }));
        doneSent = true;
      }
    },
  });
}
