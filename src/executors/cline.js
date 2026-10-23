import { BaseExecutor, registerExecutor } from "./base.js";

/**
 * Cline kadang membalas HTTP 200 dengan envelope {"success":false,"error":{...}}.
 * Fallback hanya menilai status HTTP, jadi envelope itu diubah menjadi status
 * error sungguhan supaya failover akun, cooldown, refresh token, dan combo
 * berjalan seperti kegagalan upstream lainnya.
 */

const DEFAULT_ENVELOPE_STATUS = 502;

function httpStatusFrom(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : null;
}

export function clineEnvelopeStatus(body) {
  const err = body?.error && typeof body.error === "object" ? body.error : {};
  return (
    httpStatusFrom(body?.status) ??
    httpStatusFrom(body?.statusCode) ??
    httpStatusFrom(err.status) ??
    httpStatusFrom(err.statusCode) ??
    httpStatusFrom(err.code) ??
    httpStatusFrom(body?.code) ??
    DEFAULT_ENVELOPE_STATUS
  );
}

function envelopeMessage(body) {
  const err = body?.error;
  if (typeof err === "string" && err) return err;
  return err?.message || body?.message || "Cline upstream request failed";
}

// Reasoning-replay models routed through Cline (Vercel AI Gateway) reject
// multi-turn histories when:
// 1. Any assistant message lacks reasoning_content (HTTP 400 "Missing required
//    parameter: 'messages[N].reasoning_content'").
// 2. An assistant message carries reasoning_details / reasoning_content with
//    raw Harmony control tokens (<|constrain|>, <|channel|>, <|message|>) from
//    an earlier streamed turn (HTTP 400 "The request could not be rendered
//    into a prompt for this model").
// 3. Assistant content quotes a Harmony header such as
//    "<|channel|>final<|message|>" as plain text; the renderer parses it as a
//    real channel header and fails with the same "could not be rendered" 400.
// Zenith normalizes all three: extracts text from reasoning_details, strips
// <|...|> control tokens, removes reasoning_details, falls back to a
// single-space placeholder when no reasoning text remains, and defuses
// <|...|> tokens in assistant content with a zero-width space.
// Strips Harmony framing prefixes (e.g. "<|constrain|>assistant<|channel|>final<|message|>")
// and any remaining <|...|> control tokens.
const HARMONY_FRAME_RE = /(?:<\|[^|>]+\|>)+[a-zA-Z0-9_-]*(?=<\|)/g;
const HARMONY_TAG_RE = /<\|[^|>]+\|>/g;

function cleanReasoningText(text) {
  if (typeof text !== "string") return "";
  return text.replace(HARMONY_FRAME_RE, "").replace(HARMONY_TAG_RE, "").trim();
}

function defuseHarmonyTokens(text) {
  return text.replace(HARMONY_TAG_RE, (tag) => "<\u200b" + tag.slice(1));
}

function defuseAssistantContent(msg) {
  if (typeof msg.content === "string") {
    msg.content = defuseHarmonyTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        part.text = defuseHarmonyTokens(part.text);
      }
    }
  }
}

function ensureAssistantReasoningContent(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return;
  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object" || msg.role !== "assistant") continue;

    let candidate = "";
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
      candidate = cleanReasoningText(msg.reasoning_content);
    } else if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
      candidate = cleanReasoningText(msg.reasoning);
    }

    if (!candidate && Array.isArray(msg.reasoning_details)) {
      const fromDetails = msg.reasoning_details
        .map((d) => (typeof d?.text === "string" ? d.text : typeof d?.summary === "string" ? d.summary : ""))
        .filter(Boolean)
        .join("\n");
      candidate = cleanReasoningText(fromDetails);
    }

    delete msg.reasoning_details;
    delete msg.reasoning;
    msg.reasoning_content = candidate || " ";
    defuseAssistantContent(msg);
  }
}

export class ClineExecutor extends BaseExecutor {
  async execute(args) {
    try {
      const parsed = JSON.parse(args.body ?? "{}");
      ensureAssistantReasoningContent(parsed);
      args = { ...args, body: JSON.stringify(parsed) };
    } catch {
      // Non-JSON body: diteruskan apa adanya.
    }
    const res = await super.execute(args);
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.includes("application/json")) return res;

    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}

    if (body && typeof body === "object" && body.success === false) {
      const status = clineEnvelopeStatus(body);
      const err = body.error && typeof body.error === "object" ? body.error : {};
      const headers = { "Content-Type": "application/json" };
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) headers["Retry-After"] = retryAfter;
      return new Response(
        JSON.stringify({
          error: {
            message: envelopeMessage(body),
            type: err.type || "upstream_error",
            code: typeof err.code === "string" ? err.code : "upstream_error",
          },
        }),
        { status, headers }
      );
    }

    // Body sudah dibaca, jadi dikembalikan utuh dalam Response baru.
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
}

export const clineExecutorInstance = new ClineExecutor();
registerExecutor("cline", clineExecutorInstance);
