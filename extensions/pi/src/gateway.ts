import { parseModelIds } from "./models.ts";

export type GatewayErrorKind = "timeout" | "network" | "auth" | "http" | "payload";

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly status: number | undefined;

  constructor(kind: GatewayErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    this.status = status;
  }
}

export interface GetJsonOptions {
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * GET JSON dari gateway. Redirect tidak diikuti: gateway mengarahkan request
 * tanpa sesi ke halaman login, jadi redirect diperlakukan sebagai `auth`.
 * Pesan error tidak memuat API key maupun isi body.
 */
export async function getJson(url: string, options: GetJsonOptions): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signals = options.signal ? [timeout, options.signal] : [timeout];
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.any(signals) });
  } catch {
    if (timeout.aborted) throw new GatewayError("timeout", `gateway tidak merespons dalam ${options.timeoutMs} ms`);
    throw new GatewayError("network", "gateway tidak dapat dihubungi");
  }

  const { status } = response;
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
    throw new GatewayError("auth", `gateway menolak request (HTTP ${status})`, status);
  }
  if (!response.ok) {
    throw new GatewayError("http", `gateway mengembalikan HTTP ${status}`, status);
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    if (timeout.aborted) throw new GatewayError("timeout", `gateway tidak merespons dalam ${options.timeoutMs} ms`);
    throw new GatewayError("network", "body respons gateway terputus");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError("payload", "respons gateway bukan JSON valid", status);
  }
}

/** Daftar id model dari `GET /v1/models`. */
export async function fetchModelIds(origin: string, options: GetJsonOptions): Promise<string[]> {
  const payload = await getJson(`${origin}/v1/models`, options);
  const ids = parseModelIds(payload);
  if (ids === null) throw new GatewayError("payload", "bentuk respons /v1/models tidak dikenali");
  return ids;
}
