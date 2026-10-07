import { getAllProviders } from "../providers/index.js";

// Sync in-memory cache for live provider model endpoints (modelsFetcher in the
// registry). Refreshed at server startup; getAvailableModels() stays synchronous
// by merging whatever is cached. Ponytail: no scheduled refresh yet, add when
// providers change their catalogs often enough to matter.
const cache = new Map();

export function getLiveModels(providerId) {
  return cache.get(providerId) || [];
}

export async function refreshModelFetchers() {
  const results = await Promise.allSettled(
    getAllProviders()
      .filter((p) => p.modelsFetcher?.url)
      .map(async (p) => {
        const res = await fetch(p.modelsFetcher.url, {
          headers: { "x-opencode-client": "desktop" },
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        const list = Array.isArray(data) ? data : data?.data || [];
        cache.set(
          p.id,
          list
            .filter((m) => m?.id)
            .map((m) => ({ id: m.id, name: m.name || m.id, live: true }))
        );
      })
  );
  for (const r of results) if (r.status === "rejected") console.warn("[modelFetchers]", r.reason?.message || r.reason);
}
