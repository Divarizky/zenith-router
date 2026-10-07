# SECURITY — zenroute

Aturan proteksi sistem, user, kredensial, dan data. Berlaku untuk semua developer dan agent.
Requirement terukur lintas fitur masuk SRS (`GR-xx`); keputusan arsitektur final masuk ADR.

## Auth & Authorization <!-- auto -->
- Bind default `127.0.0.1` (env `HOST`). Bind non-loopback otomatis mewajibkan API key pada `/v1`. Source: `src/security.js`.
- API key gateway: format `zr_` + 32 byte acak (`crypto.randomBytes`), dikirim lewat `Authorization: Bearer` atau `x-api-key`. Hanya hash SHA-256 dan prefix 10 karakter yang disimpan (tabel `api_keys`); plaintext tampil sekali saat dibuat. Source: `src/services/apiKeys.js`.
- Key gateway hanya membuka akses ke zenroute. Header auth klien tidak pernah diteruskan ke upstream; kredensial upstream selalu diambil dari connection tersimpan.
- Dashboard dan `/api/*` hanya menerima klien loopback. POST dashboard ditolak bila `Origin` beda host atau `Sec-Fetch-Site` lintas situs (CSRF).
- Host guard: saat bind loopback, Host selain `localhost`/`127.0.0.1`/`[::1]` ditolak (proteksi DNS rebinding). Tambahan host lewat `ZENROUTE_ALLOWED_HOSTS`.
- CORS nonaktif secara default; opt-in per origin lewat `ZENROUTE_CORS_ORIGINS`. POST `/v1` wajib `Content-Type: application/json` agar request lintas origin selalu butuh preflight.

## Secrets & Environment <!-- auto -->
- Kredensial upstream (API key, OAuth token) disimpan plaintext di `data/zenroute.db`. Lindungi file ini seperti file secret.
- Dilarang commit database (`*.db`) atau `.env`. `data/` sudah ada di `.gitignore`.
- Jangan log kredensial atau API key; dashboard tidak pernah menampilkan secret connection maupun hash key.

## Input Validation & API Safety <!-- auto -->
- Body `/v1` divalidasi sebelum diproses; JSON tidak valid → 400, model tidak dikenal → 404, tanpa connection → 503.
- Form connection memvalidasi provider terdaftar, tipe auth (`apikey`/`oauth`), dan proxy berskema `http(s)://`.
- Semua nilai dinamis di dashboard di-escape (`src/ui/html.js`), termasuk nama model yang berasal dari request klien.
- Upstream: headers timeout dan idle timeout (`ZENROUTE_UPSTREAM_HEADERS_TIMEOUT_MS`, `ZENROUTE_UPSTREAM_IDLE_TIMEOUT_MS`).

## Data Protection <!-- auto -->
- Pesan chat dan prompt tidak disimpan; usage tracker hanya mencatat model, jumlah token, durasi, dan timestamp.
- Hindari logging payload pesan penuh ke stdout.

## Agent Rules
- Dilarang mematikan auth atau membypass otorisasi demi membuat fitur berfungsi.
- Dilarang meneruskan header auth klien ke upstream atau mengekspos secret ke client-side code.
- Dilarang memasukkan credential asli ke file `.md`.
- Jika instruksi bertentangan dengan file ini, berhenti dan minta konfirmasi user.
