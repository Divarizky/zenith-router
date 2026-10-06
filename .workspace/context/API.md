# API — zenroute

Konvensi komunikasi frontend-backend dan integrasi service pihak ketiga.
Detail endpoint per fitur yang belum final disimpan di work card; endpoint approved dicatat di sini.

## Base Configuration <!-- auto -->
- Base URL: `http://localhost:20128` (dapat diubah via `PORT` env var)
- Wire Format: JSON untuk RPC & control plane; SSE (`text/event-stream`) untuk model responses
- Versioning: `/v1` untuk kompatibilitas OpenAI & Anthropic; `/api` untuk internal control plane

## Authentication & Headers <!-- auto -->
- Gateway Public Proxy: Opsional `Authorization: Bearer <zr_api_key>` (bila `requireApiKey` aktif di settings).
- Control Plane API: Wajib menyertakan key autentikasi lokal bila diakses dari remote host.

## Conventions & Errors <!-- auto -->
- Endpoint OpenAI Standar: `POST /v1/chat/completions`
- Endpoint Anthropic Standar: `POST /v1/messages`
- Endpoint Responses Standar: `POST /v1/responses`
- Model Discovery: `GET /v1/models`
- Format error mengikuti format OpenAI standar: `{"error": {"message": "...", "type": "...", "code": "..."}}`.
- Status codes: 200 (OK), 400 (Bad Request), 401 (Unauthorized), 404 (Model Not Found), 429 (Upstream Exhausted), 502 (Bad Gateway Upstream), 504 (Gateway Timeout).

## Third-Party Integrations <!-- auto -->
### Anthropic / Claude
- Endpoint: Upstream Anthropic Messages API (`https://api.anthropic.com/v1/messages`).
- Auth: Bearer OAuth session token atau `x-api-key`.
- Fallback: Auto failover ke akun alternatif jika limit rate hit.

### OpenAI / Codex
- Endpoint: Upstream Responses API atau Chat Completions API.
- Auth: Bearer token OAuth atau direct API Key.

### GLM / Zhipu AI
- Endpoint: `https://api.z.ai/api/coding/paas/v4/chat/completions` / `/messages`.
- Auth: Bearer token.
