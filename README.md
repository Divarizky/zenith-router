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
- `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/responses`, `GET /v1/models`, streaming SSE dan non-streaming.
- Translasi penuh OpenAI ↔ Claude untuk `/v1/chat/completions` dan `/v1/messages` (termasuk translasi skema tool calling dan tool execution).
- Failover otomatis ke akun berikutnya saat 429 atau 5xx sebelum byte pertama dikirim, akun bermasalah diberi cooldown 60 detik.
- Connection per provider di SQLite, rotasi akun least-recently-used, refresh token proaktif & reaktif setelah 401/403, proxy HTTP/HTTPS per connection.
- Manajemen **Providers**: halaman terpadu untuk akun dan model per provider (OAuth, Free Tier, API Key) dengan toggle enable/disable dan penambahan model custom.
- **Sinkronisasi Model Gratis Otomatis**: OpenCode dan Kilo Code otomatis menyinkronkan katalog model gratis saat startup dan berkala (default tiap 6 jam), dilengkapi tombol *Sync Now*.
- **Import Model Live**: Import daftar model dari upstream (OpenCode, Kilo Code, GLM, GitHub, Claude) dengan pilihan filter model gratis/semua dan fitur *Delete Selected* berbasis checkbox.
- Registry 17 provider (codex, github, kiro, antigravity, glm, claude, opencode, kilocode, nvidia, cline, pollinations, cloudflare-ai, openrouter, llm7, bazaarlink, together, freebuff) disinkronkan dengan 9router & OmniRoute.
- API key gateway (`zr_...`) yang disimpan sebagai hash, akses dashboard hanya dari localhost, proteksi CSRF, DNS rebinding, dan header `Cache-Control: no-store` untuk mencegah stale state.
- Usage tracking untuk streaming (`stream_options.include_usage` + fallback estimasi) dan non-streaming, status kuota, RTK, Caveman (opt-in), dan halaman terpisah **Token Saver**.

Belum berfungsi:
- Alur login OAuth interaktif di browser (device code login UI / social login web popup).
- Live quota fetcher per vendor pihak ketiga (saat ini masih mock).

## Instalasi & Menjalankan

Syarat: **Node.js v22+** (karena menggunakan modul bawaan `node:sqlite`).

### 1. Clone & Jalankan Lokal
```bash
git clone <url-repo-zenroute>
cd zenroute
npm install
npm start          # atau: npm run dev
```

### 2. Pasang sebagai Global CLI (`zenroute`)
Dari dalam folder repository hasil clone:
```bash
npm link
```
Setelah itu, perintah `zenroute` dapat dipanggil dari direktori mana saja:
```bash
zenroute
```

Saat dijalankan di terminal interaktif (TTY), zenroute menampilkan banner status dan menu pilihan untuk membuka dashboard di browser.

## Langkah Pemakaian

1. Buka **Providers** (`http://127.0.0.1:20120/dashboard/providers`), pilih provider lalu tambahkan akun (misalnya API key GLM atau token Claude/Codex). Provider bertanda **Ready** (seperti OpenCode Free) bisa langsung dipakai tanpa akun.
2. Buka **API Keys**, buat key gateway untuk tiap coding agent/klien. Key lengkap hanya ditampilkan sekali saat dibuat.
3. Opsional: aktifkan **Require API Key** di **Settings**, atau atur optimasi prompt di **Token Saver**.
4. Kirim request dengan model berprefix provider:

```powershell
$key  = "zr_..."   # dari halaman API Keys
$body = @{ model = "glm/glm-5.2"; messages = @(@{ role = "user"; content = "Halo" }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://127.0.0.1:20120/v1/chat/completions" -Method Post `
  -ContentType "application/json" -Headers @{ Authorization = "Bearer $key" } -Body $body
```

Prefix menentukan provider (`cc`, `cx`, `gh`, `kr`, `ag`, `glm`, `oc`, `kc`, `nv`, `cl`, `pol`, `cf`, `or`, `llm7`, `bzl`, `together`, `fb`, atau id provider). Nama model setelah `/` diteruskan apa adanya.

Key zenroute hanya membuka akses ke gateway dan tidak pernah diteruskan ke provider. Kredensial provider selalu diambil dari database lokal; tanpa connection aktif (kecuali provider no-auth/free), gateway membalas 503.

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
| `ZENROUTE_MODEL_SYNC_INTERVAL_HOURS` | `6` | Interval sinkron model gratis (OpenCode, Kilo Code); `0` mematikan sinkron otomatis |

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
├── bin/
│   └── zenroute.js       # CLI entry point dengan interactive menu
├── src/
│   ├── index.js          # Entry point HTTP server, middleware, routes
│   ├── security.js       # Host guard, access control, CSRF, CORS, gateway auth
│   ├── db/               # node:sqlite repository dan skema database
│   ├── gateway/          # Handlers: chat.js, messages.js, responses.js, models.js
│   ├── translator/       # Translasi bidirectional OpenAI <-> Claude (schema & tool calling)
│   ├── providers/        # Registry 17 provider & model routing resolution
│   ├── executors/        # base.js (header & idle timeout), proxy.js, freebuff.js
│   ├── config/           # freeTierCatalog.js
│   ├── services/         # apiKeys, auth, tokenRefresh, usage, quota, modelOverrides,
│   │                     # modelImport, modelSync, tokenSaver, rtk, caveman, settings
│   └── ui/               # layout.js, cliMenu.js, html.js, pages/ (overview, providers, usage, keys, etc.)
├── tests/                # Test suite lengkap (129 tests)
└── package.json
```
