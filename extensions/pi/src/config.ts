export const DEFAULT_GATEWAY_ORIGIN = "http://127.0.0.1:20120";

/**
 * Origin gateway dari env `ZENITH_URL`. Nilai yang diberi suffix `/v1` atau
 * garis miring di akhir dinormalkan, supaya `${origin}/v1` tidak menjadi `/v1/v1`.
 */
export function resolveGatewayOrigin(env: Record<string, string | undefined>): string {
  const configured = env.ZENITH_URL?.trim();
  const base = (configured || DEFAULT_GATEWAY_ORIGIN).replace(/\/+$/, "").replace(/\/v1$/, "");
  return base.replace(/\/+$/, "");
}

export function providerBaseUrl(origin: string): string {
  return `${origin}/v1`;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** `/api/quota` hanya boleh dibaca dari loopback (control-plane gateway). */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Channel `pi.events` tempat daftar koneksi kuota diterbitkan untuk usage-tracker. */
export const QUOTA_CHANNEL = "zenith-router:quota";
/** Env yang dipakai sebagai API key bila tidak ada kredensial tersimpan dari /login. */
export const API_KEY_ENV = "ZENITH_ROUTER_API_KEY";
