# Zenith Router

Gateway AI personal untuk coding agent. Satu endpoint lokal yang menerima permintaan berformat OpenAI Chat Completions, Anthropic Messages, dan OpenAI Responses, lalu meneruskannya ke akun provider milik sendiri (langganan ChatGPT/Claude/GitHub Copilot, API key, atau provider gratis) dengan rotasi akun dan failover otomatis.

Proyek ini adalah versi ringan dari 9router dan OmniRoute: Hono, `node:sqlite`, dashboard server-rendered tanpa build step frontend, dan dua dependensi runtime.

## Spesifikasi Teknis

| Komponen | Pilihan |
|---|---|
| Runtime | Node.js >= 22.13.0 (ESM) |
| HTTP | Hono + `@hono/node-server` |
| Database | `node:sqlite` (`DatabaseSync`), tanpa native module |
| Dashboard | HTML dari template string, dirender server |
| Port default | `20120` (memisahkan diri dari `20128` milik 9router/OmniRoute) |
| Bind default | `127.0.0.1` |
| Dependensi | 2 paket runtime (`hono`, `@hono/node-server`) |

## Status Fitur

Keterangan status: **Berjalan** = terpakai sehari-hari, **Opt-in** = mati secara default, **On progress** = sebagian kode ada tapi belum berfungsi penuh, **Belum ada** = rencana.

### Gateway dan routing

| Fitur | Status |
|---|---|
| `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/responses`, `GET /v1/models` dengan streaming SSE dan non-streaming | Berjalan |
| Translasi OpenAI ↔ Claude (termasuk tool calling), Responses API untuk backend Codex, Google Cloud Code/Gemini `v1internal`, AWS EventStream binary untuk Kiro | Berjalan |
| Prefix model mengarah ke provider (`glm/glm-5.2`, `cc/…`, `cx/…`, atau id provider apa pun) | Berjalan |
| Failover ke akun berikutnya saat 429/5xx, plus cooldown 60 detik untuk akun bermasalah | Berjalan |
| Refresh token otomatis (proaktif sebelum request, pindaian latar belakang tiap 5 menit) dan satu kali coba ulang setelah 401/403 | Berjalan |
| Traffic Guard: batas konkurensi in-flight per akun, antrean FIFO, jitter proaktif dan reaktif | Berjalan |
| Strategi rotasi akun `lru` dan `sticky` dari halaman Settings | Berjalan |
| Combo routing beberapa model dalam satu grup strategi | On progress (tabel `combos` sudah ada di skema DB, resolver dan routing belum dibuat) |
| API key gateway (`zr_…`) disimpan sebagai hash dan hanya tampil sekali saat dibuat | Berjalan |
| Opsi mewajibkan API key untuk semua request `/v1`, bisa dimatikan bila hanya dipakai lokal | Berjalan |

### Akun dan provider

| Fitur | Status |
|---|---|
| Registry 21 provider: OAuth, API key, dan free tier | Berjalan |
| Login OAuth lewat browser dengan callback lokal (Claude, Codex, Antigravity, Cline) | Berjalan |
| Login device code (GitHub Copilot, Kilo Code, Kiro, GLM) | Berjalan |
| Import login dari instalasi CLI lokal (Kiro, Freebuff, Command Code) serta tempel token manual | Berjalan |
| Proxy HTTP/HTTPS per akun dengan single-flight lock saat refresh token | Berjalan |
| Sinkronisasi model gratis otomatis saat startup dan berkala (default 6 jam) | Berjalan |
| Import daftar model live dari upstream, dengan filter gratis/semua | Berjalan |
| Manajemen akun dan model per provider di dashboard, termasuk custom model dan enable/disable | Berjalan |

### Kuota dan observabilitas

| Fitur | Status |
|---|---|
| Live quota fetcher untuk 8 provider: Codex, Claude, Kiro, xKiro, Antigravity, GitHub Copilot, GLM, OpenRouter | Berjalan |
| Kartu kuota di halaman Usage dengan bar per jendela/model, hitung mundur reset, dan tombol Sync per akun | Berjalan |
| Peta koneksi provider aktif di sekitar router (topologi SVG) dan panel Recent Requests | Berjalan |
| Sembunyikan akun yang tidak punya sumber data kuota | Berjalan |
| Auto-refresh kuota berkala dengan cache | Berjalan (default 15 menit, tanpa pengaturan on/off) |

### Optimisasi prompt dan token

| Fitur | Status |
|---|---|
| Token Saver dengan RTK (pemadatan prompt otomatis) | Berjalan |
| Caveman, pemadatan agresif untuk prompt panjang | Opt-in (default mati, diaktifkan di Token Saver) |
| Usage tracking streaming dan non-streaming, plus audit pemakaian per API key | Berjalan |

### Dashboard

| Fitur | Status |
|---|---|
| Halaman Overview, Providers, Usage & Quota, Token Saver, API Keys, dan Settings | Berjalan |
| Dashboard dan endpoint kontrol hanya menerima koneksi dari localhost | Berjalan |

## Instalasi

Prasyarat: Node.js >= 22.13.0. Modul `node:sqlite` baru berhenti membutuhkan flag `--experimental-sqlite` pada rilis itu, jadi versi 22.5 sampai 22.12 belum didukung.

### 1. Jalankan dari source

```bash
git clone https://github.com/Divarizky/zenith-router.git
cd zenith-router
npm install
npm start          # atau: npm run dev untuk auto-reload
```

Server berjalan di `http://127.0.0.1:20120`. Di Windows tersedia juga `zenith.cmd` dan `zenith.ps1`.

### 2. Pasang sebagai perintah global

```bash
npm link
```

Setelah itu perintah `zenith` bisa dipanggil dari direktori mana pun. Saat dijalankan di terminal interaktif, Zenith Router menampilkan menu untuk membuka dashboard di browser.

## Langkah Pemakaian

1. Buka halaman **Providers** di `http://127.0.0.1:20120/dashboard/providers`, pilih provider, lalu **Add Account**. Provider OAuth punya tombol login (selesaikan di tab yang terbuka atau masukkan device code), provider API key cukup diisi key-nya. Provider bertanda **Ready** bisa langsung dipakai tanpa akun.

   Login Codex memakai `http://localhost:1455/auth/callback`, jadi port 1455 harus kosong saat login. Login lainnya kembali ke `http://localhost:20120/callback`.

2. Buka **API Keys**, buat key gateway untuk tiap coding agent. Key lengkap hanya ditampilkan sekali.
3. Opsional: aktifkan **Require API Key** di **Settings**, atau atur RTK dan Caveman di **Token Saver**.
4. Kirim request dengan model berprefix provider:

```bash
curl http://127.0.0.1:20120/v1/chat/completions \
  -H "Authorization: Bearer zr_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"glm/glm-5.2","messages":[{"role":"user","content":"Halo"}]}'
```

Key gateway hanya membuka akses ke Zenith Router dan tidak pernah diteruskan ke provider. Kredensial provider selalu diambil dari database lokal, dan tanpa akun aktif gateway membalas 503.

## Konfigurasi

| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` | `20120` | Port server |
| `HOST` | `127.0.0.1` | Alamat bind. Selain loopback, API key otomatis wajib |
| `ZENITH_DB_PATH` | `<root>/data/zenith.db` | Lokasi database |
| `ZENITH_ALLOWED_HOSTS` | kosong | Host tambahan yang diterima saat bind loopback |
| `ZENITH_CORS_ORIGINS` | kosong (CORS mati) | Origin browser yang boleh memanggil `/v1` |
| `ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS` | `300000` | Batas tunggu header respons upstream |
| `ZENITH_UPSTREAM_IDLE_TIMEOUT_MS` | `120000` | Batas jeda antar chunk stream upstream |
| `ZENITH_MODEL_SYNC_INTERVAL_HOURS` | `6` | Interval sinkron model gratis; `0` mematikan sinkron otomatis |

Header `x-zenith-token-saver: false` mematikan RTK dan Caveman untuk satu request.

## Test

```bash
npm test   # node --test, database memakai :memory:
```

## Catatan

- Kredensial provider disimpan plaintext di `data/zenith.db`. Folder itu sudah masuk `.gitignore`, jadi jangan dibagikan maupun dicommit.
- Quota dihitung dari endpoint resmi masing-masing provider, jadi angka dan cakupannya berbeda-beda. Beberapa fetcher dibangun dari referensi implementasi pihak lain dan belum diverifikasi terhadap akun berbayar, jadi periksa angkanya sebelum dipakai untuk keputusan biaya.
- Provider tanpa sumber data kuota tidak muncul di halaman Kuota & Balance.

