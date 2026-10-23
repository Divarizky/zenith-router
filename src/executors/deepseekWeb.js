/**
 * Executor for the DeepSeek consumer web chat.
 *
 * The provider is declared with `format: "openai"`, so this executor receives an
 * OpenAI request body and returns an OpenAI response. Everything specific to the
 * web protocol (proof-of-work, prompt rendering, tag parsing) sits behind the
 * transport contract in services/deepseekWeb/transport.js; this file only wires
 * the chain store to it and shapes the response for the gateway.
 */
import { registerExecutor } from "./base.js";
import { chainStore } from "../services/deepseekWeb/chains.js";
import { resolveDeepSeekTransport } from "../services/deepseekWeb/transport.js";
import { runChainTurn } from "../services/deepseekWeb/turns.js";
import { parseReply } from "../services/deepseekWeb/parse.js";
import { estimateTokens } from "../services/usage.js";
import { resolveDeepSeekModel } from "../services/deepseekWeb/models.js";

const encoder = new TextEncoder();
const CLIENT_CLOSED = 499;

function errorResponse(status, message, code, headers = {}) {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code } }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function clientClosed() {
  return errorResponse(CLIENT_CLOSED, "Client closed the request before upstream responded", "client_closed_request");
}

function upstreamStatus(err) {
  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  if (err?.name === "TimeoutError") return 504;
  return 502;
}

/**
 * Turn the raw reply into an OpenAI message.
 *
 * The web chat answers with tag markup, so a reply may be plain text, a batch of
 * tool calls, or text followed by calls. `content` is null when the whole reply
 * was calls, and any markup is stripped by the parser before it can reach a
 * client as if it were prose.
 */
function assistantReply(result, tools = []) {
  const toolNames = new Set(tools.map((tool) => (tool?.function || tool)?.name).filter(Boolean));
  const { text, calls } = parseReply(result?.text, { toolNames });
  const message = { role: "assistant" };
  if (text) message.content = text;
  else message.content = calls.length > 0 ? null : "";
  if (result?.reasoning) message.reasoning_content = result.reasoning;
  if (calls.length > 0) message.tool_calls = calls;
  return { message, text, calls, finishReason: calls.length > 0 ? "tool_calls" : "stop" };
}

function estimateUsage(messages, tools, result, reply) {
  const prompt = estimateTokens(messages) + (tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / 4) : 0);
  const reasoning = estimateTokens(result?.reasoning || "");
  const completion =
    estimateTokens(reply.text) + reasoning + (reply.calls.length > 0 ? estimateTokens(JSON.stringify(reply.calls)) : 0);
  const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  // The usage tap records reasoning separately when it is reported here.
  if (reasoning > 0) usage.completion_tokens_details = { reasoning_tokens: reasoning };
  return usage;
}

function completionBody(reply, result, model, usage) {
  return {
    id: `chatcmpl-${result.chatSessionId || "deepseek"}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: reply.message, finish_reason: reply.finishReason }],
    usage,
  };
}

function chunkBase(result, model) {
  return {
    id: `chatcmpl-${result.chatSessionId || "deepseek"}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

const sseFrame = (frame) => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);

function reasoningChunk(base, text) {
  return { ...base, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] };
}

/**
 * The frames after any reasoning that already streamed: the rest of the
 * reasoning, the answer, the finish reason, and optionally usage.
 */
function closingFrames(reply, base, usage, includeUsage, streamedReasoning = "") {
  const answer = { role: "assistant" };
  if (reply.text) answer.content = reply.text;
  // History may hold more reasoning than the stream delivered; send only the rest.
  const reasoning = reply.message?.reasoning_content || "";
  let remainder = "";
  if (!streamedReasoning) remainder = reasoning;
  else if (reasoning.startsWith(streamedReasoning)) remainder = reasoning.slice(streamedReasoning.length);
  if (reply.calls.length > 0) {
    // OpenAI streams calls with their own index; the Claude and Responses
    // translators key their open blocks off it.
    answer.tool_calls = reply.calls.map((call, index) => ({
      index,
      id: call.id,
      type: call.type,
      function: call.function,
    }));
  }
  const frames = [
    ...(remainder ? [reasoningChunk(base, remainder)] : []),
    { ...base, choices: [{ index: 0, delta: answer, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason }] },
  ];
  if (includeUsage) frames.push({ ...base, choices: [], usage });
  return frames;
}

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };

function roleChunk(base) {
  return { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] };
}

function sseResponse(reply, result, model, usage, includeUsage) {
  const base = chunkBase(result, model);
  // Thinking models emit their reasoning first; clients that understand the
  // OpenAI reasoning extension render it separately from the answer.
  const frames = [roleChunk(base), ...closingFrames(reply, base, usage, includeUsage)];

  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(sseFrame(frame));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

export class DeepSeekWebExecutor {
  constructor({ transportResolver = resolveDeepSeekTransport, store = chainStore } = {}) {
    this.transportResolver = transportResolver;
    this.store = store;
  }

  async execute({ body, connection, signal = null, stream = false, targetModel = "", sessionKey = null, proxyUrl = null }) {
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return errorResponse(400, "Request body is not valid JSON", "invalid_request");
    }

    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    if (messages.length === 0) {
      return errorResponse(400, "messages must contain at least one entry", "invalid_request");
    }

    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const purpose = tools.length > 0 ? "main" : "aux";
    const model = targetModel || payload.model || "deepseek-chat";
    // `deepseek-reasoner` is the same endpoint with thinking turned on.
    const thinking = resolveDeepSeekModel(model).thinking === true;

    const runTurn = (onReasoning) =>
      runChainTurn({
        store: this.store,
        transport: this.transportResolver(connection, { proxyUrl }),
        connection,
        messages,
        tools,
        sessionKey,
        purpose,
        thinking,
        onReasoning,
        signal,
      });
    const failure = (err) => {
      if (signal?.aborted || err?.name === "AbortError") return clientClosed();
      const headers = err?.authExpired ? { "X-Zenith-Auth-Expired": "1" } : {};
      return errorResponse(
        upstreamStatus(err),
        err?.message || "DeepSeek Web upstream failed",
        err?.code || "deepseek_web_error",
        headers
      );
    };
    const includeUsage = Boolean(payload.stream_options?.include_usage);

    if (stream && thinking) return this.streamThinking({ runTurn, failure, messages, tools, model, includeUsage });

    let result;
    try {
      result = await runTurn(null);
    } catch (err) {
      return failure(err);
    }

    const reply = assistantReply(result, tools);
    const usage = estimateUsage(messages, tools, result, reply);
    if (stream) return sseResponse(reply, result, model, usage, includeUsage);
    return new Response(JSON.stringify(completionBody(reply, result, model, usage)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Stream reasoning as it arrives, then the answer.
   *
   * The answer is held back until the turn ends because tool calls arrive as
   * text tags that must be parsed out first; reasoning carries no tags. The
   * response opens only with the first reasoning piece, so anything that fails
   * before that (auth, PoW, a refused turn) still returns a proper status and
   * the gateway can fail over. A failure after that point arrives as an error
   * event inside the stream.
   */
  async streamThinking({ runTurn, failure, messages, tools, model, includeUsage }) {
    const pending = [];
    let streamed = "";
    let sink = null;
    let opened;
    const firstPiece = new Promise((resolve) => {
      opened = resolve;
    });
    const turn = runTurn((delta) => {
      streamed += delta;
      if (sink) sink(delta);
      else {
        pending.push(delta);
        opened();
      }
    });

    const first = await Promise.race([firstPiece.then(() => "streaming"), turn.then(() => "done", () => "done")]);
    if (first === "done") {
      let result;
      try {
        result = await turn;
      } catch (err) {
        return failure(err);
      }
      const reply = assistantReply(result, tools);
      return sseResponse(reply, result, model, estimateUsage(messages, tools, result, reply), includeUsage);
    }

    const base = chunkBase({ chatSessionId: `live-${Date.now().toString(36)}` }, model);
    let closed = false;
    const body = new ReadableStream({
      start(controller) {
        const send = (frame) => {
          if (!closed) controller.enqueue(sseFrame(frame));
        };
        send(roleChunk(base));
        for (const delta of pending.splice(0)) send(reasoningChunk(base, delta));
        sink = (delta) => send(reasoningChunk(base, delta));

        turn
          .then(
            (result) => {
              sink = null;
              const reply = assistantReply(result, tools);
              const usage = estimateUsage(messages, tools, result, reply);
              for (const frame of closingFrames(reply, base, usage, includeUsage, streamed)) send(frame);
            },
            (err) => {
              sink = null;
              send({
                error: {
                  message: err?.message || "DeepSeek Web upstream failed",
                  type: "upstream_error",
                  code: err?.code || "deepseek_web_error",
                },
              });
            }
          )
          .finally(() => {
            if (closed) return;
            closed = true;
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          });
      },
      cancel() {
        closed = true;
        sink = null;
      },
    });

    return new Response(body, { status: 200, headers: SSE_HEADERS });
  }
}

// Registry imports this module while chains.js is still evaluating (chains ->
// trafficGuard -> providers -> registry -> here), so the shared instance is
// created on first use instead of at module scope.
let sharedExecutor = null;
registerExecutor("deepseek-web", {
  execute(args) {
    sharedExecutor ??= new DeepSeekWebExecutor();
    return sharedExecutor.execute(args);
  },
});
