import crypto from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";
import { buildZcodeLLMHeaders, buildZcodeSystemBlocks } from "../services/zcodeIdentity.js";
import { FORMATS, translateRequest, translateResponse, createTransformStream } from "../translator/index.js";

export const ZCODE_PLAN_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

// Error code ZCode Start-Plan yang diketahui. Status HTTP yang dipetakan dipakai
// fallback untuk memutuskan failover (402 dan 429 berpindah akun).
const ZCODE_ERROR_CODES = {
  3012: { status: 401, type: "authentication_error", message: "Identitas ZCode Start-Plan sudah kedaluwarsa." },
  3008: { status: 429, type: "rate_limit_error", message: "Concurrency ZCode Start-Plan melebihi batas (3008)." },
  3009: { status: 429, type: "rate_limit_error", message: "Concurrency ZCode Start-Plan melebihi batas (3009)." },
  1113: { status: 402, type: "insufficient_balance", message: "Saldo ZCode Start-Plan tidak mencukupi." },
};

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Ambil kode error dari bentuk `{ code }` atau `{ error: { code } }`. */
function zcodeErrorCode(data) {
  const raw = data?.error?.code ?? data?.code;
  const code = Number(raw);
  return Number.isFinite(code) ? code : null;
}

/**
 * Terjemahkan body error ZCode ke envelope gateway. Kode yang dikenal dipetakan
 * ke status yang sesuai. 401 dan 403 tetap memakai status asli agar alur refresh
 * token fallback berjalan. Kode lain diteruskan apa adanya.
 */
function mapZcodeError(upstreamRes, text) {
  const data = parseJson(text);
  const code = zcodeErrorCode(data);
  const known = code !== null ? ZCODE_ERROR_CODES[code] : undefined;
  const upstreamMessage = data?.error?.message || data?.msg || data?.message;

  if (known) {
    return jsonResponse(known.status, {
      error: { message: known.message, type: known.type, code, provider: "glm" },
    });
  }

  const status = upstreamRes.status;
  return jsonResponse(status, {
    error: {
      message: upstreamMessage || `ZCode Start-Plan mengembalikan HTTP ${status}.`,
      type: status === 401 || status === 403 ? "authentication_error" : "upstream_error",
      ...(code !== null ? { code } : {}),
      provider: "glm",
    },
  });
}

// Batas breakpoint cache per request pada Anthropic Messages.
const MAX_CACHE_BREAKPOINTS = 4;
const EPHEMERAL = { type: "ephemeral" };

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n\n");
  }
  return "";
}

/**
 * x-session-id yang stabil per percakapan. Memakai sessionKey dari fallback bila ada.
 * Bila tidak ada atau berawalan `apikey:`, dipakai hash system dan user message pertama.
 */
export function zcodeSessionId(sessionKey, clientPayload) {
  if (typeof sessionKey === "string" && sessionKey && !sessionKey.startsWith("apikey:")) {
    return `session_${sha256Hex(sessionKey).slice(0, 32)}`;
  }
  const messages = Array.isArray(clientPayload?.messages) ? clientPayload.messages : [];
  const system = messages.filter((m) => m?.role === "system").map((m) => textOf(m.content)).join("\n");
  const firstUser = messages.find((m) => m?.role === "user");
  const seed = `${system}\n${textOf(firstUser?.content)}`;
  if (!seed.trim()) return `session_${crypto.randomBytes(16).toString("hex")}`;
  return `session_${sha256Hex(seed).slice(0, 32)}`;
}

function countBreakpoints(payload) {
  let n = 0;
  if (Array.isArray(payload.system)) n += payload.system.filter((b) => b?.cache_control).length;
  if (Array.isArray(payload.tools)) n += payload.tools.filter((t) => t?.cache_control).length;
  for (const m of payload.messages ?? []) {
    if (Array.isArray(m?.content)) n += m.content.filter((b) => b?.cache_control).length;
  }
  return n;
}

/**
 * Pasang breakpoint pada tool terakhir dan content text terakhir message terakhir.
 * Elemen yang sudah membawa cache_control dari klien dibiarkan. Total breakpoint
 * (termasuk milik klien dan identitas) tidak melebihi MAX_CACHE_BREAKPOINTS.
 */
export function withZcodeCacheBreakpoints(payload) {
  const out = { ...payload };
  let budget = MAX_CACHE_BREAKPOINTS - countBreakpoints(out);

  if (budget > 0 && Array.isArray(out.tools) && out.tools.length > 0) {
    const last = out.tools.length - 1;
    if (!out.tools[last].cache_control) {
      out.tools = out.tools.map((t, i) => (i === last ? { ...t, cache_control: EPHEMERAL } : t));
      budget -= 1;
    }
  }

  if (budget > 0 && Array.isArray(out.messages) && out.messages.length > 0) {
    const lastIdx = out.messages.length - 1;
    const msg = out.messages[lastIdx];
    const blocks = typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : Array.isArray(msg.content) ? msg.content.slice() : null;
    const hasMarker = blocks?.some((b) => b?.cache_control);
    const textIdx = blocks ? blocks.map((b) => b?.type).lastIndexOf("text") : -1;
    if (blocks && !hasMarker && textIdx >= 0) {
      blocks[textIdx] = { ...blocks[textIdx], cache_control: EPHEMERAL };
      out.messages = out.messages.map((m, i) => (i === lastIdx ? { ...m, content: blocks } : m));
      budget -= 1;
    }
  }
  return out;
}

/** Gabungkan system prompt klien menjadi satu string, lalu bungkus dengan identitas ZCode. */
function withZcodeSystem(payload) {
  const system = payload.system;
  let clientSystem = "";
  if (typeof system === "string") clientSystem = system;
  else if (Array.isArray(system)) {
    clientSystem = system
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return { ...payload, system: buildZcodeSystemBlocks(clientSystem) };
}

export class ZcodePlanExecutor extends BaseExecutor {
  async execute(args) {
    const { url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, targetModel, sessionKey } = args;
    const planToken = connection?.credentials?.plan_token;

    // Akun tanpa plan_token memakai jalur PaaS biasa, tanpa perubahan.
    if (!planToken) {
      return super.execute({ url, method, headers, body, signal, timeoutMs, proxyUrl });
    }

    const clientPayload = typeof body === "string" ? parseJson(body) : body;
    if (!clientPayload || typeof clientPayload !== "object") {
      return jsonResponse(400, {
        error: { message: "Body request ZCode Start-Plan tidak valid.", type: "invalid_request_error", provider: "glm" },
      });
    }

    // Gateway mengirim format OpenAI untuk provider ini. Start-Plan memakai Anthropic Messages.
    const sessionId = zcodeSessionId(sessionKey, clientPayload);
    const claudePayload = withZcodeCacheBreakpoints(
      withZcodeSystem(translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, clientPayload, targetModel))
    );
    const wantsStream = claudePayload.stream === true;

    const requestHeaders = {
      ...buildZcodeLLMHeaders({ sessionId }),
      "Content-Type": "application/json",
      Authorization: `Bearer ${planToken}`,
    };

    const res = await super.execute({
      url: ZCODE_PLAN_URL,
      method,
      headers: requestHeaders,
      body: JSON.stringify(claudePayload),
      signal,
      timeoutMs,
      proxyUrl,
    });

    if (!res.ok) {
      const text = await res.text();
      return mapZcodeError(res, text);
    }

    const upstreamType = res.headers.get("content-type") || "";
    const model = targetModel || claudePayload.model;

    if (wantsStream || upstreamType.includes("text/event-stream")) {
      if (!res.body) return res;
      const includeUsage = clientPayload.stream_options?.include_usage === true;
      const converted = res.body.pipeThrough(
        createTransformStream(FORMATS.CLAUDE, FORMATS.OPENAI, model, { includeUsage })
      );
      return new Response(converted, {
        status: res.status,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    const data = parseJson(await res.text());
    if (!data || typeof data !== "object") {
      return jsonResponse(502, {
        error: { message: "Respons ZCode Start-Plan bukan JSON valid.", type: "upstream_error", provider: "glm" },
      });
    }
    return jsonResponse(res.status, translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, data, model));
  }
}

export const zcodePlanExecutorInstance = new ZcodePlanExecutor();
registerExecutor("zcodePlan", zcodePlanExecutorInstance);
