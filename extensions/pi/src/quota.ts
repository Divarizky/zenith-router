/**
 * Entri koneksi dari `GET /api/quota`. Bentuk entri dipertahankan apa adanya
 * supaya usage-tracker menerima payload yang sama dengan endpoint gateway.
 */
export type QuotaEntry = Record<string, unknown> & { readonly provider: string };

export interface QuotaSummary {
  readonly total: number;
  readonly active: number;
  readonly exhausted: number;
  readonly withError: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

/**
 * Mengembalikan null bila payload bukan array. Entri tanpa `provider` string
 * dibuang, sama seperti usage-tracker membuangnya.
 */
export function parseQuotaPayload(payload: unknown): QuotaEntry[] | null {
  if (!Array.isArray(payload)) return null;
  const entries: QuotaEntry[] = [];
  for (const item of payload) {
    const record = asRecord(item);
    const provider = typeof record?.provider === "string" ? record.provider.trim() : "";
    if (record && provider) entries.push(record as QuotaEntry);
  }
  return entries;
}

function isActive(entry: QuotaEntry): boolean {
  return entry.is_active !== 0 && entry.is_active !== false;
}

function isExhausted(entry: QuotaEntry): boolean {
  const quota = asRecord(entry.quota);
  return entry.is_exhausted === true || quota?.is_exhausted === true;
}

export function summarizeQuota(entries: readonly QuotaEntry[]): QuotaSummary {
  return {
    total: entries.length,
    active: entries.filter(isActive).length,
    exhausted: entries.filter((e) => isActive(e) && isExhausted(e)).length,
    withError: entries.filter((e) => {
      const error = asRecord(e.quota)?.error;
      return typeof error === "string" && error.trim() !== "";
    }).length,
  };
}
