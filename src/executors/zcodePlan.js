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
    const { url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, connection, targetModel } = args;
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
    const claudePayload = withZcodeSystem(translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, clientPayload, targetModel));
    const wantsStream = claudePayload.stream === true;

    const requestHeaders = {
      ...buildZcodeLLMHeaders(),
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
