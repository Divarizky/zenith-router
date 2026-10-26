import os from "node:os";
import { BaseExecutor, registerExecutor } from "./base.js";

/**
 * Versi klien CLI resmi Omnirush yang diemulasikan.
 * Diperoleh dari paket npm `omnirush` terbaru (2.7.2).
 * Dapat dioverride lewat environment variable OMNIRUSH_CLIENT_VERSION.
 */
export const DEFAULT_OMNIRUSH_CLIENT_VERSION = "2.7.2";

export function getOmnirushClientVersion() {
  const envVal = process.env.OMNIRUSH_CLIENT_VERSION;
  if (typeof envVal === "string" && envVal.trim()) {
    return envVal.trim();
  }
  return DEFAULT_OMNIRUSH_CLIENT_VERSION;
}

/**
 * Header User-Agent untuk panggilan /device/* sesuai format CLI resmi:
 * `omnirush/<version> (<platform>; <arch>)`
 */
export function getOmnirushDeviceUserAgent(version = getOmnirushClientVersion()) {
  return `omnirush/${version} (${process.platform}; ${process.arch})`;
}

/**
 * Header User-Agent untuk panggilan model sesuai CLI resmi:
 * Token proxy resmi mengganti User-Agent menjadi string "omnirush" polos
 * karena gateway menolak User-Agent berversi pada jalur inferensi.
 */
export const OMNIRUSH_MODEL_USER_AGENT = "omnirush";

/**
 * Header X-OmniRush-Client: `cli/<version>`
 */
export function getOmnirushClientHeader(version = getOmnirushClientVersion()) {
  return `cli/${version}`;
}

/**
 * Header lengkap untuk panggilan device flow (/device/authorize, /device/token, /device/refresh).
 */
export function getOmnirushDeviceHeaders(extra = {}) {
  const version = getOmnirushClientVersion();
  return {
    "User-Agent": getOmnirushDeviceUserAgent(version),
    "X-OmniRush-Client": getOmnirushClientHeader(version),
    ...extra,
  };
}

/**
 * Header lengkap untuk panggilan model ke gateway inferensi.
 */
export function getOmnirushModelHeaders(extra = {}) {
  const version = getOmnirushClientVersion();
  return {
    "User-Agent": OMNIRUSH_MODEL_USER_AGENT,
    "X-OmniRush-Client": getOmnirushClientHeader(version),
    ...extra,
  };
}

/**
 * Pesan kesalahan informatif saat gateway menolak versi klien (HTTP 426).
 */
export function buildUpdateRequiredMessage(version = getOmnirushClientVersion(), serverDetail = "") {
  const detailStr = serverDetail ? ` (${serverDetail})` : "";
  return (
    `Omnirush mewajibkan versi CLI yang lebih baru${detailStr}. ` +
    `Versi yang diemulasikan saat ini adalah ${version}. ` +
    `Set OMNIRUSH_CLIENT_VERSION=<versi baru> di environment atau perbarui konstanta di src/executors/omnirush.js.`
  );
}

/**
 * Cek apakah respons upstream menandakan update_required / HTTP 426
 */
export function isUpdateRequiredResponse(res, bodyText = "") {
  if (res?.status === 426) return true;
  if (typeof bodyText === "string") {
    if (bodyText.includes("update_required") || bodyText.includes("client_outdated") || bodyText.includes("upgrade_required")) {
      return true;
    }
  }
  return false;
}

export class OmnirushExecutor extends BaseExecutor {
  async execute({
    url,
    method = "POST",
    headers = {},
    body,
    signal,
    timeoutMs,
    proxyUrl,
    connection,
    stream = true,
    targetModel,
    targetFormat,
    sessionKey,
    effort,
  }) {
    // Terapkan header model Omnirush (satu tempat, tidak tercecer)
    const version = getOmnirushClientVersion();
    const omnirushHeaders = {
      ...headers,
      "User-Agent": OMNIRUSH_MODEL_USER_AGENT,
      "X-OmniRush-Client": getOmnirushClientHeader(version),
    };

    const res = await super.execute({
      url,
      method,
      headers: omnirushHeaders,
      body,
      signal,
      timeoutMs,
      proxyUrl,
      connection,
      stream,
      targetModel,
      targetFormat,
      sessionKey,
      effort,
    });

    // Tangani HTTP 426 update_required secara eksplisit dengan instruksi naikkan konstanta
    if (res.status === 426) {
      let detail = "";
      try {
        const cloned = res.clone();
        const text = await cloned.text();
        const parsed = JSON.parse(text);
        detail = parsed?.detail || parsed?.error?.message || "";
      } catch {
        /* abaikan jika body bukan JSON */
      }
      const message = buildUpdateRequiredMessage(version, detail);
      return new Response(
        JSON.stringify({
          error: {
            message,
            type: "update_required_error",
            code: "update_required",
            omnirush: {
              current_version: version,
              required: true,
            },
          },
        }),
        {
          status: 426,
          headers: {
            "Content-Type": "application/json",
            "x-zenith-error": "update_required",
          },
        }
      );
    }

    return res;
  }
}

export const omnirushExecutorInstance = new OmnirushExecutor();
registerExecutor("omnirush", omnirushExecutorInstance);
