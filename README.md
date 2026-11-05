# Zenith Router

<p align="center">
  <strong>Ultra-lightweight, zero-telemetry personal AI gateway for coding agents.</strong><br>
  Unified endpoint for OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses with automated multi-account rotation and failover.
</p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg" alt="Node.js version"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/version-2.1.0-blue.svg" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-purple.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/architecture-zero--telemetry-success.svg" alt="Zero Telemetry">
  <img src="https://img.shields.io/badge/storage-node%3Asqlite-orange.svg" alt="Embedded SQLite">
</p>

---

Zenith Router adalah gateway AI lokal mandiri untuk coding agents (Pi, Cursor, Claude Code, Cline, Roo Code, Aider) dan aplikasi apa pun yang menggunakan protokol OpenAI/Anthropic. Satu endpoint menerima permintaan berformat OpenAI Chat Completions, Anthropic Messages, maupun OpenAI Responses, lalu meneruskannya ke akun provider milik Anda sendiri: langganan Claude Pro/Team, ChatGPT/Codex, GitHub Copilot, Kiro, Antigravity, Cline, API key provider, sesi web DeepSeek, atau provider gratis dengan rotasi akun dan failover otomatis.

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
[ Upstream AI Providers ] (20 Built-in Providers + Custom BYOP)
Claude · Codex · Copilot · Kiro · Antigravity · GLM · OpenRouter · BYOP...
```

---

## ✨ Fitur Utama

- **Protokol Terpadu & Universal Translator:** Menerima format OpenAI (`/v1/chat/completions`), Anthropic (`/v1/messages`), dan OpenAI Responses (`/v1/responses`), baik streaming SSE maupun non-streaming. Translasi otomatis tool-calling lintas protokol (dialek JSON schema, tool_use Claude, function_call Responses, hingga DSML).
- **20 Provider Built-in + BYOP (Bring Your Own Provider):** Mendukung login OAuth dengan PKCE, device code flow, import session browser, API key, free tier tanpa login, dan custom endpoint OpenAI/Claude.
- **Failover & Rotasi Akun Cerdas:** Failover otomatis ke akun berikutnya saat terkena rate-limit (429) atau server down (5xx), dilengkapi cooldown cerdas dan refresh token otomatis.
- **Model Combos:** Agregasi virtual model lintas provider dalam satu alias (misalnya `combo/smart-coding`) dengan urutan prioritas fallback otomatis.
- **Proxy Pools Terintegrasi:** Manajemen pool proxy HTTP, HTTPS, dan SOCKS5 langsung dari dashboard, uji latensi, rotasi proxy per provider, serta penugasan proxy spesifik per akun.
- **Live Quota Scraper (10 Provider):** Memantau sisa kuota, jendela batas pemakaian (5 jam, harian, mingguan), dan waktu reset akun secara akurat tanpa perlu membuka situs provider.
- **Data Loss Prevention (DLP):** Redaksi dan sensor otomatis kredensial, kunci API, dan token privat sebelum meninggalkan mesin Anda.
- **Zero-Overhead Token Saver:** Pemadatan prompt otomatis menggunakan algoritma RTK dan mode Caveman opsional untuk menghemat konsumsi token konteks.
- **Web Dashboard & Admin Security:** Dilengkapi antarmuka Web modern dengan dark/light theme, visualisasi kuota, audit log penggunaan, dan proteksi login password / admin token.

---

## 🔌 Provider yang Didukung (20 Built-in + BYOP)

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
| `dsw` | DeepSeek Web Chat | Token sesi browser / CDP | — | ✅ |
| *custom* | **Custom Provider (BYOP)** | OpenAI / Claude Endpoint | — | ✅ |

> **Catatan Prefix:** Anda dapat memanggil model menggunakan prefix singkat (misal `cc/claude-3-7-sonnet`, `cx/gpt-4o`, `glm/glm-4`) maupun nama lengkap provider (misal `together/meta-llama/Llama-3-70b-chat-hf`).

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
   * *OAuth Provider (Claude, Copilot, Antigravity, dll):* Klik tombol login browser atau selesaikan device code.
   * *API Key Provider (OpenRouter, NVIDIA, dll):* Masukkan API key Anda.
   * *Free Provider (Kilo Free, OpenCode, OVH):* Langsung aktif dan siap dipakai.
   * *DeepSeek Web:* Gunakan fitur **Login sekali klik di browser** via Chrome DevTools Protocol atau tempel `userToken` sesi web Anda.
3. **Buat Gateway API Key:** Buka tab **API Keys**, buat key gateway baru (contoh `zr_live_...`). Key ini digunakan coding agent Anda untuk mengakses Zenith Router.
4. **Hubungkan Coding Agent Anda:** Arahkan base URL agent ke Zenith Router:
   * **OpenAI Compatible Base URL:** `http://127.0.0.1:20120/v1`
   * **Anthropic Compatible Base URL:** `http://127.0.0.1:20120`

---

## 🧩 Kemampuan Lanjutan

### Model Combos (Intelligent Failover)
Fitur Combos memungkinkan Anda membuat alias virtual yang menggabungkan beberapa model lintas provider (misalnya `combo/backend-dev` yang berisi `cc/claude-3-7-sonnet`, lalu fallback ke `cx/gpt-4o`, dan terakhir `glm/glm-4`):
* **Failover Otomatis:** Jika model prioritas utama terkena rate limit (429) atau upstream error (5xx), request otomatis dialihkan ke model cadangan berikutnya tanpa memutus sesi agent.
* **Preservasi Klaim Tools:** Menjaga metadata kapabilitas agentic tools agar coding agent tetap dapat menjalankan instruksi tool-calling dengan benar.

### Proxy Pools & Isolasi IP
* Mendukung pool proxy `HTTP`, `HTTPS`, dan `SOCKS5`.
* **Rotasi Proxy:** Mengonfigurasi rotasi IP otomatis per request untuk provider tertentu guna mencegah rate-limit berbasis IP.
* **Pinning Akun ke Proxy:** Menugaskan akun spesifik ke proxy tertentu (berguna jika akun Anda membutuhkan IP residensial tetap).
* **Pengujian Latensi:** Tombol uji koneksi dan latensi proxy langsung dari antarmuka web.

### Data Loss Prevention (DLP)
* Mencegah kebocoran rahasia sensitif (Private Keys, API Keys, AWS Credentials, Bearer Tokens, format PII).
* Mode operasi fleksibel: `off`, `mask` (sensor nilai rahasia dengan placeholder), atau `block` (menolak request yang memuat kredensial). Dikonfigurasi di **Settings → DLP**.

### Zero-Overhead Token Saver
* **RTK (Repetitive Token Killer):** Algoritma pemadatan prompt cerdas untuk memangkas duplikasi dan histori berulang tanpa mengurangi akurasi model.
* **Mode Caveman:** Pemadatan agresif untuk prompt yang sangat panjang guna menghemat kuota dan mempercepat respon upstream.
* Dapat dimatikan per-request menggunakan header HTTP `x-zenith-token-saver: false`.

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
| `ZENITH_MODEL_SYNC_INTERVAL_HOURS` | `6` | Interval sinkronisasi katalog model gratis (set `0` untuk mematikan) |
| `ZENITH_QUOTA_SYNC_INTERVAL_MINUTES` | `15` | Interval refresh kuota background (set `0` untuk mematikan) |
| `ZENITH_BROWSER_PATH` | *otomatis* | Path eksekutabel Chrome/Edge untuk fitur login otomatis DeepSeek |
| `ZENITH_LOGIN_TIMEOUT_MS` | `300000` | Timeout login sesi browser sebelum dibatalkan otomatis |
| `ZENITH_CDP_ENDPOINT` | `http://127.0.0.1:9222` | Endpoint CDP browser yang sudah berjalan jika ingin dipakai ulang |
| `ZENITH_LOGIN_PROFILE` | `system` | Profil browser: `system` (salin sesi profil aktif) atau `isolated` (profil kosong) |
| `ZENITH_DEEPSEEK_BASE_URL` | `https://chat.deepseek.com` | Base URL upstream antarmuka web DeepSeek |
| `ZENITH_DEEPSEEK_KEEP_SESSIONS` | *kosong* | Set `1` agar chat sesi gateway tidak dihapus otomatis dari akun web |
| `ZENITH_DEEPSEEK_TOOL_RESULT_MAX` | `12000` | Batas karakter hasil eksekusi tool sebelum dipangkas di tengah |

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

## 📜 Lisensi & Atribusi

Proyek ini dilisensikan di bawah lisensi **MIT** — lihat berkas [LICENSE](LICENSE) untuk detail lengkap.

Sebagian modul dan solver PoW diadaptasi dari proyek open-source pihak ketiga. Daftar lengkap atribusi dan lisensi pihak ketiga tercantum pada [NOTICE](NOTICE).
