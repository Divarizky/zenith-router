/**
 * HTTP transport for the DeepSeek consumer web chat.
 *
 * One turn is: ask for a PoW challenge, solve it, POST the completion, then read
 * the authoritative text back from history_messages. The SSE stream names the
 * new message (`event: ready`), so history is matched by id rather than by
 * position, and the stream text stands in when history lags behind.
 *
 * Upstream reports most failures as HTTP 200 with a JSON body, e.g.
 * `{"code":40003,"msg":"INVALID_TOKEN"}` or
 * `{"code":0,"data":{"biz_code":26,"biz_msg":"invalid message id"}}`. Those
 * bodies are turned into errors before anything else reads the response.
 *
 * Chain mapping, watermarking, and single-flight live in turns.js; this module
 * knows nothing about conversations across requests.
 */
import { proxyFetch } from "../../executors/proxy.js";
import { encodePowHeader, isChallengeExpired, POW_TARGET_PATH, solvePowChallenge } from "./pow.js";
import { renderTurn } from "./prompt.js";
import { normalizeSessionToken } from "./token.js";

export const DEEPSEEK_BASE = "https://chat.deepseek.com";

/**
 * Upstream root. The override exists for local bridges and for the end-to-end
 * suite, which serves the same endpoints on a loopback port.
 */
export function deepseekBaseUrl() {
  const override = String(process.env.ZENITH_DEEPSEEK_BASE_URL || "").trim();
  return override ? override.replace(/\/+$/, "") : DEEPSEEK_BASE;
}
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0";
const DEFAULT_TIMEOUT_MS = 300000;
const HISTORY_ATTEMPTS = 2;
const HISTORY_RETRY_DELAY_MS = 150;
const MAX_WALK_DEPTH = 8;
const MAX_NOTICES = 4;
const MAX_NOTICE_HINT = 160;
// Seen live: 40002 "Missing Token", 40003 "INVALID_TOKEN" / "Authorization Failed".
const AUTH_CODES = new Set([40002, 40003]);

export class DeepSeekWebError extends Error {
  constructor(message, { status = 502, code = "deepseek_web_error", authExpired = false, bizCode = null } = {}) {
    super(message);
    this.name = "DeepSeekWebError";
    this.status = status;
    this.code = code;
    this.authExpired = authExpired;
    this.bizCode = bizCode;
  }
}

/**
 * The error an HTTP 200 JSON body carries, or null when the body is a success
 * (or not JSON at all, like the completion stream).
 */
export function businessError(text) {
  const body = String(text || "").trimStart();
  if (!body.startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const code = Number(parsed?.code ?? 0);
  if (AUTH_CODES.has(code)) {
    return new DeepSeekWebError(`DeepSeek Web session rejected: ${parsed?.msg || code}`, {
      status: 401,
      code: "invalid_token",
      authExpired: true,
    });
  }
  if (code) {
    return new DeepSeekWebError(`DeepSeek Web refused the request (code ${code}): ${parsed?.msg || "no message"}`, {
      code: "upstream_rejected",
    });
  }
  const bizCode = Number(parsed?.data?.biz_code ?? 0);
  if (bizCode) {
    return new DeepSeekWebError(
      `DeepSeek Web refused the request (biz_code ${bizCode}): ${parsed?.data?.biz_msg || "no message"}`,
      { code: "upstream_rejected", bizCode }
    );
  }
  return null;
}

function normalizeCookies(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .filter((cookie) => cookie && cookie.name)
      .map((cookie) => `${cookie.name}=${cookie.value ?? ""}`)
      .join("; ");
  }
  if (typeof raw === "object") {
    return Object.entries(raw)
      .map(([name, value]) => `${name}=${value ?? ""}`)
      .join("; ");
  }
  return "";
}

function sessionOf(connection) {
  const creds = connection?.credentials || {};
  const token = normalizeSessionToken(creds.token || creds.user_token || creds.access_token);
  if (!token) {
    throw new DeepSeekWebError("DeepSeek Web account has no session token", {
      status: 401,
      code: "invalid_token",
      authExpired: true,
    });
  }
  return { token, cookies: normalizeCookies(creds.cookies) };
}

function bodyMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return (
      parsed?.msg ||
      parsed?.message ||
      parsed?.error?.message ||
      parsed?.data?.biz_data?.message ||
      text.slice(0, 200)
    );
  } catch {
    return text.slice(0, 200) || "empty response body";
  }
}

function errorForStatus(status, text) {
  const message = bodyMessage(text);
  if (status === 401 || status === 403) {
    return new DeepSeekWebError(`DeepSeek Web session rejected: ${message}`, {
      status: 401,
      code: "invalid_token",
      authExpired: true,
    });
  }
  if (status === 429) {
    return new DeepSeekWebError(`DeepSeek Web rate limited: ${message}`, { status: 429, code: "rate_limit_exceeded" });
  }
  return new DeepSeekWebError(`DeepSeek Web upstream failed (HTTP ${status}): ${message}`, {
    status: 502,
    code: "upstream_error",
  });
}

/**
 * Fragment kinds the web app emits. Upstream spells reasoning as `THINK` (seen
 * live), while older captures and fixtures use `THINKING`; both mean the same.
 */
const FRAGMENT_KINDS = { RESPONSE: "RESPONSE", THINKING: "THINKING", THINK: "THINKING" };
const CONTENT_PATH = /^response\/fragments\/(-?\d+)\/content$/;

/** Fragments arrive either as deltas or as a growing cumulative string. */
function mergeText(current, next) {
  if (!next) return current;
  if (next.startsWith(current)) return next;
  return current + next;
}

/** One short string from a payload: the text upstream uses to explain itself. */
const HINT_KEYS = new Set(["msg", "message", "error_msg", "biz_msg", "detail", "reason", "tips", "error", "status_hint"]);
// A bookkeeping event (title, close) puts its own text in `content`; a message
// frame uses `content` for the reply itself, so it is only read from the first.
const NOTICE_KEYS = new Set([...HINT_KEYS, "content"]);

function clipHint(value) {
  const clean = String(value).replace(/\s+/g, " ").trim();
  return clean.length > MAX_NOTICE_HINT ? `${clean.slice(0, MAX_NOTICE_HINT)}…` : clean;
}

function hintOf(value, depth = 0, keys = HINT_KEYS) {
  if (!value || typeof value !== "object" || depth > MAX_WALK_DEPTH) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = hintOf(item, depth + 1, keys);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item.trim() && keys.has(key.toLowerCase())) return clipHint(item);
    const hit = hintOf(item, depth + 1, keys);
    if (hit) return hit;
  }
  return null;
}

// Upstream spells the causes that matter for an empty reply in English or Chinese.
const FILTER_STATUS = /^(?:CONTENT_FILTER|CONTENT_FILTERED|SENSITIVE|BLOCKED)$/i;
const LIMIT_HINT = /(too long|too (?:many (?:messages|tokens|characters|words))|context (?:length|window|limit)|maximum (?:context|length)|exceed|limit reached|conversation.{0,24}(?:long|limit)|上限|过长|太长|超出|已达到)/i;
const RATE_HINT = /(rate limit|too many requests|frequent|slow down|busy|频繁|稍后|请求过多)/i;

/** Human-readable shape of a stream that carried no text. */
function describeStream({ status = null, notices = [], history = null } = {}) {
  const parts = [`status=${status || "none"}`];
  if (notices.length > 0) {
    const counts = new Map();
    for (const notice of notices) counts.set(notice.event, (counts.get(notice.event) || 0) + 1);
    parts.push(`events=${[...counts].map(([event, count]) => (count > 1 ? `${event}x${count}` : event)).join(",")}`);
    const hint = notices.map((notice) => notice.hint).filter(Boolean).join(" | ");
    if (hint) parts.push(`hint="${hint}"`);
  }
  if (history) parts.push(`history=${history}`);
  return parts.join("; ");
}

/**
 * The error for a turn that finished without a usable reply. The stream's
 * status and notice events are what name the cause, so they travel in the
 * message; without them every cause looked like the same 502.
 * `history` is `empty` when history held the announced message but with no
 * text, or `stale` when it never moved past the parent.
 */
export function emptyReplyError({ status = null, notices = [], history = null } = {}) {
  const diagnostics = describeStream({ status, notices, history });
  const hints = notices.map((notice) => notice.hint).filter(Boolean).join(" ");

  if (status && FILTER_STATUS.test(status)) {
    return new DeepSeekWebError(`DeepSeek Web withheld the reply (${diagnostics})`, {
      status: 400,
      code: "content_filtered",
    });
  }
  if (RATE_HINT.test(hints)) {
    return new DeepSeekWebError(`DeepSeek Web rate limited the turn (${diagnostics})`, {
      status: 429,
      code: "rate_limit_exceeded",
    });
  }
  if (LIMIT_HINT.test(hints)) {
    return new DeepSeekWebError(`DeepSeek Web refused the turn as too long (${diagnostics})`, {
      status: 413,
      code: "conversation_limit",
    });
  }
  if (status && /^INCOMPLETE/i.test(status)) {
    return new DeepSeekWebError(`DeepSeek Web dropped the reply (${diagnostics})`, {
      status: 502,
      code: "upstream_incomplete",
    });
  }
  return new DeepSeekWebError(`DeepSeek Web produced no new reply for this turn (${diagnostics})`, {
    status: 502,
    code: "history_incomplete",
  });
}

/**
 * Collapse fragments into one entry per kind, in first-seen order.
 *
 * Patch-protocol fragments are distinct pieces and are concatenated. Legacy
 * whole-fragment frames repeat the same fragment as it grows, so those merge.
 */
function collapseFragments(list) {
  const order = [];
  const merged = new Map();
  for (const fragment of list) {
    if (!fragment.type) continue;
    if (!merged.has(fragment.type)) {
      order.push(fragment.type);
      merged.set(fragment.type, fragment.content);
      continue;
    }
    const current = merged.get(fragment.type);
    merged.set(fragment.type, fragment.distinct ? current + fragment.content : mergeText(current, fragment.content));
  }
  return order.map((type) => ({ type, content: merged.get(type) }));
}

/**
 * Incremental parser for the completion stream.
 *
 * Captured live (see tests/fixtures/deepseekWeb/completion-thinking.sse.txt):
 *   event: ready  {"request_message_id":1,"response_message_id":2}
 *   {"v":{"response":{"message_id":2,"fragments":[{"type":"THINK","content":"We"}]}}}
 *   {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
 *   {"v":" answer"}                      <- path and op carry over from the last patch
 *   {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"S"}]}
 *   {"p":"response/fragments/-1/content","v":"aya"}   <- op carries over: APPEND
 *   {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}
 * plus `update_session`, `title`, and `close` events that carry no text.
 *
 * `onReasoning(delta)` fires as reasoning text arrives, so the executor can
 * stream thinking before the answer (which needs the whole text for tool tags).
 */
export function createStreamParser({ onReasoning = null } = {}) {
  const list = [];
  let lastPath = null;
  let lastOp = null;
  let responseMessageId = null;
  let status = null;
  let buffer = "";
  // Events that carry no text. A turn that ends with nothing else still has
  // these, and they are the only clue about why upstream stayed silent.
  const notices = [];
  const seenNotices = new Set();

  const note = (event, hint) => {
    // One slot per event name when there is no hint: `update_session` repeats
    // every turn and would otherwise push the real explanation out.
    const key = hint ? `${event}:${hint}` : `${event}:`;
    if (seenNotices.has(key)) return;
    if (notices.length >= MAX_NOTICES) {
      if (!hint) return;
      const dropAt = notices.findIndex((notice) => !notice.hint);
      if (dropAt < 0) return;
      notices.splice(dropAt, 1);
    }
    seenNotices.add(key);
    notices.push({ event, hint: hint || null });
  };

  const emit = (delta) => {
    if (delta && onReasoning) onReasoning(delta);
  };

  // Unknown kinds still take a slot: `-1` addresses the last fragment of any kind.
  const addFragment = (type, content, distinct) => {
    const kind = FRAGMENT_KINDS[type] || null;
    const text = typeof content === "string" ? content : "";
    list.push({ type: kind, content: text, distinct });
    if (kind === "THINKING") emit(text);
  };

  const applyPatch = (path, op, value) => {
    if (op === "BATCH" && Array.isArray(value)) {
      for (const child of value) {
        if (typeof child?.p === "string") applyPatch(`${path}/${child.p}`, child.o ?? "SET", child.v);
      }
      return;
    }
    if (path === "response/fragments" && Array.isArray(value)) {
      for (const fragment of value) addFragment(fragment?.type, fragment?.content, true);
      return;
    }
    const target = CONTENT_PATH.exec(path);
    if (target && typeof value === "string") {
      const position = Number(target[1]);
      const fragment = list[position < 0 ? list.length + position : position];
      if (!fragment) return;
      if (op === "SET") {
        fragment.content = value;
        return;
      }
      fragment.content += value;
      if (fragment.type === "THINKING") emit(value);
      return;
    }
    if ((path === "response/status" || path === "response/quasi_status") && typeof value === "string") status = value;
  };

  const snapshot = (response) => {
    if (responseMessageId === null && response.message_id !== undefined && response.message_id !== null) {
      responseMessageId = response.message_id;
    }
    if (typeof response.status === "string") status = response.status;
    for (const fragment of Array.isArray(response.fragments) ? response.fragments : []) {
      addFragment(fragment?.type, fragment?.content, true);
    }
  };

  // Older captures sent whole fragments in arbitrary wrappers.
  const walk = (value, depth) => {
    if (!value || depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (FRAGMENT_KINDS[value.type] && typeof value.content === "string") {
      addFragment(value.type, value.content, false);
      return;
    }
    for (const key of Object.keys(value)) walk(value[key], depth + 1);
  };

  const handleEvent = (raw) => {
    let name = "";
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    const payload = data.join("");
    if (!payload || payload === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // The gateway only needs the text; unparseable frames are ignored.
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (name === "ready") {
      if (parsed.response_message_id !== undefined && parsed.response_message_id !== null) {
        responseMessageId = parsed.response_message_id;
      }
      return;
    }
    // update_session, title, close: bookkeeping without text. Keep their shape
    // and any explanation they carry, then leave the text alone.
    if (name && name !== "message") {
      note(name, hintOf(parsed, 0, NOTICE_KEYS));
      return;
    }
    const hint = hintOf(parsed);

    if (typeof parsed.p === "string") {
      const op = parsed.o ?? lastOp ?? "APPEND";
      if (op !== "BATCH") {
        lastPath = parsed.p;
        lastOp = op;
      }
      if (hint) note(name || "message", hint);
      applyPatch(parsed.p, op, parsed.v);
      return;
    }
    if (typeof parsed.v === "string") {
      if (lastPath) applyPatch(lastPath, parsed.o ?? lastOp ?? "APPEND", parsed.v);
      return;
    }
    if (parsed.v && typeof parsed.v === "object" && !Array.isArray(parsed.v) && parsed.v.response) {
      snapshot(parsed.v.response);
      return;
    }
    walk(parsed, 0);
  };

  return {
    push(chunk) {
      buffer += chunk;
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      for (const event of events) handleEvent(event);
    },
    end() {
      if (buffer) handleEvent(buffer);
      buffer = "";
    },
    result() {
      return { fragments: collapseFragments(list), responseMessageId, status, notices };
    },
  };
}

/** Fragments of a whole completion stream, one entry per kind. */
export function collectStreamFragments(text) {
  const parser = createStreamParser();
  parser.push(String(text || ""));
  parser.end();
  return parser.result().fragments;
}

function joinFragments(fragments, type) {
  return fragments.filter((fragment) => fragment.type === type).reduce((acc, fragment) => mergeText(acc, fragment.content), "");
}

/**
 * One assistant message with its fragments, from history_messages: the one
 * with `messageId` when given, otherwise the latest.
 */
export function parseHistoryPayload(text, { messageId = null } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const messages = parsed?.data?.biz_data?.chat_messages;
  if (!Array.isArray(messages)) return null;
  const assistants = messages.filter((message) => message?.role === "ASSISTANT");
  if (assistants.length === 0) return null;
  const message =
    messageId === null || messageId === undefined
      ? assistants[assistants.length - 1]
      : assistants.find((candidate) => String(candidate.message_id) === String(messageId));
  if (!message) return null;
  // History spells reasoning as `THINK`; normalise before joining.
  const fragments = (Array.isArray(message.fragments) ? message.fragments : []).map((fragment) => ({
    type: FRAGMENT_KINDS[fragment?.type] || fragment?.type,
    content: fragment?.content,
  }));
  return {
    text: joinFragments(fragments, "RESPONSE"),
    reasoning: joinFragments(fragments, "THINKING"),
    parentMessageId: message.message_id ?? null,
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function createDeepSeekWebTransport(
  connection,
  { fetchFn = globalThis.fetch, baseUrl = deepseekBaseUrl(), proxyUrl = null, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const send = (url, init) => (proxyUrl ? proxyFetch(url, init, proxyUrl) : fetchFn(url, init));

  /**
   * One upstream call. `onChunk` receives an event stream as it arrives; the
   * whole text is still returned so a JSON error body is caught either way.
   */
  async function request(path, { method = "POST", body, extraHeaders = {}, signal = null, onChunk = null } = {}) {
    const session = sessionOf(connection);
    const headers = {
      Authorization: `Bearer ${session.token}`,
      "User-Agent": USER_AGENT,
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      Accept: "*/*",
      ...extraHeaders,
    };
    if (session.cookies) headers.Cookie = session.cookies;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const signals = [signal, AbortSignal.timeout(timeoutMs)].filter(Boolean);
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    const res = await send(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
    const streaming = onChunk && res.ok && res.body && /event-stream/i.test(res.headers.get("content-type") || "");
    let text = "";
    if (streaming) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        text += chunk;
        onChunk(chunk);
      }
      const tail = decoder.decode();
      if (tail) {
        text += tail;
        onChunk(tail);
      }
    } else {
      text = await res.text();
    }
    if (!res.ok) throw errorForStatus(res.status, text);
    const rejected = businessError(text);
    if (rejected) throw rejected;
    return { status: res.status, text };
  }

  async function createSession({ signal = null } = {}) {
    const { text } = await request("/api/v0/chat_session/create", { body: {}, signal });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DeepSeekWebError("chat_session/create did not return JSON", { code: "invalid_response" });
    }
    const chatSessionId = parsed?.data?.biz_data?.chat_session?.id;
    if (!chatSessionId) {
      throw new DeepSeekWebError("chat_session/create returned no session id", { code: "invalid_response" });
    }
    return { chatSessionId };
  }

  async function fetchChallenge(signal) {
    const { text } = await request("/api/v0/chat/create_pow_challenge", {
      body: { target_path: POW_TARGET_PATH },
      signal,
    });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DeepSeekWebError("create_pow_challenge did not return JSON", { code: "invalid_response" });
    }
    const challenge = parsed?.data?.biz_data?.challenge;
    if (!challenge || typeof challenge !== "object") {
      throw new DeepSeekWebError("create_pow_challenge returned no challenge", { code: "pow_invalid" });
    }
    return challenge;
  }

  /**
   * The reply this turn produced. A message is only accepted when it is the one
   * the stream announced, or, without an announcement, when it is not the
   * message the turn continued from: returning that one would hand the client
   * the previous answer again.
   */
  async function readHistory(chatSessionId, { expectedId = null, previousId = null } = {}, signal = null) {
    const path = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatSessionId)}`;
    let candidate = null;
    for (let attempt = 1; attempt <= HISTORY_ATTEMPTS; attempt++) {
      const { text } = await request(path, { method: "GET", signal });
      const found = parseHistoryPayload(text, { messageId: expectedId });
      const fresh =
        found?.parentMessageId !== null &&
        found?.parentMessageId !== undefined &&
        (previousId === null || previousId === undefined || String(found.parentMessageId) !== String(previousId));
      if (fresh) {
        candidate = found;
        if (found.text || found.reasoning) return { reply: found, candidate };
      }
      if (attempt < HISTORY_ATTEMPTS) await delay(HISTORY_RETRY_DELAY_MS, signal);
    }
    return { reply: null, candidate };
  }

  async function complete({
    chatSessionId,
    parentMessageId = null,
    mode = "delta",
    messages = [],
    history = messages,
    tools = [],
    thinking = false,
    signal = null,
    onReasoning = null,
  }) {
    let challenge = await fetchChallenge(signal);
    if (isChallengeExpired(challenge, now())) {
      // A cached or slow challenge is useless; ask again before spending a solve.
      challenge = await fetchChallenge(signal);
      if (isChallengeExpired(challenge, now())) {
        throw new DeepSeekWebError("PoW challenge expired before it could be solved", {
          status: 502,
          code: "pow_expired",
        });
      }
    }

    const powHeader = encodePowHeader(await solvePowChallenge(challenge));
    const prompt = renderTurn({ mode, messages, tools, history });

    const parser = createStreamParser({ onReasoning });
    await request(POW_TARGET_PATH, {
      body: {
        chat_session_id: chatSessionId,
        parent_message_id: parentMessageId,
        prompt,
        ref_file_ids: [],
        // The web endpoint has no `model` field; this flag selects the mode.
        thinking_enabled: Boolean(thinking),
        search_enabled: false,
      },
      extraHeaders: { "x-ds-pow-response": powHeader },
      signal,
      onChunk: (chunk) => parser.push(chunk),
    });
    parser.end();

    // History is authoritative, but a turn that has just finished may not be
    // materialised there yet; the stream text keeps the reply from being lost.
    const streamed = parser.result();
    const streamText = joinFragments(streamed.fragments, "RESPONSE");
    const streamReasoning = joinFragments(streamed.fragments, "THINKING");

    const { reply, candidate } = await readHistory(
      chatSessionId,
      { expectedId: streamed.responseMessageId, previousId: parentMessageId },
      signal
    );
    if (reply) {
      return {
        text: reply.text || streamText,
        reasoning: reply.reasoning || streamReasoning,
        parentMessageId: reply.parentMessageId,
      };
    }

    const messageId = candidate?.parentMessageId ?? streamed.responseMessageId;
    if (messageId !== null && messageId !== undefined && (streamText || streamReasoning)) {
      return { text: streamText, reasoning: streamReasoning, parentMessageId: messageId };
    }
    // Nothing to return, so say why: the stream's status and notices are the
    // only evidence left, and they pick the error code.
    throw emptyReplyError({
      status: streamed.status,
      notices: streamed.notices,
      history: candidate ? "empty" : "stale",
    });
  }

  /** Remove a chat the gateway opened, so retired chains do not pile up in the sidebar. */
  async function deleteSession({ chatSessionId, signal = null } = {}) {
    if (!chatSessionId) return;
    await request("/api/v0/chat_session/delete", { body: { chat_session_id: chatSessionId }, signal });
  }

  // fetchChallenge is exposed for the dashboard health check, which must not
  // start a chat turn just to learn whether the token is alive.
  return { createSession, complete, fetchChallenge, deleteSession };
}

let transportFactory = (connection, options) => createDeepSeekWebTransport(connection, options);

export function setDeepSeekTransportFactory(factory) {
  transportFactory = typeof factory === "function" ? factory : (connection, options) => createDeepSeekWebTransport(connection, options);
}

export function resetDeepSeekTransportFactory() {
  transportFactory = (connection, options) => createDeepSeekWebTransport(connection, options);
}

export function resolveDeepSeekTransport(connection, options = {}) {
  return transportFactory(connection, options);
}
