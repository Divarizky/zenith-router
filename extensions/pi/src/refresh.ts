import { selectModels, type ModelSource } from "./models.ts";

export const REFRESH_INTERVAL_MS = 5 * 60_000;

export interface ModelRefresherDeps {
  /** Mengambil id model dari gateway. Harus melempar error bila gagal. */
  readonly fetchIds: (request: { signal: AbortSignal | undefined; apiKey: string | undefined }) => Promise<string[]>;
  readonly readCache: () => readonly string[];
  readonly writeCache: (ids: readonly string[]) => void;
  readonly now: () => number;
  readonly intervalMs?: number;
}

export interface RefreshRequest {
  readonly force?: boolean;
  readonly allowNetwork: boolean;
  readonly signal?: AbortSignal;
  /** API key efektif dari Pi; tidak pernah dicatat atau ditampilkan. */
  readonly apiKey?: string;
}

export interface RefreshResult {
  readonly source: ModelSource;
  readonly ids: readonly string[];
}

export interface ModelRefresher {
  refresh(request: RefreshRequest): Promise<RefreshResult>;
  /** Hasil terakhir tanpa jaringan, untuk dipakai saat pendaftaran awal. */
  current(): RefreshResult;
}

/**
 * Refresh daftar model dengan tiga aturan:
 * - permintaan yang berjalan bersamaan berbagi satu fetch,
 * - fetch baru ditahan selama `intervalMs` sejak percobaan terakhir, kecuali `force`,
 * - kegagalan gateway jatuh ke cache, lalu ke fallback, tanpa melempar error.
 */
export function createModelRefresher(deps: ModelRefresherDeps): ModelRefresher {
  const intervalMs = deps.intervalMs ?? REFRESH_INTERVAL_MS;
  // Hasil live terakhir. Null berarti belum ada fetch yang berhasil, sehingga
  // cache dibaca ulang setiap kali dibutuhkan, bukan diambil sekali di awal.
  let liveIds: string[] | null = null;
  let lastAttemptAt: number | undefined;
  let inFlight: Promise<RefreshResult> | undefined;

  const snapshot = (): RefreshResult => selectModels(liveIds, deps.readCache());

  const attempt = async (request: RefreshRequest): Promise<RefreshResult> => {
    lastAttemptAt = deps.now();
    try {
      const live = await deps.fetchIds({ signal: request.signal, apiKey: request.apiKey });
      liveIds = live.length > 0 ? live : null;
    } catch {
      liveIds = null;
    }
    const selected = snapshot();
    if (selected.source === "live") deps.writeCache(selected.ids);
    return selected;
  };

  return {
    current: snapshot,
    refresh(request: RefreshRequest): Promise<RefreshResult> {
      if (!request.allowNetwork) return Promise.resolve(snapshot());
      if (inFlight) return inFlight;
      const fresh = lastAttemptAt !== undefined && deps.now() - lastAttemptAt < intervalMs;
      if (!request.force && fresh) return Promise.resolve(snapshot());
      inFlight = attempt(request).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
