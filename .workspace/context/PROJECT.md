# PROJECT — zenroute

Quick reference untuk agent — baca sebelum eksekusi skill di project ini.
Precedence: instruksi user saat ini > file ini > CONTEXT.md > asumsi.

## Commands <!-- auto -->
- Run: `npm start` (`node src/index.js`) — server di `http://127.0.0.1:20120`
- Dev: `npm run dev` — auto-reload bawaan Node 22+
- Test: `npm test` — `node --test`, database otomatis `:memory:`
- Health: `curl http://127.0.0.1:20120/health`
- PowerShell dengan execution policy terbatas: pakai `npm.cmd` (contoh `npm.cmd test`)

## File Map <!-- auto -->
- `src/index.js` — Entry point Hono, urutan middleware keamanan, route, dan bind `HOST`/`PORT`
- `src/security.js` — Host guard, akses dashboard loopback-only + CSRF, CORS opt-in, wajib JSON, auth API key `/v1`
- `src/db/index.js` — `node:sqlite`, skema, CRUD connections
- `src/gateway/chat.js` — `/v1/chat/completions` (format OpenAI)
- `src/gateway/messages.js` — `/v1/messages` (format Anthropic, translasi lintas format)
- `src/gateway/responses.js` — `/v1/responses` (OpenAI Responses API)
- `src/gateway/models.js` — `/v1/models`
- `src/translator/` — Translasi OpenAI ↔ Claude (teks & tool calling)
- `src/providers/` — Registry 8 provider dan resolusi `prefix/model`
- `src/executors/base.js` — Fetch upstream dengan headers timeout dan idle timeout
- `src/executors/proxy.js` — Proxy HTTP/HTTPS (CONNECT) per connection
- `src/services/apiKeys.js` — API key gateway (hash SHA-256, aktif/nonaktif)
- `src/services/auth.js` — Pemilihan connection, rotasi, cooldown, header auth upstream
- `src/services/fallback.js` — Eksekusi upstream dengan failover otomatis ke connection berikutnya pada 429/5xx
- `src/services/tokenRefresh.js` — Refresh token OAuth (proaktif dan setelah 401/403)
- `src/services/usage.js`, `src/services/quota.js` — Usage tracking dan status kuota
- `src/services/tokenSaver.js`, `rtk.js`, `caveman.js` — Token saver
- `src/services/settings.js` — Key-value settings dan default
- `src/ui/` — Dashboard HTML template string (`html.js` untuk escaping)

## Core Terms <!-- auto -->
- `zenroute` — Gateway proxy AI personal berbasis Hono untuk coding agent
- `provider` — Layanan upstream penyedia LLM (Claude, Codex, GLM, dll.)
- `connection` — Satu kredensial upstream (API key atau OAuth token) milik suatu provider
- `gateway API key` — Key `zr_...` untuk mengakses zenroute; terpisah dari kredensial upstream
- `pivot format` — Format OpenAI sebagai perantara translasi payload
- `RTK` — Pemadatan baris berulang pada teks yang diketik user

## Conventions <!-- auto -->
- Port default `20120` (9router memakai 20128); bind default `127.0.0.1`
- Handler memakai `Request`/`Response` Web API standar
- Tanpa bundler frontend; dashboard dirender sebagai template string HTML, semua nilai dinamis lewat `escapeHtml`
- Database wajib `node:sqlite` (`DatabaseSync`), tanpa dependensi native
- Header auth klien tidak pernah diteruskan ke upstream

## Advanced Details
Domain/pattern/gotcha → `CONTEXT.md` · Security → `SECURITY.md` · Style → `CODE_STYLE.md` · Data → `DATABASE.md` · Endpoints → `API.md` · Requirement baseline → `SRS.md` · Work aktif → `work/F-<id>.md` · Progres → `TRACKER.md` · Keputusan final → `ADR.md`
