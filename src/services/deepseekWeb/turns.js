/**
 * One turn of a DeepSeek Web conversation.
 *
 * The chain store owns the mapping (account, purpose, client session,
 * conversation) -> web chat session plus its watermark. This module is the only
 * place that advances it: the turn runs under the chain lock, decides full
 * render or delta from the watermark, opens a session when needed, and marks the
 * chain dirty when the upstream state becomes unknown. Rendering the prompt and
 * solving the proof-of-work stay behind the transport contract.
 */
import { buildChainKey, conversationId, evaluateChain, resolveChainLimits } from "./chains.js";
export { chainStore } from "./chains.js";
import { parseReply } from "./parse.js";
export { parseReply } from "./parse.js";
export { checkSessionHealth, ensureSessionHealth, forgetSessionHealth, getSessionHealth } from "./health.js";
export { renderMessage, renderToolCatalog, renderTurn, toolNamesById, toolResultLimit } from "./prompt.js";

// Errors after which the chat itself is suspect (a refused parent, a reply that
// never materialised, a chat upstream now reads as too long). A fresh chat with
// the full history usually succeeds.
const RECOVERABLE = new Set([
  "upstream_rejected",
  "history_incomplete",
  "upstream_incomplete",
  "conversation_limit",
]);

// A reply with a call block the parser cannot read. The model may simply
// write the next attempt correctly, so one fresh chat is worth a try.
const MALFORMED_CALL = "malformed_tool_call";

function toolNamesOf(tools) {
  return new Set(tools.map((tool) => (tool?.function || tool)?.name).filter((name) => typeof name === "string"));
}

function abortError() {
  return new DOMException("Request aborted before the turn started", "AbortError");
}

/** Set ZENITH_DEEPSEEK_KEEP_SESSIONS=1 to leave retired chats in the web sidebar. */
function keepSessions() {
  return /^(1|true|yes)$/i.test(String(process.env.ZENITH_DEEPSEEK_KEEP_SESSIONS || "").trim());
}

/** Best effort: a chat that cannot be deleted only clutters the sidebar. */
function discardSession(transport, chatSessionId) {
  if (!chatSessionId || keepSessions() || typeof transport.deleteSession !== "function") return;
  Promise.resolve()
    .then(() => transport.deleteSession({ chatSessionId }))
    .catch(() => {});
}

/**
 * Run one turn against the upstream chat session.
 *
 * @param {object} deps
 * @param {object} deps.store     chain store (createChainStore instance)
 * @param {object} deps.transport object implementing createSession/complete
 * @param {object} deps.connection upstream connection row
 * @param {Array}  deps.messages  final OpenAI-format history sent upstream
 * @param {Array}  [deps.tools]   tool catalog, empty for auxiliary calls
 * @param {string} [deps.sessionKey] client session, keeps conversations apart
 * @param {"main"|"aux"} [deps.purpose]
 * @param {boolean} [deps.thinking] ask the web app for a reasoning turn
 * @param {Function} [deps.onReasoning] receives reasoning text as it streams
 * @param {AbortSignal|null} [deps.signal]
 */
export async function runChainTurn({
  store,
  transport,
  connection,
  messages,
  tools = [],
  sessionKey = null,
  purpose = "main",
  thinking = false,
  onReasoning = null,
  signal = null,
}) {
  const connectionId = connection?.id ?? null;
  const conversation = conversationId(messages);
  const key = buildChainKey({ connectionId, purpose, sessionKey, conversation });

  async function attempt(plan) {
    const limits = resolveChainLimits(connection);
    const existing = store.get(key);

    let chatSessionId = existing?.chatSessionId ?? null;
    let createdSession = false;
    if (plan.action === "reset" || !chatSessionId) {
      const session = await transport.createSession({ connection, sessionKey, signal });
      const retired = chatSessionId;
      chatSessionId = session?.chatSessionId ?? null;
      if (!chatSessionId) throw new Error("DeepSeek Web transport returned no chat session id");
      createdSession = true;
      const { evicted = [] } =
        store.register({
          connection,
          purpose,
          sessionKey,
          conversation,
          chatSessionId,
          count: 0,
          fingerprint: null,
          limits,
        }) || {};
      // The chat this chain used before, and any chain pushed out to make room,
      // will never be continued.
      discardSession(transport, retired);
      for (const chain of evicted) discardSession(transport, chain.chatSessionId);
    }

    // The client may have hung up while the session was being opened; drop the
    // unused chain so no empty web session is left behind.
    if (signal?.aborted) {
      if (createdSession) {
        store.remove(key);
        discardSession(transport, chatSessionId);
      }
      throw abortError();
    }

    // A freshly opened chat has no history server-side, so the full render is
    // the only correct prompt regardless of what the watermark said.
    const fullRender = plan.action !== "continue" || createdSession;

    store.setBusy(key, true);
    try {
      const reply = await transport.complete({
        connection,
        chatSessionId,
        parentMessageId: fullRender ? null : existing?.parentMessageId ?? null,
        mode: fullRender ? "full" : "delta",
        messages: fullRender ? messages : plan.delta,
        history: messages,
        tools,
        thinking,
        signal,
        onReasoning,
      });
      if (parseReply(reply?.text, { toolNames: toolNamesOf(tools) }).malformed) {
        const err = new Error("DeepSeek Web returned a tool call that could not be parsed");
        err.code = MALFORMED_CALL;
        err.status = 502;
        throw err;
      }

      store.markTurn(key, {
        count: plan.count,
        fingerprint: plan.fingerprint,
        toolsFingerprint: plan.toolsFingerprint,
        chatSessionId,
        parentMessageId: reply?.parentMessageId ?? null,
      });

      return {
        key,
        sessionKey,
        chatSessionId,
        reset: fullRender,
        reason: createdSession ? "new_session" : plan.reason,
        retried: Boolean(plan.retried),
        text: reply?.text ?? "",
        reasoning: reply?.reasoning ?? "",
        parentMessageId: reply?.parentMessageId ?? null,
      };
    } catch (err) {
      // The upstream may have consumed a partial turn; the next request must
      // start a fresh chat instead of appending to an unknown state.
      store.markDirty(key);
      err.deltaTurn = !fullRender;
      throw err;
    } finally {
      if (store.get(key)) store.setBusy(key, false);
    }
  }

  return store.withLock(key, async () => {
    if (signal?.aborted) throw abortError();
    const plan = evaluateChain(store.get(key), messages, tools);
    try {
      return await attempt(plan);
    } catch (err) {
      // Only a delta turn is retried: it failed on the chat's state, and the
      // full history on a new chat sidesteps that. A full render that failed
      // would fail the same way again.
      const recoverable = (err?.deltaTurn && RECOVERABLE.has(err?.code)) || err?.code === MALFORMED_CALL;
      if (!recoverable || signal?.aborted) throw err;
      return attempt({ ...plan, action: "reset", delta: messages, retried: true });
    }
  });
}
