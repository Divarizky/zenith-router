import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  API_KEY_ENV,
  isLoopbackOrigin,
  providerBaseUrl,
  QUOTA_CHANNEL,
  resolveGatewayOrigin,
} from "./config.ts";
import { fetchModelInfos, getJson } from "./gateway.ts";
import { readModelCache, toProviderModel, writeModelCache, type ModelInfo } from "./models.ts";
import { parseQuotaPayload, summarizeQuota, type QuotaEntry } from "./quota.ts";
import { createModelRefresher, type ModelRefresher } from "./refresh.ts";

export const PROVIDER_ID = "zenith-router";
export const COMMAND_NAME = "zenith-router";
const PROBE_TIMEOUT_MS = 1500;
const LIST_TIMEOUT_MS = 3000;
const CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "cache", "zenith-router-models.json");

export default function zenithRouterExtension(pi: ExtensionAPI): void {
  const origin = resolveGatewayOrigin(process.env);
  let quotaEntries: QuotaEntry[] | null = null;

  // Metadata dari fetch live terakhir yang berhasil. Dipakai bersama cache sebagai sumber info model.
  let liveInfos: ModelInfo[] = [];

  const refresher = createModelRefresher({
    fetchIds: async ({ signal, apiKey }) => {
      // Dikosongkan dulu agar kegagalan fetch tidak memakai metadata dari fetch sebelumnya.
      liveInfos = [];
      liveInfos = await fetchModelInfos(origin, { timeoutMs: LIST_TIMEOUT_MS, signal, apiKey });
      return liveInfos.map((info) => info.id);
    },
    readCache: () => readModelCache(CACHE_FILE)?.ids ?? [],
    writeCache: (ids) => writeModelCache(CACHE_FILE, ids, new Date(), liveInfos),
    now: () => Date.now(),
  });

  const toModels = (ids: readonly string[]): ProviderModelConfig[] => {
    const infoById = new Map<string, ModelInfo>();
    for (const info of readModelCache(CACHE_FILE)?.models ?? []) infoById.set(info.id, info);
    for (const info of liveInfos) infoById.set(info.id, info);
    return ids.map((id) => toProviderModel(id, infoById.get(id)) as ProviderModelConfig);
  };

  const config: ProviderConfig = {
    name: "Zenith Router",
    baseUrl: providerBaseUrl(origin),
    apiKey: `$${API_KEY_ENV}`,
    authHeader: true,
    api: "openai-completions",
    models: toModels(refresher.current().ids),
    async refreshModels(context) {
      const result = await refresher.refresh({
        force: context.force,
        allowNetwork: context.allowNetwork,
        signal: context.signal,
        apiKey: context.credential?.type === "api_key" ? context.credential.key : undefined,
      });
      return toModels(result.ids);
    },
  };
  pi.registerProvider(PROVIDER_ID, config);

  pi.on("session_start", async () => {
    quotaEntries = await publishQuota(origin, pi);
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Status zenith-router: gateway, jumlah model, dan kuota",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const alive = await probeGateway(origin);
      const quota = (await publishQuota(origin, pi)) ?? quotaEntries;
      quotaEntries = quota;
      const lines = await buildStatus(origin, alive, refresher, quota);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

/** Cek hidup lewat `/health`. Endpoint ini tidak membutuhkan API key. */
export async function probeGateway(origin: string): Promise<boolean> {
  try {
    await getJson(`${origin}/health`, { timeoutMs: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ambil `/api/quota` dan terbitkan lewat `pi.events`. Hanya dilakukan untuk
 * origin loopback, karena endpoint itu control-plane dan tidak memakai API key.
 * Kegagalan menghasilkan null, tanpa event.
 */
async function publishQuota(origin: string, pi: ExtensionAPI): Promise<QuotaEntry[] | null> {
  if (!isLoopbackOrigin(origin)) return null;
  try {
    const payload = await getJson(`${origin}/api/quota`, { timeoutMs: LIST_TIMEOUT_MS });
    const entries = parseQuotaPayload(payload);
    if (entries === null) return null;
    pi.events.emit(QUOTA_CHANNEL, { connections: entries, fetchedAt: new Date().toISOString() });
    return entries;
  } catch {
    return null;
  }
}

export async function buildStatus(
  origin: string,
  alive: boolean,
  refresher: ModelRefresher,
  quota: readonly QuotaEntry[] | null,
): Promise<string[]> {
  const lines = [`gateway ${origin}: ${alive ? "hidup" : "mati"}`];
  const models = await refresher.refresh({ force: true, allowNetwork: alive });
  lines.push(`model: ${models.ids.length} (sumber: ${models.source})`);

  if (!isLoopbackOrigin(origin)) {
    lines.push("kuota: tidak diambil, gateway bukan loopback");
  } else if (quota === null) {
    lines.push("kuota: tidak tersedia");
  } else {
    const s = summarizeQuota(quota);
    lines.push(`kuota: ${s.total} koneksi, ${s.active} aktif, ${s.exhausted} habis, ${s.withError} error`);
  }
  return lines;
}
