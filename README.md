# Zenith Router

Gateway AI lokal untuk coding agent dan aplikasi apa pun yang memakai API OpenAI. Satu endpoint menerima permintaan berformat OpenAI Chat Completions, Anthropic Messages, dan OpenAI Responses, lalu meneruskannya ke akun provider milik sendiri: langganan ChatGPT, Claude, GitHub Copilot, Kiro, Antigravity, Cline, API key provider, atau provider gratis, dengan rotasi akun dan failover otomatis.

Zenith Router berjalan lokal, tanpa akun cloud, tanpa telemetry, dan tanpa dependensi berat. Kredensial provider tidak pernah keluar dari mesin Anda.

## Fitur

**Gateway dan routing**

- `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/responses`, `GET /v1/models`, streaming SSE maupun non-streaming
- Translasi request dan response antar format: OpenAI, Anthropic, Google Cloud Code `v1internal`, AWS EventStream biner (Kiro), Responses API untuk backend Codex
- Tool calling lintas format
- Prefix model untuk memilih provider, misalnya `glm/glm-5.2`, `cc/claude-opus-5`, `cx/gpt-6.1-sol`
- Failover ke akun berikutnya saat 429 atau 5xx, dengan cooldown 60 detik untuk akun bermasalah
- Refresh token otomatis, proaktif sebelum request dan berkala di latar belakang, plus satu percobaan ulang setelah 401 atau 403
- Traffic Guard: batas request in-flight per akun, antrean FIFO, jitter proaktif dan reaktif
- Prioritas akun per provider (#1, #2, dst.) yang diatur dengan tombol naik/turun di halaman detail provider: #1 selalu dipakai duluan, akun berikutnya hanya saat akun di atasnya tidak tersedia

**Akun dan provider**

- 21 provider dengan tiga jenis autentikasi: OAuth, API key, dan free tier tanpa login
- Login OAuth lewat browser dengan callback lokal, login device code, import kredensial dari CLI yang sudah terpasang, dan tempel token manual
- Proxy HTTP/HTTPS per akun dengan kunci single-flight saat refresh token
- Sinkronisasi model gratis otomatis dan berkala
- Manajemen akun dan model per provider: enable, disable, dan model kustom

**Kuota dan observabilitas**

- Pengambil kuota langsung untuk Codex, Claude, Kiro, xKiro, Antigravity, GitHub Copilot, GLM, dan OpenRouter
- Kartu kuota dengan bar per jendela dan per model, hitung mundur reset, dan sinkronisasi manual
- Auto-refresh kuota dengan cache
- Peta koneksi provider aktif di sekitar router, dan daftar request terakhir yang diperbarui langsung
- Log aplikasi lengkap di dashboard, termasuk log dari pekerjaan latar belakang

**Kemampuan model**

- `GET /v1/models` memublikasikan `capabilities` (`vision`, `reasoning`), `context_length`, dan `max_completion_tokens`
- Data kemampuan diambil dari API provider bila tersedia, dilengkapi tabel pola untuk model statis
- Ikon otak dan mata di halaman provider menandai model yang bisa thinking dan bisa membaca gambar

**Efisiensi token**

- Token Saver dengan RTK, pemadatan prompt otomatis
- Mode Caveman untuk pemadatan agresif pada prompt panjang, mati secara default
- Pencatatan pemakaian token untuk streaming dan non-streaming, plus audit per API key

## Provider yang Didukung

| Prefix | Provider | Autentikasi | Kuota |
|---|---|---|---|
| `cc` | Claude (Anthropic) | OAuth | Ya |
| `cx` | OpenAI Codex | OAuth | Ya |
| `gh` | GitHub Copilot | OAuth / device code | Ya |
| `kr` | Kiro AI | Free tier | Ya |
| `ag` | Antigravity (Google) | OAuth | Ya |
| `xkr` | xKiro | API key | Ya |
| `cl` | Cline | OAuth | — |
| `cmc` | Command Code | OAuth | — |
| `glm` | Zai GLM Coding | OAuth / device code | Ya |
| `kc` | Kilo Code Free Tier | OAuth / device code | — |
| `fb` | Freebuff | OAuth / import lokal | — |
| `mis` | Mistral AI | API key | — |
| `or` | OpenRouter | API key | Ya |
| `oc` | OpenCode Free | Free tier | — |
| `bzl` | Bazaarlink | API key | — |
| `cf` | Cloudflare Workers AI | API key | — |
| `nv` | NVIDIA NIM | API key | — |
| `ovh` | OVHcloud AI Endpoints | Free tier | — |
| `tg` | Together AI | API key | — |
| `ol` | Ollama Cloud | API key | — |
| `l7` | LLM7 | API key | — |

Alias lengkap tanpa prefix pendek juga diterima, misalnya `mistral/mistral-large-latest`.

## Kebutuhan Sistem

- Node.js >= 22.13.0 (ESM). Modul `node:sqlite` masih memerlukan flag `--experimental-sqlite` pada rilis 22.5 sampai 22.12, jadi versi tersebut belum didukung.
- Alamat bind default hanya menerima koneksi dari `localhost`.

## Instalasi

### Dari source

```bash
git clone https://github.com/Divarizky/zenith-router.git
cd zenith-router
npm install
npm start          # atau npm run dev untuk auto-reload
```

Server berjalan di `http://127.0.0.1:20120`. Di Windows tersedia juga `zenith.cmd` dan `zenith.ps1`.

### Sebagai perintah global

```bash
npm link
```

Setelah itu perintah `zenith` bisa dipanggil dari direktori mana pun. Dijalankan dari terminal interaktif, Zenith Router menampilkan menu untuk membuka dashboard.

## Menyiapkan Akun dan Key

1. Buka halaman **Providers** di `http://127.0.0.1:20120/dashboard/providers`, pilih provider, lalu **Add Account**. Provider OAuth punya tombol login, provider API key cukup diisi key-nya. Provider tanpa login bisa langsung dipakai.
   - Login Codex memakai callback `http://localhost:1455/auth/callback`, jadi port 1455 harus kosong saat login. Login lainnya kembali ke `http://127.0.0.1:20120/callback`.
2. Buka **API Keys** dan buat satu key gateway untuk tiap client. Key lengkap hanya ditampilkan sekali.
3. Opsional: aktifkan **Require API Key** di **Settings** agar semua request `/v1` wajib memakai key, atau atur RTK dan Caveman di **Token Saver**.

Key gateway hanya membuka akses ke Zenith Router dan tidak pernah diteruskan ke provider. Tanpa akun aktif, gateway membalas 503.

## Contoh Pemakaian

```bash
curl http://127.0.0.1:20120/v1/chat/completions \
  -H "Authorization: Bearer zr_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"glm/glm-5.2","messages":[{"role":"user","content":"Halo"}]}'
```

Endpoint Anthropic Messages dan OpenAI Responses menerima bentuk request masing-masing, sehingga client yang hanya mendukung satu format tetap bisa memakai provider lain.

## Konfigurasi

| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` | `20120` | Port server |
| `HOST` | `127.0.0.1` | Alamat bind. Selain loopback, API key otomatis diwajibkan |
| `ZENITH_DB_PATH` | `<root>/data/zenith.db` | Lokasi database |
| `ZENITH_ALLOWED_HOSTS` | kosong | Host tambahan yang diterima saat bind ke loopback |
| `ZENITH_CORS_ORIGINS` | kosong, CORS mati | Origin browser yang boleh memanggil `/v1` |
| `ZENITH_UPSTREAM_HEADERS_TIMEOUT_MS` | `300000` | Batas tunggu header respons upstream |
| `ZENITH_UPSTREAM_IDLE_TIMEOUT_MS` | `120000` | Batas jeda antar chunk stream upstream |
| `ZENITH_MODEL_SYNC_INTERVAL_HOURS` | `6` | Interval sinkron model gratis, `0` mematikan sinkron otomatis |
| `ZENITH_QUOTA_SYNC_INTERVAL_MINUTES` | `15` | Interval sinkron kuota, `0` mematikan sinkron otomatis |

Header `x-zenith-token-saver: false` mematikan RTK dan Caveman untuk satu request.

## Kemampuan Model di `/v1/models`

Setiap entri model memakai id berprefix provider dan memuat metadata yang bisa dipakai client:

```json
{
  "id": "mis/ministral-14b-latest",
  "capabilities": { "vision": true, "reasoning": false }
}
```

Client yang menghormati `capabilities.reasoning` tidak akan mengirim `reasoning_effort` ke model yang tidak mendukungnya. Model yang kemampuannya tidak diketahui tidak mendapat field `capabilities` sama sekali, bukan asumsi.

## Dashboard

Halaman Overview, Providers, Usage & Quota, Token Saver, API Keys, dan Settings. Dashboard dan endpoint kontrol hanya menerima koneksi dari localhost. Log aplikasi tersedia lewat Console Log, termasuk pesan dari pekerjaan latar belakang seperti refresh token dan sinkronisasi kuota.

## Keamanan

- Dashboard dan endpoint kontrol terikat ke loopback secara default. Mengubah `HOST` ke alamat publik membuat API key gateway menjadi wajib.
- Key gateway disimpan sebagai hash dan hanya ditampilkan sekali saat dibuat.
- Jangan pernah membagikan isi database Zenith Router.

## Batasan yang Diketahui

- Kuota dihitung dari endpoint resmi masing-masing provider, jadi angka dan cakupannya berbeda-beda. Beberapa pengambil kuota dibangun dari referensi implementasi pihak lain dan belum diverifikasi terhadap seluruh jenis akun.
- Provider tanpa sumber data kuota tidak muncul di halaman Kuota.
- Kemampuan model untuk provider yang tidak mempublikasikan metadata diambil dari tabel pola dan bisa tidak selalu akurat. Provider yang mempublikasikannya, seperti Mistral, selalu memakai data API.
- Daftar model gratis hasil sinkronisasi dibatasi model yang benar-benar bisa dipanggil pada akun tersebut. Provider gratis yang menolak model di luar tier akan mengosongkan sebagian daftarnya.

## Lisensi dan Penghargaan

MIT, lihat [LICENSE](LICENSE).

Sebagian modul diadaptasi dari proyek open-source pihak ketiga. Daftar lengkap beserta atribusi dan lisensinya ada di [NOTICE](NOTICE).