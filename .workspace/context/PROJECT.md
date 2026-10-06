# PROJECT — zenroute

Quick reference untuk agent — baca sebelum eksekusi skill di project ini.
Precedence: instruksi user saat ini > file ini > CONTEXT.md > asumsi.

## Commands <!-- auto -->
- Run: `node src/index.js` — Jalankan server zenroute di port 20128
- Dev: `node --watch src/index.js` — Jalankan dengan auto-reload bawaan Node 22+
- Test Health: `curl http://localhost:20128/health` — Verifikasi status service

## File Map <!-- auto -->
- `src/index.js` — Entry point server Hono, definisi route HTTP & listener port
- `src/db/index.js` — Inisialisasi engine `node:sqlite` dan migrasi skema tabel
- `src/gateway/chat.js` — Handler utama `/v1/chat/completions` (OpenAI format)
- `src/gateway/messages.js` — Handler `/v1/messages` (Claude format)
- `src/gateway/responses.js` — Handler `/v1/responses` (Codex/Responses format)
- `src/gateway/models.js` — Handler katalog model `/v1/models`
- `src/translator/index.js` — Hub-and-spoke request & response translation engine
- `src/providers/index.js` — Registry loader untuk 8 provider utama
- `src/executors/base.js` — Base HTTP client executor dengan timeout, retry & proxy
- `src/services/auth.js` — Manajemen akun koneksi, rotasi, dan cooldown
- `src/services/combo.js` — Strategi fallback & round-robin model combo
- `src/services/usage.js` — Pencatatan konsumsi token dan tracking kuota
- `src/services/tokenSaver.js` — Engine kondensasi context (RTK & Caveman)
- `src/ui/layout.js` — Base layout SSR dashboard berbasis Hono JSX
- `package.json` — Konfigurasi package ESM dan dependencies minimal (`hono`, `@hono/node-server`)

## Core Terms <!-- auto -->
- `zenroute` — Gateway proxy AI personal ultra-ringan berbasis Hono untuk coding agent
- `provider` — Layanan upstream penyedia LLM (Claude, Codex, GLM, dll.)
- `connection` — Satu akun kredensial (OAuth token atau API key) milik suatu provider
- `combo` — Kumpulan beberapa model/provider dengan strategi failover otomatis
- `pivot format` — Format OpenAI yang dijadikan standar perantara dalam translasi payload
- `RTK` — Reduced Token Kit, algoritma pemangkasan konteks teks berulang dan log
- `modelLock` — Kuncian sementara pada akun yang terkena rate limit untuk model tertentu

## Conventions <!-- auto -->
- Port default: `20128` (wajib sinkron dengan konfigurasi agent Pi dan coding tool)
- Standar HTTP: Memakai native `Request` dan `Response` Web API di semua handler
- Zero external build: Tidak ada bundler frontend (Vite/Webpack/Next.js); UI di-render server oleh Hono JSX
- Database: Wajib menggunakan `node:sqlite` (`DatabaseSync`), tanpa dependensi native C++

## Advanced Details
Domain/pattern/gotcha → `CONTEXT.md` · Security → `SECURITY.md` · Style → `CODE_STYLE.md` · Data → `DATABASE.md` · Endpoints → `API.md` · Requirement baseline → `SRS.md` · Work aktif → `work/F-<id>.md` · Progres → `TRACKER.md` · Keputusan final → `ADR.md`
