# zenroute

Gateway AI personal yang ringan untuk coding agent, kompatibel dengan endpoint OpenAI Chat Completions dan Anthropic Messages. Disederhanakan dari 9router dan OmniRoute: Hono, `node:sqlite`, tanpa build step frontend, dan hanya 2 dependensi runtime.

## Spesifikasi Teknis

- **Runtime**: Node.js 22+ (ESM)
- **HTTP**: Hono + `@hono/node-server`
- **Database**: `node:sqlite` (`DatabaseSync`), tanpa kompilasi native
- **Dashboard**: HTML template string yang dirender server, tanpa React/Next.js
- **Port Default**: `20120` (dipisahkan agar tidak tabrakan dengan 9router/OmniRoute di port `20128`)
- **Bind Default**: `127.0.0.1`

## Status Fitur

Sudah berfungsi:
- `POST /v1/chat/completions`, `POST /v1/messages`, `GET /v1/models`, streaming SSE dan non-streaming.
- Translasi teks OpenAI ↔ Claude untuk `/v1/chat/completions`.
- Connection per provider di SQLite, rotasi akun least-recently-used, cooldown 60 detik setelah 429, refresh token sekali setelah 401/403, proxy HTTP/HTTPS per connection.
- API key gateway (`zr_...`) yang disimpan sebagai hash, akses dashboard hanya dari localhost, proteksi CSRF dan DNS rebinding.
- Usage tracking (non-streaming), status kuota, RTK, Caveman (opt-in), dan dashboard.

Belum berfungsi:
- Tool calling lintas vendor, translasi `/v1/messages` ke provider non-Claude, dan `/v1/responses`. Claude Code dan Codex CLI belum bisa dipakai lewat zenroute.
- Login OAuth dan refresh token otomatis di background.
- Provider `codex`, `github`, `kiro`, `antigravity`: URL atau protokolnya belum disesuaikan dengan 9router.
- Failover ke akun berikutnya saat 429/5xx, dan combo routing.
- Hitungan token untuk request streaming (tercatat 0).

## Menjalankan

```powershell
cd zenroute
npm install
npm start          # atau: npm run dev
```

Kalau PowerShell memblokir `npm.ps1`, pakai `npm.cmd start`. Dashboard ada di `http://127.0.0.1:20120/dashboard`.

## Langkah Pemakaian

1. Buka **Connections**, tambahkan kredensial provider (misalnya `glm` dengan API key).
2. Buka **API Keys**, buat key untuk tiap klien. Key lengkap hanya tampil sekali.
3. Opsional: aktifkan **Require API Key** di **Settings**.
4. Kirim request dengan model berprefix provider:

```powershell
$key  = "zr_..."   # dari halaman API Keys
$body = @{ model = "glm/glm-5.2"; messages = @(@{ role = "user"; content = "Halo" }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://127.0.0.1:20120/v1/chat/completions" -Method Post `
  -ContentType "application/json" -Headers @{ Authorization = "Bearer $key" } -Body $body
```

Prefix menentukan provider (`cc`, `cx`, `gh`, `kr`, `ag`, `glm`, `oc`, `kc`, atau id provider). Nama model setelah `/` diteruskan apa adanya.

Key zenroute hanya membuka akses ke gateway dan tidak pernah diteruskan ke provider. Kredensial provider selalu diambil dari Connections; tanpa connection aktif, gateway membalas 503.

## Konfigurasi (Environment)

| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` | `20120` | Port server |
| `HOST` | `127.0.0.1` | Alamat bind. Selain loopback, API key otomatis wajib |
| `ZENROUTE_DB_PATH` | `<root>/data/zenroute.db` | Lokasi database |
| `ZENROUTE_ALLOWED_HOSTS` | kosong | Host tambahan yang diterima saat bind loopback |
| `ZENROUTE_CORS_ORIGINS` | kosong (CORS mati) | Origin browser yang boleh memanggil `/v1` |
| `ZENROUTE_UPSTREAM_HEADERS_TIMEOUT_MS` | `300000` | Batas tunggu header respons upstream |
| `ZENROUTE_UPSTREAM_IDLE_TIMEOUT_MS` | `120000` | Batas jeda antar-chunk stream upstream |

Header `x-zenroute-token-saver: false` mematikan RTK dan Caveman untuk satu request.

## Keamanan

- Server listen di `127.0.0.1`; dashboard dan `/api/*` hanya menerima klien localhost.
- Kredensial provider tersimpan plaintext di `data/zenroute.db`. Jangan bagikan atau commit file ini.
- Detail lengkap ada di `.workspace/context/SECURITY.md`.

## Test

```powershell
npm test   # node --test, database otomatis :memory:
```

## Struktur Folder

```
zenroute/
├── src/
│   ├── index.js          # Entry point, middleware, route, bind HOST/PORT
│   ├── security.js       # Host guard, akses dashboard, CSRF, CORS opt-in, auth /v1
│   ├── db/               # node:sqlite dan skema
│   ├── gateway/          # chat.js, messages.js, models.js
│   ├── translator/       # OpenAI <-> Claude
│   ├── providers/        # Registry 8 provider
│   ├── executors/        # base.js (timeout), proxy.js
│   ├── services/         # apiKeys, auth, tokenRefresh, usage, quota, tokenSaver, rtk, caveman, settings
│   └── ui/               # layout, html.js (escaping), pages/
├── tests/
└── package.json
```
