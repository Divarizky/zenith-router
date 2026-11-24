# Zenith Router

<p align="center">
  <strong>Ultra-lightweight, zero-telemetry personal AI gateway for coding agents.</strong><br>
  Unified endpoint for OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses with automated multi-account rotation and failover.
</p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg" alt="Node.js version"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/version-2.2.0-blue.svg" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-purple.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/architecture-zero--telemetry-success.svg" alt="Zero Telemetry">
  <img src="https://img.shields.io/badge/storage-node%3Asqlite-orange.svg" alt="Embedded SQLite">
</p>

---

Zenith Router adalah gateway AI lokal mandiri untuk coding agents (Pi, Cursor, Claude Code, Cline, Roo Code, Aider) dan aplikasi apa pun yang menggunakan protokol OpenAI/Anthropic. Satu endpoint menerima permintaan berformat OpenAI Chat Completions, Anthropic Messages, maupun OpenAI Responses, lalu meneruskannya ke akun provider milik Anda sendiri: langganan Claude Pro/Team, ChatGPT/Codex, GitHub Copilot, Kiro, Antigravity, Cline, API key provider, sesi web DeepSeek, Nous Portal / Hermes, atau provider gratis dengan rotasi akun dan failover otomatis.

Zenith Router berjalan 100% lokal, tanpa akun cloud perantara, tanpa analitik atau telemetry, dan tanpa dependensi runtime berat. Seluruh kredensial tersimpan aman di database SQLite lokal mesin Anda.

---

## ⚡ Architecture Flow

```
[ Coding Agents / Clients ] (Pi, Cursor, Cline, Claude Code, Aider, SDKs)
             │
             │ OpenAI (/v1/chat/completions)
             │ Anthropic (/v1/messages)
             │ Responses API (/v1/responses)
             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      ZENITH ROUTER (Port 20120)                        │
├────────────────────────────────────────────────────────────────────────┤
│ 🛡️  Traffic Guard     : In-flight limit, antrean FIFO, & jitter proaktif │
│ 🔀  Model Combos      : Failover cerdas & agregasi multi-provider       │
│ 🔒  DLP Guard         : Redaksi otomatis kredensial & secret rahasia   │
│ ⚡  Token Saver       : Kompresi prompt via RTK & Caveman mode         │
│ 🌐  Proxy Pools       : Rotasi proxy HTTP/HTTPS/SOCKS5 per akun         │
│ 🔄  Protocol Engine   : Translasi bidirectional OpenAI ⇄ Claude ⇄ EventStream │
└────────────────────────────────────────────────────────────────────────┘
             │
             ▼
[ Upstream AI Providers ] (21 Built-in Providers + Custom BYOP)
Claude · Codex · Copilot · Kiro · Antigravity · GLM · Nous · OpenRouter · BYOP...
```

---

## ✨ Fitur Utama

- **Protokol Terpadu & Universal Translator:** Menerima format OpenAI (`/v1/chat/completions`), Anthropic (`/v1/messages`), dan OpenAI Responses (`/v1/responses`), baik streaming SSE maupun non-streaming. Translasi otomatis tool-calling lintas protokol (dialek JSON schema, tool_use Claude, function_call Responses, hingga DSML).
- **21 Provider Built-in + BYOP (Bring Your Own Provider):** Mendukung login OAuth dengan PKCE, device code flow, import session browser, API key, free tier tanpa login, dan custom endpoint OpenAI/Claude. Termasuk provider **Nous Portal / Hermes (`nous`)** dengan login device code, auto-sync model gratis, dan pacing serial turns.
- **Failover & Rotasi Akun Cerdas:** Failover otomatis ke akun berikutnya saat terkena rate-limit (429) atau server down (5xx), dilengkapi cooldown cerdas, parsing `retry_after` langsung dari body respons, refresh token otomatis (dengan penanda status `needs_login`), dan budget dispatch bersama pada retry OpenCode.
- **Model Combos:** Agregasi virtual model lintas provider dalam satu alias (misalnya `combo/smart-coding`) dengan urutan prioritas fallback otomatis dan rebuild otomatis pasca sinkronisasi katalog.
- **Proxy Pools & Cloudflare WARP Lanes:** Manajemen pool proxy HTTP, HTTPS, dan SOCKS5 langsung dari dashboard, uji latensi dan IP egress per pool, rotasi proxy per provider, penugasan bound accounts, tipe `gateway` dengan retry budget & webhook rotasi, serta readiness lane WARP.
- **OpenCode Egress Policy:** Pilih kebijakan proxy `legacy`, `direct`, `prefer`, atau `require`; mode `require` menolak request dengan `503 proxy_required` bila proxy wajib tidak tersedia. Mode hybrid WARP/Proton bersifat opt-in, memakai registry pool eksplisit, dan menyediakan `shadow` pasif sebelum `enforce`. Lihat [panduan OpenCode hybrid egress](docs/opencode-hybrid-egress.md).
- **Live Quota Scraper (10 Provider):** Memantau sisa kuota, jendela batas pemakaian (5 jam, harian, mingguan), dan waktu reset akun secara akurat tanpa perlu membuka situs provider.
- **Peningkatan OpenAI Codex & Responses API:** Sinkronisasi model Codex otomatis pasca login OAuth, auto-generate `prompt_cache_key`, pelaporan cached/estimated tokens, dan dukungan tangga level thinking hingga `xhigh` dan `max`.
- **Tingkat Berpikir Fleksibel (Adaptive & XHigh):** Dukungan level thinking `xhigh` pada Google Antigravity dan tangga thinking penuh pada OpenAI Codex serta Claude via prefix model.
- **Data Loss Prevention (DLP):** Redaksi dan sensor otomatis kredensial, kunci API, dan token privat sebelum meninggalkan mesin Anda.
- **Zero-Overhead Token Saver:** Pemadatan prompt otomatis menggunakan algoritma RTK dan mode Caveman opsional untuk menghemat konsumsi token konteks.
- **Dukungan Multi-Language (ID & EN):** Antarmuka web dashboard mendukung dwi-bahasa (Bahasa Indonesia dan English) dengan tombol switcher cepat di sidebar tanpa reload halaman dan pilihan bahasa permanen di pengaturan.
- **Web Dashboard & Admin Security:** Dilengkapi antarmuka Web modern bertema neo-brutalism dengan dark/light theme, visualisasi kuota, audit log penggunaan, dan proteksi login password / admin token.

---

## 🔌 Provider yang Didukung (21 Built-in + BYOP)

| Prefix | Provider | Autentikasi | Live Quota | Tool Calling |
|---|---|---|:---:|:---:|
| `cc` | Claude (Anthropic) | OAuth 2.0 PKCE | ✅ | ✅ |
| `cx` | OpenAI Codex | OAuth / Browser Callback | ✅ | ✅ |
| `gh` | GitHub Copilot | Device Code / OAuth | ✅ | ✅ |
| `kr` | Kiro AI | Free tier | ✅ | ✅ |
| `ag` | Antigravity (Google) | OAuth | ✅ | ✅ |
| `xkr` | xKiro | API key | ✅ | ✅ |
| `cl` | Cline | OAuth | — | ✅ |
| `cmc` | Command Code | OAuth | ✅ | ✅ |
| `glm` | Zai GLM Coding | OAuth / Device code | ✅ | ✅ |
| `kc` | Kilo Code | OAuth | — | ✅ |
| `kcf` | Kilo Code Free Tier | Free tier (Tanpa login) | — | ✅ |
| `fb` | Freebuff | OAuth / Import lokal | — | ✅ |
| `or` | OpenRouter | API key | ✅ | ✅ |
| `oc` | OpenCode Free | Free tier (Tanpa login) | — | ✅ |
| `nv` | NVIDIA NIM | API key | — | ✅ |
| `ovh` | OVHcloud AI Endpoints | Free tier (Tanpa login) | — | ✅ |
| `tg` | Together AI | API key | — | ✅ |
| `ol` | Ollama Cloud | API key | ✅ | ✅ |
| `l7` | LLM7 | API key | — | ✅ |
| `nous` | Nous Research (Hermes) | OAuth Device Code / API key | — | ✅ |
| `dsw` | DeepSeek Web Chat | Token sesi browser / CDP | — | ✅ |
| *custom* | **Custom Provider (BYOP)** | OpenAI / Claude Endpoint | — | ✅ |

> **Catatan Prefix:** Anda dapat memanggil model menggunakan prefix singkat (misal `cc/claude-3-7-sonnet`, `cx/gpt-4o`, `glm/glm-4`, `nous/hermes-3-llama-3.1-405b`) maupun nama lengkap provider (misal `together/meta-llama/Llama-3-70b-chat-hf`).

---

## 🚀 Quickstart

### Kebutuhan Sistem
* **Node.js >= 22.13.0 (ESM)** dengan modul bawaan `node:sqlite`.
* Port `20120` tersedia pada mesin lokal.

### 1. Instalasi dan Menjalankan

```bash
# Clone repository
git clone https://github.com/Divarizky/zenith-router.git
cd zenith-router

# Install dependensi
npm install

# Jalankan server
npm start          # atau 'npm run dev' untuk live reload saat pengembangan
```

Server default berjalan di `http://127.0.0.1:20120`. Untuk pengguna Windows, tersedia skrip eksekusi cepat `zenith.cmd` dan `zenith.ps1`.

### 2. Instalasi Global (CLI)

```bash
npm link
```
Setelah terpasang, perintah `zenith` dapat dipanggil dari terminal mana pun untuk membuka gateway dan dashboard interaktif.

---

## ⚙️ Menyiapkan Akun dan Gateway

1. **Buka Web Dashboard:** Kunjungi `http://127.0.0.1:20120/dashboard` di browser Anda.
2. **Tambah Akun Provider:** Masuk ke tab **Providers**, pilih provider yang Anda miliki, dan klik **Add Account**:
   * *OAuth Provider (Claude, Copilot, Antigravity, Nous Research, dll):* Klik tombol login browser atau selesaikan device code (untuk Nous, selesaikan verifikasi di portal Hermes).
   * *API Key Provider (OpenRouter, NVIDIA, dll):* Masukkan API key Anda.
   * *Free Provider (Kilo Free, OpenCode, OVH):* Langsung aktif dan siap dipakai.
   * *DeepSeek Web:* Gunakan fitur **Login sekali klik di browser** via Chrome DevTools Protocol atau tempel `userToken` sesi web Anda.
3. **Buat Gateway API Key:** Buka tab **API Keys**, buat key gateway baru (contoh `zr_live_...`). Key ini digunakan coding agent Anda untuk mengakses Zenith Router.
4. **Hubungkan Coding Agent Anda:** Arahkan base URL agent ke Zenith Router:
   * **OpenAI Compatible Base URL:** `http://127.0.0.1:20120/v1`
   * **Anthropic Compatible Base URL:** `http://127.0.0.1:20120`

---

## 🧩 Kemampuan Lanjutan

### Model Combos (Intelligent Failover & Auto-Rebuild)
Fitur Combos memungkinkan Anda membuat alias virtual yang menggabungkan beberapa model lintas provider (misalnya `combo/backend-dev` yang berisi `cc/claude-3-7-sonnet`, lalu fallback ke `cx/gpt-4o`, dan terakhir `glm/glm-4`):
* **Failover Otomatis:** Jika model prioritas utama terkena rate limit (429) atau upstream error (5xx), request otomatis dialihkan ke model cadangan berikutnya tanpa memutus sesi agent.
* **Preservasi Klaim Tools:** Menjaga metadata kapabilitas agentic tools agar coding agent tetap dapat menjalankan instruksi tool-calling dengan benar.
* **Auto-Rebuild Combo Terkelola:** Aksi "Sinkron Sekarang" atau "Import Models" langsung menyusun ulang konfigurasi super-combo secara instan tanpa menunggu jadwal scheduler dan tanpa menembak probe ke upstream.

### Proxy Pools, Gateway, & Cloudflare WARP Lanes
* **Dukungan Protokol Lengkap:** Mendukung pool proxy `HTTP`, `HTTPS`, dan `SOCKS5`.
* **Tipe Proxy Standar & Gateway:** Mendukung proxy bertipe `single` (satu proxy per request) dan `gateway` dengan parameter `retry_budget` (1–5 percobaan). Satu endpoint load balancer dapat dicoba ulang beberapa kali dalam request yang sama untuk mendapatkan egress node berbeda sebelum memicu failover akun atau kunci cooldown gerbang.
* **Webhook Rotasi Otomatis:** Webhook rotasi opsional (`rotate_url` + bearer token) dipanggil tanpa memblokir request saat terjadi HTTP 403/429 atau error di tengah stream, dilengkapi debounce 10 detik.
* **Cloudflare WARP Lanes (`scripts/setupWarpLanes.js`):** Skrip automasi untuk mendaftarkan 10 lane per-node (`warp-node-1` s.d. `warp-node-10` di port 3129–3138) dan optional load balancer `warp-gate` (port 3128) dari pool WARP lokal serta mengaktifkan strategi rotasi round-robin.
* **Sinyal Rotasi 429 Fire-and-Forget:** Node WARP yang terkena rate-limit secara otomatis mengirimkan sinyal rotasi asinkron (`signalProxy429` / `signalWarp429`) ke `/signal/429` (port 8405) dengan debounce deduplikasi 2 detik, serta melestarikan cooldown gerbang lokal (*gate cooldown*) hingga proses rotasi fisik IP di node benar-benar selesai.
* **Manajemen Akun Terikat (Bound Accounts):** Ikat atau lepaskan akun provider ke proxy pool spesifik secara massal melalui checklist pada modal edit proxy dashboard.
* **Prioritisasi Proxy Sehat:** Rotasi proxy (round-robin maupun acak) secara cerdas mendahulukan proxy aktif yang sehat (tidak berstatus exhausted atau dalam masa gate cooldown).
* **Indikator Status No-Auth:** Menampilkan status koneksi provider tanpa login di dashboard: `Proxy Pool` (rotasi bergiliran/acak), `Proxy` (terikat ke proxy tertentu), atau `Langsung (Tanpa Proxy)`.

### OpenCode Egress Policies & Hybrid WARP/Proton
Kebijakan egress OpenCode disimpan di settings database, bukan environment variable. `opencode_egress_policy` mengatur mode proxy legacy/direct/prefer/require dan `opencode_proxy_pool_ids` membatasi pool yang boleh dipakai. Mode hybrid terpisah (`opencode_egress_mode`) menggunakan registry adapter/lane eksplisit; `shadow` mengamati readiness Proton tanpa merutekan trafik ke Proton, sedangkan `enforce` mengaktifkan urutan WARP-first dan fail-closed. Konfigurasi serta batas rollout dijelaskan di [panduan hybrid egress](docs/opencode-hybrid-egress.md).

### OpenAI Codex & Responses API
* **Auto-Sync Model Codex:** Mengambil katalog model Codex di latar belakang secara otomatis setelah login OAuth berhasil tanpa mengganggu sesi login.
* **Prompt Cache Otomatis:** Menghasilkan `prompt_cache_key` otomatis dan meneruskan `prompt_cache_retention` untuk mengoptimalkan caching upstream Responses.
* **Pelaporan Token Cached & Usage:** Normalisasi metrik token cached (`prompt_cache_hit_tokens`) melalui `normalizeUsage` dan pencatatan usage estimasi yang akurat.
* **Tangga Level Thinking Lengkap:** Mendukung level reasoning dari `low`, `medium`, `high`, `xhigh`, hingga `max` untuk model Codex generasi terbaru (`gpt-6` dan `gpt-5.6`).
* **Isolasi Field Responses:** Field spesifik (`reasoning`, `prompt_cache_key`, `prompt_cache_retention`) dibatasi hanya untuk provider Codex guna menjaga kompatibilitas dengan upstream Responses lainnya.

### Referensi `GET /v1/models`: `thinking_levels`

Entri model provider dapat memuat daftar level thinking. Daftar itu terbit di dua tempat dengan nilai yang sama:

* `capabilities.thinking_levels`: lokasi resmi. Klien membaca ini untuk memilih `reasoning_effort`.
* `thinking_levels` (top-level): alias untuk Pi, yang sudah membaca field ini. Nilainya selalu identik dengan `capabilities.thinking_levels`.

Daftar katalog per provider:

* `cc/` (Claude OAuth): `low`, `medium`, `high`, `xhigh`, `max`.
* `cx/` (Codex): `low`, `medium`, `high`, `xhigh`, `max` untuk model dalam ladder (`gpt-6*`, `gpt-5.6*`), dihitung oleh `codexThinkingLevelsFor` di `src/providers/codexTiers.js`. Model lain, mis. `cx/gpt-5.5`, tidak mengiklankan tier.
* `ag/` (Antigravity): level berasal dari inventori varian akun; varian bawaan dipakai jika discovery belum melaporkan family tersebut. Family tanpa varian `xhigh` tidak mengiklankan `xhigh`. Routing mengutamakan akun yang melayani level persis sebelum turun ke level lain.

Model tanpa data level tidak menerima field ini. Field `capabilities` lain (`vision`, `reasoning`, `tools`) tidak berubah.

**Combo tidak mengiklankan `thinking_levels`.** Combo adalah rantai beberapa anggota dari provider berbeda. Setiap anggota bisa memiliki daftar level yang berbeda, dan irisan level antar-anggota belum dihitung. Karena itu entri combo hanya memuat rollup `capabilities` (`vision`, `reasoning`) dan `context_length`, tanpa `thinking_levels`. Klien yang memilih combo harus memakai level yang didukung anggota yang dituju.

**Effort yang dikenal dan bukti upstream.** Translator dan katalog memakai satu tabel effort Codex (`src/providers/codexTiers.js`), dan daftar tier yang diiklankan diturunkan dari tabel itu: `codexReasoningEffort` untuk pemetaan `reasoning_effort` ke `reasoning.effort`, dan `codexThinkingLevelsFor` untuk daftar yang diiklankan. Pemetaannya: `none` tetap `none`, `minimal` menjadi `low`, `low`/`medium`/`high`/`xhigh`/`max` tetap apa adanya. Nilai `none` dan `minimal` dikenali sebagai input, tetapi tidak diiklankan sebagai thinking tier.

Dispatch Codex tidak memfilter effort per model. Model di luar ladder (mis. `cx/gpt-5.5`) tetap menerima `xhigh` dan `max` apa adanya, dan effort yang tidak dikenal tidak dikirim. Daftar pada `/v1/models` tidak menjadi pagar yang menolak request.

Yang sudah dibuktikan adalah payload: effort yang dikenal sampai ke `reasoning.effort` di jalur dispatch. Penerimaan upstream belum diuji. Tidak ada request nyata ke upstream, sehingga tidak diketahui apakah upstream menerima tier yang diiklankan atau effort di luar ladder.

### Provider Antigravity & Sinkronisasi Katalog No-Auth
* **Level Thinking XHigh:** Mendukung varian model dengan level thinking `xhigh` (suffix `xhigh` dan label `(XHigh)`).
* **Prefix Cache Tracer:** Trace diagnostik sidik jari prefix prompt opt-in melalui env `ZENITH_CACHE_TRACE=1`.
* **Sinkronisasi Katalog No-Auth:** Katalog provider publik (`kilo-free`, `llm7`, `ovhcloud`) disinkronkan secara live; model bawaan yang dihentikan upstream otomatis dipensiunkan (`retired_models`) dengan perlindungan alias bawaan (`builtinAliases`).
* **Batas Lock Kuota per Model:** Menerapkan pembatasan (*cap*) lock concurrency per-model agar akun yang kehabisan kuota cepat kembali dapat dirutekan setelah masa cooldown selesai.

### Provider Nous Research (Hermes)
* **Login OAuth Device Code:** Login device code praktis menggunakan client resmi `hermes-cli` dan scope `inference:invoke` (dapat dikustomisasi via env `ZENITH_NOUS_CLIENT_ID`).
* **Rotasi Refresh Token & Penanda Status `needs_login`:** Token refresh berputar pada tiap grant; penolakan refresh HTTP 400 menandai akun `needs_login` agar tidak di-refresh berulang dan dilewati routing dengan aman.
* **Auto-Sync Model Gratis:** Menyinkronkan model publik dari endpoint `/v1/models` secara periodik setiap 6 jam (`freeModelSync: "merge"`).
* **Pacing Serial Turns:** Pembatasan 1 request aktif per akun (`concurrency: 1`) dengan jeda minimum 2.500 ms (`throttleMs: 2500`) untuk mematuhi jendela fair-share rate limit model gratis (seperti `qwen4-max`).
* **Direct `retry_after` Parsing:** Membaca field `retry_after` langsung dari JSON respons 429 upstream untuk menentukan durasi cooldown akun secara presisi dan meneruskan header `Retry-After`.

### Data Loss Prevention (DLP)
* Mencegah kebocoran rahasia sensitif (Private Keys, API Keys, AWS Credentials, Bearer Tokens, format PII).
* Mode operasi fleksibel: `off`, `mask` (sensor nilai rahasia dengan placeholder), atau `block` (menolak request yang memuat kredensial). Dikonfigurasi di **Settings → DLP**.

### Pin Akun per Sesi & Cooldown dari Reset Upstream
* **Pin akun per sesi:** Percakapan dengan header `x-session-id` (atau kunci sesi dari body) tetap di akun yang terakhir sukses melayani, sehingga cache prompt upstream tetap hangat antar turn. Pin tidak dibuat untuk kunci API gateway (`apikey`) dan tidak dipakai oleh probe `x-zenith-no-failover`.
* **Masa berlaku pin:** 15 menit sejak pemakaian terakhir, bisa diubah lewat setting `session_pin_ttl_minutes` (menit, 1 sampai 1440; kosong atau tidak valid memakai 15). Batas 256 sesi dengan penggusuran least-recently-used. Restart proses menghapus seluruh pin.
* **Pin dilewati** bila akunnya cooldown, terkunci untuk model itu, atau slot `max_concurrent`-nya penuh. Pin ke akun yang sudah dihapus dibersihkan saat pertama kali dipakai. Sesi pindah ke akun saudara yang masih punya slot.
* **Cooldown dari reset upstream:** urutan sumber durasi adalah `Retry-After`, lalu `reset_at` (epoch detik/milidetik atau ISO-8601), lalu `retry_after` di body JSON, lalu `RetryInfo` gaya Google.
* **Batas cooldown:** lock model sementara maksimal 1 jam; jendela kuota (quota-window) yang ditandai upstream maksimal 30 hari. Lock akun selalu maksimal 30 hari.
* **Tanpa pemendekan secara default:** cooldown baru tidak memperpendek lock yang sudah aktif. Set `ZENITH_COOLDOWN_SHORTEN_ON_RESET=1` untuk membiarkan reset otoritatif memperpendek lock **model** (lock akun tidak pernah diperpendek).

### Zero-Overhead Token Saver
* **RTK (Repetitive Token Killer):** Algoritma pemadatan prompt cerdas untuk memangkas duplikasi dan histori berulang tanpa mengurangi akurasi model.
* **Mode Caveman:** Pemadatan agresif untuk prompt yang sangat panjang guna menghemat kuota dan mempercepat respon upstream.
* Dapat dimatikan per-request menggunakan header HTTP `x-zenith-token-saver: false`.

### Multi-Language Dashboard (Indonesia & Inggris)
Zenith Router mendukung peralihan bahasa antarmuka secara instan:
* **Tombol Cepat:** Klik tombol switcher `EN` / `ID` di bagian bawah sidebar untuk beralih bahasa.
* **Pengaturan Permanen:** Pilih preferensi bahasa pada menu **Settings → General & Appearance** (tersimpan di SQLite dan cookie `zr_lang`).
* **Query Parameter:** Tambahkan `?lang=id` atau `?lang=en` pada URL untuk melihat tampilan dalam bahasa tertentu tanpa mengubah setting permanen.

---

## 💻 Contoh Pemakaian

### 1. OpenAI Chat Completions (`POST /v1/chat/completions`)

```bash
curl http://127.0.0.1:20120/v1/chat/completions \
  -H "Authorization: Bearer zr_live_your_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm/glm-4",
    "messages": [{"role": "user", "content": "Tuliskan quicksort di JavaScript"}]
  }'
```

### 2. Anthropic Messages Protocol (`POST /v1/messages`)

```bash
curl http://127.0.0.1:20120/v1/messages \
  -H "x-api-key: zr_live_your_gateway_key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cc/claude-3-7-sonnet",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Halo Claude!"}]
  }'
```

### 3. OpenAI Responses API (`POST /v1/responses`)

```bash
curl http://127.0.0.1:20120/v1/responses \
  -H "Authorization: Bearer zr_live_your_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cx/gpt-4o",
    "input": "Analisis performa query SQL ini"
  }'
```

---

## 🔧 Referensi Konfigurasi Environment

Zenith Router dapat dikonfigurasi melalui environment variables (atau berkas `.env`):

| Variabel | Default | Deskripsi |
|---|---|---|
| `PORT` | `20120` | Port listen server |
| `HOST` | `127.0.0.1` | Host bind server. Jika diubah ke selain loopback, API key gateway wajib digunakan |
| `ZENITH_DATA_DIR` | `<root>/data` | Lokasi direktori penyimpanan data & cache |
| `ZENITH_DB_PATH` | `<root>/data/zenith.db` | Lokasi spesifik file database SQLite |
| `ZENITH_ADMIN_TOKEN` | *kosong* | Bearer token admin untuk proteksi dashboard dan control API |
| `ZENITH_INITIAL_PASSWORD` | `zenith` | Password bawaan pertama kali untuk login Web Dashboard |
| `ZENITH_SESSION_SECRET` | *otomatis* | Kunci secret enkripsi cookie sesi dashboard |
| `ZENITH_CORS_ORIGINS` | *kosong* | Daftar origin browser yang diizinkan mengakses endpoint `/v1` |
| `ZENITH_ALLOWED_HOSTS` | *kosong* | Host header tambahan yang diizinkan saat bind ke localhost |
| `ZENITH_UPGRADE_SKIP_PIN` | *kosong* | Set `1` untuk melewati verifikasi hash release-manifest saat upgrade |
| `ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS` | `300000` | Batas maksimum (ms) menunggu header pertama dari upstream (5 menit) |
| `ZENITH_UPSTREAM_IDLE_TIMEOUT_MS` | `120000` | Batas jeda stream upstream sebelum dianggap terputus (2 menit) |
| `ZENITH_COOLDOWN_SHORTEN_ON_RESET` | *nonaktif* | Set `1` agar reset otoritatif dari upstream boleh memperpendek lock **model** yang sudah aktif. Default tidak memperpendek; lock akun tidak pernah diperpendek |
| `ZENITH_MODEL_SYNC_INTERVAL_HOURS` | `6` | Interval sinkronisasi katalog model gratis (set `0` untuk mematikan) |
| `ZENITH_QUOTA_SYNC_INTERVAL_MINUTES` | `15` | Interval refresh kuota background (set `0` untuk mematikan) |
| `ZENITH_BROWSER_PATH` | *otomatis* | Path eksekutabel Chrome/Edge untuk fitur login otomatis DeepSeek |
| `ZENITH_LOGIN_TIMEOUT_MS` | `300000` | Timeout login sesi browser sebelum dibatalkan otomatis |
| `ZENITH_CDP_ENDPOINT` | `http://127.0.0.1:9222` | Endpoint CDP browser yang sudah berjalan jika ingin dipakai ulang |
| `ZENITH_LOGIN_PROFILE` | `system` | Profil browser: `system` (salin sesi profil aktif) atau `isolated` (profil kosong) |
| `ZENITH_DEEPSEEK_BASE_URL` | `https://chat.deepseek.com` | Base URL upstream antarmuka web DeepSeek |
| `ZENITH_DEEPSEEK_KEEP_SESSIONS` | *kosong* | Set `1` agar chat sesi gateway tidak dihapus otomatis dari akun web |
| `ZENITH_DEEPSEEK_TOOL_RESULT_MAX` | `12000` | Batas karakter hasil eksekusi tool sebelum dipangkas di tengah |
| `WARP_POOL_SIGNAL_URL` | `http://127.0.0.1:8405/signal/429` | URL endpoint sinyal 429 fire-and-forget rotasi Cloudflare WARP |
| `ZENITH_NOUS_CLIENT_ID` | `hermes-cli` | Client ID OAuth device code untuk provider Nous Research |
| `ZENITH_STREAM_TRACE` | *kosong* | Set `1` untuk mengaktifkan trace diagnostik parsing stream SSE |
| `ZENITH_CACHE_TRACE` | *kosong* | Set `1` untuk mengaktifkan trace sidik jari prefix prompt Antigravity |
| `ZENITH_OPENCODE_BASE_URL` | *kosong* | URL upstream kustom untuk provider OpenCode |
| `ZENITH_OPENCODE_BRIDGE_PORT` | *otomatis* | Port listen worker bridge Bun lokal untuk OpenCode |

---

## 🧩 Ekosistem & Extension Pi

Zenith Router terintegrasi secara native dengan ekosistem coding agent [Pi](https://github.com/earendil-works/pi-coding-agent). Extension resmi tersedia di folder [`extensions/pi/`](extensions/pi/README.md).

Saat `npm install`, skrip `postinstall` memeriksa Pi (`pi --version`):

- Pi terpasang dan extension belum terdaftar: Anda ditanya apakah extension ingin dipasang sekarang.
- Pi belum terpasang: Anda ditanya apakah Pi ingin dipasang (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`).
- Pada terminal non-interaktif (CI, pipe), tidak ada pertanyaan; hanya perintah manual yang dicetak.

Pemasangan manual:
```bash
pi install /path/to/zenith-router/extensions/pi
```
Extension ini mendaftarkan provider `zenith-router`, menyinkronkan daftar model beserta kapabilitasnya, dan menerbitkan event data kuota untuk pemantauan `usage-tracker`.

---

## 🔒 Keamanan & Privasi

- **Penyimpanan Lokal Eksklusif:** Seluruh session token, refresh token, password hash (scrypt), dan API key disimpan pada database SQLite lokal berizin file ketat (`0600`).
- **Zero Cloud Relay:** Permintaan Anda dikirimkan langsung dari mesin lokal Anda ke endpoint provider resmi tanpa perantara server pihak ketiga.
- **Timing-Safe Authentication:** Autentikasi API key dan password dashboard diverifikasi menggunakan perbandingan hash timing-safe untuk menangkal serangan side-channel.

---

## 📦 Persiapan Release
Maintainer: lihat [checklist release](docs/releasing.md) untuk pembaruan versi, changelog, validasi paket, dan GitHub Release.

---

## 📜 Lisensi & Atribusi

Proyek ini dilisensikan di bawah lisensi **MIT** — lihat berkas [LICENSE](LICENSE) untuk detail lengkap.

Sebagian modul dan solver PoW diadaptasi dari proyek open-source pihak ketiga. Daftar lengkap atribusi dan lisensi pihak ketiga tercantum pada [NOTICE](NOTICE).
