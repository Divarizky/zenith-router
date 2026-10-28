/**
 * Executor for DuckDuckGo AI Chat (duck.ai).
 *
 * The provider is declared `format: "openai"`, so this receives an OpenAI body
 * and must return an OpenAI response. duck.ai is not an OpenAI-compatible API:
 * every POST needs a solved VQD challenge, a browser-shaped cookie jar, and a
 * synthetic interaction trace. services/duckduckgoWeb/challenge.js does the
 * solving; this file owns the session, request shape and reply parsing.
 *
 * duck.ai has no tool calling: a request carrying `tools` is answered as plain
 * text, so the gateway sees a normal message instead of a fabricated call.
 */
import { registerExecutor } from "./base.js";
import { proxyFetch } from "./proxy.js";
import { solveDuckDuckGoChallenge, makeDuckDuckGoFeSignals } from "../services/duckduckgoWeb/challenge.js";
import {
  DUCKDUCKGO_AUTH_URL,
  DUCKDUCKGO_BASE,
  DUCKDUCKGO_CHAT_URL,
  DUCKDUCKGO_DEFAULT_FE_VERSION,
  DUCKDUCKGO_FE_VERSION_PATTERN,
  DUCKDUCKGO_STATUS_URL,
  DUCKDUCKGO_USER_AGENT,
  fetchDuckDuckGoModelIds,
  pickLiveModel,
  pickReasoningEffort,
} from "../services/duckduckgoWeb/models.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };
const REQUEST_TIMEOUT_MS = 60_000;
const WARM_TTL_MS = 60 * 60 * 1000;

/** duck.ai seeds these on first visit; the status call answers oddly without them. */
const SEED_COOKIES = [
  ["5", "1"],
  ["ah", "wt-wt"],
  ["dcs", "1"],
  ["dcm", "3"],
  ["isRecentChatOn", "1"],
];

function browserHeaders() {
  return {
    "User-Agent": DUCKDUCKGO_USER_AGENT,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: DUCKDUCKGO_BASE,
    Referer: `${DUCKDUCKGO_BASE}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Ch-Ua": '"Chromium";v="149", "Not-A.Brand";v="24", "Google Chrome";v="149"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
  };
}

function errorResponse(status, message, code) {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** duck.ai speaks `{content}` or `{message}` depending on the event. */
function extractContent(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.content === "string") return data.content;
  if (typeof data.message === "string") return data.message;
  return "";
}

function parseDataLine(line) {
  if (!line.startsWith("data: ")) return null;
  try {
    return JSON.parse(line.slice(6));
  } catch {
    return null;
  }
}

function upstreamErrorMessage(status, body) {
  let type = "";
  let code = "";
  try {
    const parsed = JSON.parse(body);
    type = typeof parsed?.type === "string" ? parsed.type : "";
    code = typeof parsed?.overrideCode === "string" ? ` (${parsed.overrideCode})` : "";
  } catch {
    // Not JSON; the status code carries the whole story.
  }
  if (type === "ERR_CHALLENGE") {
    return `DuckDuckGo rejected this anonymous session${code}. Wait for the IP limit to clear, or send this provider through a proxy pool.`;
  }
  if (type === "ERR_RATE_LIMIT") {
    return `DuckDuckGo rate limited this session${code}. Retry later or use another IP.`;
  }
  return type ? `DuckDuckGo upstream error: ${type}${code}` : `DuckDuckGo upstream returned HTTP ${status}`;
}

/**
 * One browser identity: cookie jar plus the x-fe-version the frontend currently
 * serves. Created lazily and reused, because re-challenging on every request
 * burns the IP's rate budget fast.
 */
class DuckDuckGoSession {
  constructor() {
    this.cookies = new Map(SEED_COOKIES);
    this.feVersion = DUCKDUCKGO_DEFAULT_FE_VERSION;
    this.warmedAt = 0;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  absorbCookies(res) {
    const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const pair = String(line).split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  headers(extra = {}) {
    return { ...browserHeaders(), Cookie: this.cookieHeader(), ...extra };
  }

  /** Read the current build stamp off the homepage, then take the guest token. */
  async warm(fetchFn, signal) {
    if (this.warmedAt && Date.now() - this.warmedAt < WARM_TTL_MS) return;
    try {
      const res = await fetchFn(`${DUCKDUCKGO_BASE}/`, {
        headers: this.headers({ "Sec-Fetch-Mode": "navigate" }),
        signal,
      });
      this.absorbCookies(res);
      const match = (await res.text()).match(DUCKDUCKGO_FE_VERSION_PATTERN);
      if (match) this.feVersion = match[0];
    } catch {
      // Keep the default stamp; a stale one still passes the challenge check.
    }
    try {
      this.absorbCookies(await fetchFn(DUCKDUCKGO_AUTH_URL, { headers: this.headers(), signal }));
    } catch {
      // Optional token; the challenge path works without it.
    }
    this.warmedAt = Date.now();
  }

  /** The status call returns the challenge in x-vqd-hash-1 (and sometimes x-vqd-4). */
  async acquireChallenge(fetchFn, signal) {
    const res = await fetchFn(DUCKDUCKGO_STATUS_URL, {
      headers: this.headers({ "x-vqd-accept": "1" }),
      signal,
    });
    this.absorbCookies(res);
    return {
      status: res.status,
      vqd4: res.headers.get("x-vqd-4"),
      challenge: res.headers.get("x-vqd-hash-1"),
    };
  }
}

function buildPayload(model, messages, effort) {
  return {
    model,
    // The frontend always sends this map; leaving it out is treated as a non-browser.
    metadata: {
      toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false },
    },
    messages,
    canUseTools: false,
    // Required by the upstream: without it, or with an effort the model does not list, the POST is a 400.
    ...(effort ? { reasoningEffort: effort } : {}),
    canUseApproxLocation: null,
    canDelegateImageGeneration: null,
  };
}

/** duck.ai accepts only user/assistant roles, so system prompts fold into the next user turn. */
function normalizeMessages(messages) {
  const out = [];
  let pendingSystem = [];
  for (const message of messages) {
    const role = message?.role;
    const text = typeof message?.content === "string" ? message.content : "";
    if (role === "system" || role === "developer") {
      if (text.trim()) pendingSystem.push(text.trim());
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const content = pendingSystem.length > 0 ? `${pendingSystem.join("\n\n")}\n\n${text}` : text;
    if (role === "user") pendingSystem = [];
    if (!content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  }
  if (out.length === 0) out.push({ role: "user", content: pendingSystem.join("\n\n") || "Hello" });
  if (out[0].role !== "user") out.unshift({ role: "user", content: "Continue." });
  return out;
}

/** Non-stream replies still arrive as SSE; glue every content frame together. */
function collectText(raw) {
  let text = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[DONE]") continue;
    text += extractContent(parseDataLine(trimmed));
  }
  return text;
}

function streamFromUpstream(upstream) {
  let pending = "";
  const transform = new TransformStream({
    transform(chunk, controller) {
      const lines = `${pending}${decoder.decode(chunk, { stream: true })}`.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const content = extractContent(parseDataLine(trimmed));
        if (!content) continue;
        const frame = { choices: [{ index: 0, delta: { content } }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
    },
    flush(controller) {
      pending += decoder.decode();
      const content = extractContent(parseDataLine(pending.trim()));
      if (content) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`)
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
  return upstream.body.pipeThrough(transform);
}

/**
 * duck.ai rate-limits per source IP, so the connection's proxy is the only lever
 * that moves the limit. Without one, every call shares this machine's address
 * and one exhausted IP blocks the provider until upstream forgives it.
 */
function resolveFetch(proxyUrl) {
  if (!proxyUrl) return globalThis.fetch;
  return (url, options) => proxyFetch(url, options, proxyUrl);
}

export class DuckDuckGoWebExecutor {
  constructor() {
    this.session = new DuckDuckGoSession();
  }

  async execute({ body, signal, stream, targetModel, proxyUrl = null }) {
    let payload;
    try {
      payload = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      return errorResponse(400, "Request body is not valid JSON", "bad_request");
    }

    const messages = normalizeMessages(Array.isArray(payload?.messages) ? payload.messages : []);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const fetchFn = resolveFetch(proxyUrl);

    try {
      await this.session.warm(fetchFn, merged);
      const liveIds = await fetchDuckDuckGoModelIds(fetchFn, this.session.headers());
      const model = pickLiveModel(targetModel, liveIds);

      const { status, vqd4, challenge } = await this.session.acquireChallenge(fetchFn, merged);
      if (!challenge) {
        if (status === 429) {
          return errorResponse(429, "DuckDuckGo rate limited the challenge endpoint. Retry later.", "rate_limited");
        }
        return errorResponse(502, `DuckDuckGo returned no challenge (HTTP ${status})`, "no_challenge");
      }

      const solved = await solveDuckDuckGoChallenge(challenge, DUCKDUCKGO_USER_AGENT);

      const upstream = await fetchFn(DUCKDUCKGO_CHAT_URL, {
        method: "POST",
        headers: this.session.headers({
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "x-ddg-journey-id": crypto.randomUUID().replaceAll("-", ""),
          "x-fe-signals": makeDuckDuckGoFeSignals(),
          "x-fe-version": this.session.feVersion,
          "x-vqd-hash-1": solved,
          ...(vqd4 ? { "x-vqd-4": vqd4 } : {}),
        }),
        body: JSON.stringify(buildPayload(model, messages, pickReasoningEffort(model))),
        signal: merged,
      });
      this.session.absorbCookies(upstream);

      if (!upstream.ok) {
        const text = await upstream.text();
        return errorResponse(upstream.status, upstreamErrorMessage(upstream.status, text), "upstream_error");
      }

      if (stream) {
        if (!upstream.body) return errorResponse(502, "DuckDuckGo returned an empty body", "empty_body");
        return new Response(streamFromUpstream(upstream), { status: 200, headers: SSE_HEADERS });
      }

      const text = collectText(await upstream.text());
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      if (signal?.aborted) return errorResponse(499, "Client closed the request", "client_closed_request");
      if (err?.name === "TimeoutError") {
        return errorResponse(504, `DuckDuckGo did not answer within ${REQUEST_TIMEOUT_MS}ms`, "timeout");
      }
      return errorResponse(502, `DuckDuckGo request failed: ${err?.message || err}`, "network_error");
    }
  }
}

let sharedExecutor = null;
registerExecutor("duckduckgo-web", {
  execute(args) {
    sharedExecutor ??= new DuckDuckGoWebExecutor();
    return sharedExecutor.execute(args);
  },
});
