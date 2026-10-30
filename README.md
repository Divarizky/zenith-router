# Zenith Router

Gateway AI lokal untuk coding agent dan aplikasi apa pun yang memakai API OpenAI. Satu endpoint menerima permintaan berformat OpenAI Chat Completions, Anthropic Messages, dan OpenAI Responses, lalu meneruskannya ke akun provider milik sendiri: langganan ChatGPT, Claude, GitHub Copilot, Kiro, Antigravity, Cline, API key provider, sesi web DeepSeek, atau provider gratis, dengan rotasi akun dan failover otomatis.

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

- 21 provider dengan empat jenis autentikasi: OAuth, API key, free tier tanpa login, dan token sesi browser untuk provider yang hanya punya antarmuka web
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
| `cf` | Cloudflare Workers AI | API key | — |
| `nv` | NVIDIA NIM | API key | — |
| `ovh` | OVHcloud AI Endpoints | Free tier | — |
| `tg` | Together AI | API key | — |
| `ol` | Ollama Cloud | API key | — |
| `l7` | LLM7 | API key | — |
| `dsw` | DeepSeek Web Chat | Token sesi web | — |

Alias lengkap tanpa prefix pendek juga diterima, misalnya `mistral/mistral-large-latest`.

`dsw` tidak memakai API resmi DeepSeek. Provider ini membaca token dari sesi chat.deepseek.com, tidak aktif sampai Anda menambahkan akun sendiri, dan memakai akun tersebut dengan risiko pemblokiran. Rincian ada di [Provider DeepSeek Web](#provider-deepseek-web-chat).

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

## Provider DeepSeek Web (Chat)

Provider `dsw` memakai antarmuka web `chat.deepseek.com`, bukan API resmi. Permintaan dikirim dengan user token dan cookie milik akun browser Anda. Cara ini tidak didukung DeepSeek: pemakaian di luar klien resmi bisa melanggar ketentuan layanan mereka, dan akun berisiko dibatasi atau diblokir. Token juga setara akses penuh ke akun tersebut dan disimpan sebagai teks biasa di database lokal, jadi pakai akun khusus dan jangan bagikan isi database.

### Menambahkan akun

1. Login di `https://chat.deepseek.com` pada browser.
2. Buka DevTools, lalu **Application → Local Storage → https://chat.deepseek.com**. Nilai `userToken` berbentuk JSON `{"value":"...","__version":"0"}`; yang dibutuhkan adalah isi `value` (string yang dimulai `eyJ`). Menempel JSON utuh, `Bearer ...`, atau nilai berapit tanda kutip juga diterima karena gateway mengambil bagian tokennya.
3. Opsional: salin header `Cookie` dari salah satu request di tab **Network** (endpoint `create_pow_challenge`) bila akun membutuhkannya.
4. Di dashboard buka **Providers → Session Providers → DeepSeek Web Chat → Add Account**, isi label, user token, dan cookies bila ada.
5. Buka detail provider. Status sesi diperiksa otomatis lewat endpoint PoW challenge (tanpa memulai percakapan) dan ditampilkan sebagai badge **Sesi OK**, **Sesi kedaluwarsa**, atau **Gagal dicek**.

Token web tidak bisa di-refresh. Saat DeepSeek menolaknya, gateway membalas 401 dengan header `X-Zenith-Auth-Expired: 1`; ambil `userToken` baru lalu isi form **Perbarui sesi** pada akun tersebut. Tombol **Periksa sesi** memaksa pemeriksaan ulang tanpa menunggu cache lima menit.

### Login sekali klik

Langkah manual di atas bisa dilewati. Di dialog **Tambah Akun** ada tombol **Login di browser**; setelah sesi terbentuk, token dan cookies diisi otomatis dan akun langsung dibuat. Kolom token dan cookies tetap ada di bawahnya untuk menempel manual seperti sebelumnya.

1. Pastikan Chrome, Edge, atau Chromium terpasang di mesin yang menjalankan gateway. Tidak ada dependensi tambahan yang perlu dipasang; browser digerakkan lewat Chrome DevTools Protocol.
2. Buka **Providers → Session Providers → DeepSeek Web Chat → Tambah Akun**, isi label bila perlu, lalu tekan **Login di browser**.
3. Jendela browser terbuka dengan profil kosong di halaman login DeepSeek. Login seperti biasa; captcha dan kode OTP tetap Anda isi sendiri.
4. Saat sesi terdeteksi, gateway mengambil `userToken` dan cookies, menyimpannya sebagai akun, menutup jendela, dan halaman dashboard menampilkan status sesi akun tersebut.

Cara kerjanya:

- Browser yang dipakai adalah **default browser** Anda (Windows: `MSEdgeHTM`/`ChromeHTML`; bisa dipaksa lewat `ZENITH_BROWSER_PATH`).
- Jendela login dijalankan dengan profil sementara yang **menyalin sesi** dari profil browser Anda: `Local State` (kunci dekripsi cookie), cookie `Network/Cookies`, dan `Local Storage/leveldb` tempat `userToken` disimpan. Profil asli tidak ditulis, jadi browser yang sedang Anda pakai tidak terganggu dan tidak perlu ditutup.
- Profil yang disalin bukan asal `Default`: gateway memilih profil yang benar-benar mengenal `deepseek.com` (`Default`, `Profile 1`, `Profile 2`, ...). Kalau Anda login DeepSeek di profil kedua, sesi itulah yang dipakai.
- Kalau browser sudah berjalan dengan port debugging (9222, 9223, 9224, atau 9333 — atau `ZENITH_CDP_ENDPOINT`), tab di jendela itu yang dipakai dan hanya tab itu yang ditutup.
- Cookie DB yang sedang dibuka browser tidak bisa disalin di Windows (`EBUSY`), jadi berkas itu dilewati; token dari web storage tetap terbaca dan diverifikasi.
- Set `ZENITH_LOGIN_PROFILE=isolated` untuk memakai profil kosong seperti sebelumnya.

Jendela tidak ditutup saat halaman login baru terbuka. Token baru diambil setelah halaman meninggalkan `/sign_in`, panjangnya wajar, dan lolos verifikasi ke endpoint PoW DeepSeek; token sementara seperti `undefined`/`null` diabaikan. Jadi browser tetap terbuka sampai Anda menyelesaikan login.

Proses login dibatalkan otomatis setelah 5 menit; ubah lewat `ZENITH_LOGIN_TIMEOUT_MS`. Kalau browser tidak ditemukan, set `ZENITH_BROWSER_PATH` ke berkas `chrome.exe`/`msedge.exe`.

### Model dan mode thinking

Endpoint web DeepSeek tidak punya field `model`; yang menentukan mode adalah `thinking_enabled`. Karena itu kedua id di bawah menuju endpoint yang sama:

| Model | Perilaku |
| --- | --- |
| `dsw/deepseek-chat` | Mode chat biasa, `thinking_enabled: false`. Default untuk agent tool-calling. |
| `dsw/deepseek-reasoner` | `thinking_enabled: true`. Isi thinking dikembalikan sebagai `reasoning_content` pada respons non-stream, atau delta `reasoning_content` sebelum jawaban pada respons stream. |

Catatan: upstream tidak mengungkap nama model (responsnya berisi `"model": ""`), jadi id di atas adalah label gateway, bukan versi model DeepSeek. Reasoning diambil dari fragmen `THINK` pada `history_messages` dan dari patch stream (`{"p":"response/fragments/-1/content","v":"..."}`); keduanya sudah ditangani, termasuk varian lama `THINKING`. `search_enabled` tetap `false` karena gateway tidak bisa menyertakan sumber.

Upstream sendiri kadang tidak berpikir untuk turn yang sederhana walau `thinking_enabled: true` (terlihat langsung: stream turn itu hanya berisi fragmen `RESPONSE`). Pada turn seperti itu `reasoning_content` memang kosong.

Pada respons stream, `deepseek-reasoner` mengirim reasoning sambil upstream masih berpikir. Jawaban dikirim setelah turn selesai, karena tool call datang sebagai tag teks yang harus diparse dulu. Error yang terjadi sebelum potongan reasoning pertama tetap dibalas dengan status HTTP-nya (failover antarakun tetap jalan); error sesudahnya muncul sebagai event `error` di dalam stream.

Cara gateway menjaga percakapan web tetap utuh:

- Upstream melaporkan kegagalan sebagai HTTP 200 berisi JSON (`{"code":40003}` untuk token mati, `{"data":{"biz_code":26,"biz_msg":"invalid message id"}}` untuk turn yang ditolak). Body itu dibaca sebagai error, jadi token mati ditandai kedaluwarsa dan turn yang ditolak tidak pernah dijawab dengan jawaban turn sebelumnya.
- Jawaban dicocokkan dengan id pesan yang diumumkan stream (`event: ready`), bukan sekadar pesan assistant terakhir di history.
- Turn lanjutan yang ditolak upstream diulang sekali di chat baru dengan seluruh riwayat.
- Setiap percakapan mendapat chat web sendiri walau datang dengan session key yang sama (subagent, klien tanpa header sesi), sehingga percakapan paralel tidak saling mengantre atau me-reset.
- Chat web yang sudah tidak dipakai (reset, digusur batas sesi) dihapus dari sidebar DeepSeek. Set `ZENITH_DEEPSEEK_KEEP_SESSIONS=1` untuk menyimpannya.
- Hasil tool di atas 12.000 karakter dipangkas di tengah; awal dan akhir tetap dikirim. Ubah lewat `ZENITH_DEEPSEEK_TOOL_RESULT_MAX`.


```bash
curl http://127.0.0.1:20120/v1/chat/completions \
  -H "Authorization: Bearer zr_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"dsw/deepseek-chat","messages":[{"role":"user","content":"Halo"}]}'
```

Streaming, dengan identitas percakapan terpisah agar tiap percakapan punya sesi upstream sendiri:

```bash
curl -N http://127.0.0.1:20120/v1/chat/completions \
  -H "Authorization: Bearer zr_..." \
  -H "Content-Type: application/json" \
  -H "x-session-id: tugas-1" \
  -d '{"model":"dsw/deepseek-chat","stream":true,"messages":[{"role":"user","content":"Hitung 1 sampai 3"}]}'
```

Tool calling juga berlaku. Model menjawab dengan tag `<tool_call>` atau dialek DSML, lalu executor mengubahnya menjadi `tool_calls` OpenAI. Klien Claude (`/v1/messages`) menerima blok `tool_use`, dan klien Responses (`/v1/responses`) menerima item `function_call`; tag tidak pernah muncul di `content`.

```bash
curl http://127.0.0.1:20120/v1/chat/completions \
  -H "Authorization: Bearer zr_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model":"dsw/deepseek-chat",
    "messages":[{"role":"user","content":"Lihat isi folder kerja"}],
    "tools":[{"type":"function","function":{"name":"bash","description":"jalankan perintah shell","parameters":{"type":"object","properties":{"command":{"type":"string"}}}}}]
  }'
```

### Batas sesi paralel

Batas dihitung **per akun**, bukan total semua akun. Default `dsw` adalah 3 completion serentak per akun, dan bisa diubah 1–10 di kartu **Batas Sesi Paralel** pada detail provider. Dengan dua akun, total menjadi dua kali lipat; tidak ada batas gabungan lintas akun.

- Permintaan keempat menunggu di antrean akun sampai ada slot kosong. Antrean utama menyerah setelah 30 detik, lalu gateway membalas 429 `account_busy` dengan `Retry-After: 5` dan mencoba akun atau provider berikutnya.
- Panggilan bantu seperti judul sesi dan job latar menyerah setelah 2 detik, dan tidak pernah menyalip antrean percakapan.
- Tiap akun memelihara paling banyak 3 sesi percakapan utama ditambah 2 sesi bantu, dengan TTL 6 jam dan pembersihan sesi menganggur. Percakapan berbeda memakai kunci `(akun, session klien, jenis)`; kirim `x-session-id` (atau header sesi lain yang dikenal) bila klien menjalankan beberapa percakapan sekaligus, karena tanpa itu permintaan diserialkan pada satu rantai.
- Angka `inFlight/cap` dan jumlah antrean terlihat di kartu **Batas Sesi Paralel** dan kolom **Slot** pada tabel akun. Nilai tersebut snapshot saat halaman dimuat.

### Batasan provider ini

- Token tidak bisa di-refresh dan tidak ada pengecekan kuota; bila token mati, semua request akun itu gagal sampai Anda memperbaruinya.
- Upstream tidak melaporkan pemakaian token, jadi `usage` dihitung dari estimasi karakter. Angka ini cukup untuk pemantauan, bukan untuk penagihan.
- Hanya teks: tidak ada input gambar, thinking dimatikan, dan pencarian web tidak dipakai.
- PoW diselesaikan lokal dengan WASM yang di-vendor (MIT, lihat [NOTICE](NOTICE)); sekitar 20 ms, tanpa dependensi baru.
- Endpoint web DeepSeek tidak berdokumentasi dan bisa berubah kapan saja. Bila upstream mengubah bentuk respons atau PoW, provider bisa berhenti berfungsi meski akun masih valid.

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
| `ZENITH_DEEPSEEK_BASE_URL` | `https://chat.deepseek.com` | Root upstream provider `dsw`, untuk bridge atau uji lokal |
| `ZENITH_BROWSER_PATH` | otomatis | Berkas Chrome/Edge untuk **Login sekali klik**; kosongkan agar dicari otomatis |
| `ZENITH_LOGIN_TIMEOUT_MS` | `300000` | Batas tunggu login browser sebelum flow dianggap gagal |
| `ZENITH_CDP_ENDPOINT` | `http://127.0.0.1:9222` | Endpoint debugging browser yang sudah terbuka untuk dipakai ulang saat **Login di browser** |
| `ZENITH_LOGIN_PROFILE` | `system` | `system` menyalin sesi dari profil browser Anda; `isolated` memakai profil kosong |
| `ZENITH_DEEPSEEK_KEEP_SESSIONS` | kosong | `1` membiarkan chat web yang sudah tidak dipakai gateway tetap ada di sidebar DeepSeek |
| `ZENITH_DEEPSEEK_TOOL_RESULT_MAX` | `12000` | Batas karakter satu hasil tool yang dikirim ke DeepSeek Web (minimal 1000) |

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
- **Login sekali klik** hanya berjalan pada browser berbasis Chromium yang terpasang di mesin gateway dan butuh jendela yang bisa dibuka; di server tanpa GUI, tempel token manual.
- Provider `dsw` bergantung pada antarmuka web DeepSeek yang tidak berdokumentasi. Perubahan endpoint, format PoW, atau kebijakan akun di sisi DeepSeek dapat menghentikan provider ini tanpa perubahan di sisi gateway.

## Lisensi dan Penghargaan

MIT, lihat [LICENSE](LICENSE).

Sebagian modul diadaptasi dari proyek open-source pihak ketiga. Daftar lengkap beserta atribusi dan lisensinya ada di [NOTICE](NOTICE).