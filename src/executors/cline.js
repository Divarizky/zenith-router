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

export class ClineExecutor extends BaseExecutor {
  async execute(args) {
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
