import test from "node:test";
import assert from "node:assert";
import { extractQuotaCooldownMs, parseRetryAfterMs } from "../src/services/fallback.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const headers = (value) => new Headers(value === undefined ? {} : { "retry-after": value });
const resWith = (value) => ({ headers: headers(value) });

test("Retry-After detik diubah menjadi milidetik", () => {
  assert.strictEqual(parseRetryAfterMs("120", NOW), 120_000);
  assert.strictEqual(extractQuotaCooldownMs(resWith("120"), "", 60_000), 120_000);
});

test("Retry-After tanggal IMF-fixdate menghasilkan selisih dari sekarang", () => {
  // 60 detik setelah NOW dalam format IMF-fixdate.
  assert.strictEqual(parseRetryAfterMs("Thu, 15 Jan 2026 12:01:00 GMT", NOW), 60_000);
  assert.strictEqual(extractQuotaCooldownMs(resWith("Thu, 15 Jan 2026 12:01:00 GMT"), "", 60_000), 60_000);
});

test("Retry-After tanggal lampau jatuh ke default, bukan cooldown negatif", () => {
  // Tanggal lampau menghasilkan null; extractQuotaCooldownMs lalu memakai default.
  assert.strictEqual(parseRetryAfterMs("Thu, 15 Jan 2026 11:59:00 GMT", NOW), null);
  assert.strictEqual(extractQuotaCooldownMs(resWith("Thu, 15 Jan 2026 11:59:00 GMT"), "", 60_000), 60_000);
});

test("Retry-After invalid atau kosong jatuh ke default", () => {
  for (const bad of ["tidak-valid", "0", "-5", "", "  ", "Thu, 15 Jan 2026 12:01:00"]) {
    assert.strictEqual(parseRetryAfterMs(bad, NOW), null, `"${bad}" harus null`);
  }
  assert.strictEqual(extractQuotaCooldownMs(resWith("tidak-valid"), "", 45_000), 45_000);
  assert.strictEqual(extractQuotaCooldownMs(resWith(undefined), "", 45_000), 45_000);
});

test("Retry-After tanpa header tetap membaca retryDelay dari body", () => {
  const body = JSON.stringify({ error: { details: [{ retryDelay: "7.5s" }] } });
  assert.strictEqual(extractQuotaCooldownMs(resWith(undefined), body, 60_000), 7_500);
});
