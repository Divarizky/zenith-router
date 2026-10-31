import test from "node:test";
import assert from "node:assert/strict";
import { parseQuotaPayload, summarizeQuota } from "../src/quota.ts";

test("payload kuota yang bukan array ditolak, supaya tidak ada event kosong palsu", () => {
  assert.equal(parseQuotaPayload({ error: "unauthorized" }), null);
  assert.equal(parseQuotaPayload(null), null);
});

test("entri tanpa provider dibuang, sama seperti usage-tracker membuangnya", () => {
  const entries = parseQuotaPayload([{ id: 1, provider: "codex" }, { id: 2 }, { id: 3, provider: "  " }, "rusak"]);
  assert.deepEqual(entries?.map((e) => e.id), [1]);
});

test("field koneksi dan routing dibawa utuh agar payload sama dengan /api/quota", () => {
  const [entry] = parseQuotaPayload([{ id: 7, provider: "codex", routing_locks: [{ model: "m", locked_until: 1 }], quota: { plan: "pro" } }]) ?? [];
  assert.deepEqual(entry?.routing_locks, [{ model: "m", locked_until: 1 }]);
  assert.deepEqual(entry?.quota, { plan: "pro" });
});

test("ringkasan menghitung koneksi aktif, habis, dan error tanpa menghitung koneksi nonaktif", () => {
  const entries = parseQuotaPayload([
    { provider: "a", is_active: 1, is_exhausted: true },
    { provider: "b", is_active: 1, quota: { is_exhausted: true } },
    { provider: "c", is_active: 0, is_exhausted: true },
    { provider: "d", is_active: true, quota: { error: "gagal sinkron" } },
  ]) ?? [];
  assert.deepEqual(summarizeQuota(entries), { total: 4, active: 3, exhausted: 2, withError: 1 });
});
