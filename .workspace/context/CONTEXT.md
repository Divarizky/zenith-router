# CONTEXT — zenroute

Pengetahuan domain dan teknis project — lazy-load saat perlu. Quick ref ada di PROJECT.md.

## Domain Model <!-- auto -->
### Provider & Connection
- **Meaning:** Provider adalah entitas penyedia LLM (misalnya Anthropic, OpenAI/Codex, GLM, Opencode). Connection adalah instance akun spesifik (kredensial API key atau token OAuth) yang terdaftar di dalam provider tersebut.
- **Relations:** Satu Provider dapat memiliki banyak Connection. Satu Connection memiliki status keaktifan, error lock status, dan kuota.
- **Source:** Analisis `open-sse/config/providers.js` dan `src/sse/services/auth.js` pada 9router.

### Model Combo & Routing Strategy
- **Meaning:** Pengelompokan daftar target model di bawah satu nama alias virtual. Saat client memanggil nama combo, gateway mencoba target pertama, dan bila gagal (rate-limit/outage) berpindah otomatis ke target berikutnya.
- **Relations:** Satu Combo menampung beberapa model target berurutan. Strategi menentukan urutan percobaan (`fallback`, `round-robin`, `lkgp`).
- **Source:** Analisis `open-sse/services/combo.js` (9router) dan `services/combo/applyStrategyOrdering.ts` (OmniRoute).

### Hub-and-Spoke Translation
- **Meaning:** Pola penerjemahan payload request dan response antar format vendor yang berbeda dengan menjadikan format OpenAI sebagai pivot tengah.
- **Relations:** Input Format → Pivot (OpenAI) → Target Format. Menghindari matriks penerjemah N*N.
- **Source:** Analisis `open-sse/translator/index.js` (9router).

## Runtime and Integrations <!-- auto -->
- Node.js 22+ — Runtime environment wajib; memanfaatkan fitur native `node:sqlite` (DatabaseSync) dan watch mode bawaan (`--watch`). Source: `package.json`.
- Hono & `@hono/node-server` — Web framework micro-overhead berbasis standar Web API (`fetch`, `Request`, `Response`). Source: `package.json`.
- Pi Coding Agent — Konsumen utama gateway via ekstensi `9router.ts` di port 20128. Source: `personal-work/9router.ts`.
- Claude Code, Codex CLI, Cursor — Klien sekunder yang berkomunikasi via standar `/v1/chat/completions` atau `/v1/messages`.

## Code Patterns <!-- auto -->
- Web API Native Handlers: Semua fungsi controller di `src/gateway/` menerima objek `Request` Web standar dan mengembalikan objek `Response` Web standar tanpa abstraksi proprietary framework.
- In-Process Streaming Transformation: Pengolahan Server-Sent Events (SSE) menggunakan `TransformStream` native untuk menyisipkan kalkulasi token dan translasi format chunk on-the-fly.
- Bounded Account Retry Loop: Pengulangan request ke akun berikutnya dibatasi hanya jika respon upstream mengindikasikan 429/401/5xx transient dan sebelum byte pertama dikirim ke client.

## Testing Map <!-- auto -->
- Health Check: `GET /health` memverifikasi server up dan port aktif.
- Model Listing: `GET /v1/models` memverifikasi registry provider termuat dan dapat dikueri.
- Chat Completion Mock: Memverifikasi penerjemahan request format OpenAI ke format provider upstream dan response streaming.

## Gotchas <!-- auto -->
- Stream Early Byte Leak: Jangan mengirim status HTTP 200 ke client sebelum header respon dari upstream provider dipastikan valid. Sekali header SSE dikirim ke client, failover ke akun lain tidak dapat dilakukan tanpa memutuskan stream.
- Windows Path Convention pada Node Module: Hindari path resolver berbasis string concatenation langsung; gunakan `node:path` untuk kompatibilitas Windows (CRLF & backslash).
- Native SQLite Thread Safety: `DatabaseSync` dari `node:sqlite` berjalan synchronous di event loop utama. Query harus terindeks dan tabel tetap ramping untuk menjaga throughput event loop.

## Historical Decisions <!-- auto -->
- Migrasi dari Next.js ke Hono: Menggantikan footprint 350 MB milik 9router dengan arsitektur Hono <5 MB karena gateway hanya membutuhkan proxy streaming dan form dashboard sederhana (lihat `ADR-1`).
- Penggabungan Proxy Pool ke Connection: Mengeliminasi menu manajemen pool terpisah dan menjadikan proxy sebagai atribut langsung pada setiap kredensial connection.

## References
- Repositori hulu 9router: https://github.com/decolua/9router
- Repositori referensi OmniRoute: https://github.com/diegosouzapw/OmniRoute
- Hono Documentation: https://hono.dev
