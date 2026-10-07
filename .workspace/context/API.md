# API — zenroute

Konvensi komunikasi frontend-backend dan integrasi service pihak ketiga.
Detail endpoint per fitur yang belum final disimpan di work card; endpoint approved dicatat di sini.

## Base Configuration <!-- auto -->
- Base URL: `http://127.0.0.1:20120` (env `PORT` dan `HOST`)
- Wire Format: JSON untuk control plane; SSE (`text/event-stream`) untuk respons streaming model
- Versioning: `/v1` untuk kompatibilitas OpenAI & Anthropic; `/api` dan `/dashboard` untuk control plane (loopback-only)

## Authentication & Headers <!-- auto -->
- `/v1`: API key zenroute (`Authorization: Bearer zr_...` atau `x-api-key: zr_...`) wajib bila `require_api_key` aktif atau server bind non-loopback.
- Header auth klien tidak diteruskan ke upstream.
- `POST /v1/*` wajib `Content-Type: application/json`.
- `x-zenroute-token-saver: false` melewati RTK dan Caveman untuk satu request.

## Endpoints <!-- auto -->
- `POST /v1/chat/completions` — format OpenAI; diterjemahkan ke format provider (termasuk tool calling & streaming SSE).
- `POST /v1/messages` — format Anthropic; jika diarahkan ke provider OpenAI/GLM, payload otomatis diterjemahkan ke format OpenAI dan respons dikembalikan dalam format Anthropic (termasuk tool calling & streaming).
- `POST /v1/responses` — format OpenAI Responses API (input + instructions); dinormalisasi ke Chat Completions dan dikembalikan dalam format Responses API.
- `GET /v1/models` — daftar model OpenAI Model List.
- `GET /api/usage?days=N`, `GET /api/quota` — statistik usage dan status kuota (loopback-only).
- `GET /health` — status service.

## Errors <!-- auto -->
- `/v1/chat/completions`, `/v1/models`: `{"error": {"message", "type", "code"}}`.
- `/v1/messages`: `{"type": "error", "error": {"type", "message"}}`.
- Status: 400 (body tidak valid), 401 (key zenroute hilang/tidak valid), 403 (Host/akses dashboard ditolak), 404 (model tidak dikenal), 415 (bukan JSON), 429 (diteruskan dari upstream), 502 (transport upstream gagal), 503 (tidak ada connection aktif), 504 (upstream tidak merespons).

## Third-Party Integrations <!-- auto -->
### Anthropic / Claude
- Endpoint: `https://api.anthropic.com/v1/messages`.
- Auth: `x-api-key` untuk connection `apikey`; `Authorization: Bearer` untuk connection `oauth`.

### GLM / Zhipu AI
- Endpoint: `https://api.z.ai/api/coding/paas/v4/chat/completions`. 9router memakai endpoint Anthropic `https://api.z.ai/api/anthropic/v1/messages`.
- Auth: `Authorization: Bearer`.

### Provider lain
- `codex`, `github`, `kiro`, `antigravity`: URL atau protokol di registry belum cocok dengan 9router (lihat Known Gaps di SRS.md).
