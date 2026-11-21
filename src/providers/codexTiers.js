/**
 * Single source untuk effort Codex. Dipakai oleh dua konsumen:
 *
 * - katalog /v1/models (src/providers/index.js) memanggil `codexThinkingLevelsFor`
 *   untuk menentukan model mana yang mengiklankan `thinking_levels`;
 * - translator Responses (src/translator/responses.js) memanggil
 *   `codexReasoningEffort` untuk memetakan `reasoning_effort` klien ke
 *   `reasoning.effort`.
 *
 * Satu tabel `CODEX_EFFORTS` menjadi sumber untuk keduanya. Setiap string tier hanya
 * ditulis sekali. Daftar tier yang diiklankan diturunkan dari entri dengan
 * `advertise: true`.
 *
 * Dispatch tidak memfilter effort per model. Fungsi normalisasi tidak menerima nama
 * model, sehingga tidak ada cabang per model di jalur dispatch. Daftar ladder hanya
 * menentukan apa yang diiklankan di katalog.
 *
 * Bukti upstream: effort di tabel ini adalah klaim kode, bukan hasil request nyata.
 * Smoke test upstream belum dijalankan.
 *
 * Modul ini tidak punya import.
 */

/**
 * Tabel effort. `input` adalah nilai dari klien, `output` adalah nilai `reasoning.effort`
 * yang dikirim ke upstream, dan `advertise` menentukan apakah nilai itu masuk daftar
 * thinking tier di katalog. `minimal` dipetakan ke `low` seperti katalog openai-codex
 * milik Pi; `none` dan `minimal` dikenali sebagai input tetapi tidak diiklankan.
 */
const CODEX_EFFORTS = Object.freeze([
  { input: "none", output: "none", advertise: false },
  { input: "minimal", output: "low", advertise: false },
  { input: "low", output: "low", advertise: true },
  { input: "medium", output: "medium", advertise: true },
  { input: "high", output: "high", advertise: true },
  { input: "xhigh", output: "xhigh", advertise: true },
  { input: "max", output: "max", advertise: true },
]);

const EFFORT_MAP = Object.freeze(
  Object.fromEntries(CODEX_EFFORTS.map((e) => [e.input, e.output]))
);

/**
 * Daftar tier yang diiklankan untuk model Codex dalam ladder. Diturunkan dari tabel,
 * sehingga tidak ada string tier yang ditulis dua kali.
 */
export const CODEX_THINKING_LEVELS = Object.freeze(
  CODEX_EFFORTS.filter((e) => e.advertise).map((e) => e.input)
);

const CODEX_FULL_LADDER = /^gpt-(?:6(?:\.\d+)?|5\.6)(?:-|$)/;

/**
 * Tier yang diiklankan untuk model Codex dalam ladder, atau null untuk model di luar
 * ladder. Null berarti katalog tidak mengiklankan tier; dispatch tetap meneruskan effort.
 */
export function codexThinkingLevelsFor(modelId) {
  return CODEX_FULL_LADDER.test(String(modelId || "")) ? [...CODEX_THINKING_LEVELS] : null;
}

/**
 * Pemetaan effort untuk `reasoning.effort`. Mengembalikan nilai output dari tabel, atau
 * undefined bila input tidak dikenal. Tidak menerima nama model.
 */
export function codexReasoningEffort(rawEffort) {
  if (typeof rawEffort !== "string") return undefined;
  const key = rawEffort.toLowerCase();
  return Object.hasOwn(EFFORT_MAP, key) ? EFFORT_MAP[key] : undefined;
}
