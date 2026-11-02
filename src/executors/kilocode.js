import { BaseExecutor, registerExecutor } from "./base.js";

export const KILO_GATEWAY_URL = "https://api.kilo.ai/api/gateway/chat/completions";

export class KilocodeExecutor extends BaseExecutor {
  async execute({
    url,
    method = "POST",
    headers = {},
    body,
    signal,
    timeoutMs,
    proxyUrl,
    connection,
  }) {
    let finalUrl = url;
    const finalHeaders = { ...headers };

    // Jika koneksi virtual (noauth) atau tanpa token auth, alihkan ke public keyless gateway Kilo
    const isKeyless =
      !connection ||
      connection.auth_type === "noauth" ||
      (!connection.credentials?.access_token && !connection.credentials?.api_key);

    if (isKeyless) {
      finalUrl = KILO_GATEWAY_URL;
      delete finalHeaders["Authorization"];
      delete finalHeaders["authorization"];
    }

    return super.execute({
      url: finalUrl,
      method,
      headers: finalHeaders,
      body,
      signal,
      timeoutMs,
      proxyUrl,
    });
  }
}

export const kilocodeExecutorInstance = new KilocodeExecutor();
registerExecutor("kilocode", kilocodeExecutorInstance);
registerExecutor("kilo-free", kilocodeExecutorInstance);
