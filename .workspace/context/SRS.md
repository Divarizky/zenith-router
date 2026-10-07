# SRS — zenroute

Software Requirements Specification dan baseline requirement project.
Requirement permanen disimpan di sini; work card hanya artifact kerja sementara.
Single-writer konten requirement: `to-requirements`.

## Global Requirements
- **GR-01 (Footprint):** THE SYSTEM SHALL membatasi ukuran total dependensi runtime di bawah 10 MB pada instalasi bersih.
- **GR-02 (Compatibility):** THE SYSTEM SHALL menyediakan interface HTTP yang 100% kompatibel dengan spesifikasi OpenAI Chat Completions API pada endpoint `/v1/chat/completions`.
- **GR-03 (Resilience):** WHEN request upstream mengalami kegagalan transient (HTTP 429 atau 5xx) sebelum byte data streaming dikirim ke client, THE SYSTEM SHALL melakukan failover otomatis ke connection/akun alternatif berikutnya yang tersedia.
- **GR-04 (Privacy):** THE SYSTEM SHALL menyimpan seluruh token OAuth, API keys, dan riwayat request secara lokal di dalam database SQLite tanpa telemetri atau pengiriman data keluar selain ke upstream provider yang dituju.
- **GR-05 (Performance):** WHILE melayani streaming request, THE SYSTEM SHALL tidak melakukan blocking pada Node.js event loop dengan durasi melebihi 20 milidetik.
- **GR-06 (Exposure):** THE SYSTEM SHALL listen di loopback secara default, dan WHEN di-bind ke alamat non-loopback THE SYSTEM SHALL mewajibkan API key zenroute pada `/v1` serta membatasi dashboard dan `/api` ke klien loopback.

## Feature Registry
| ID | Feature | Status | Updated |
|---|---|---|---|
| F-01 | Base Gateway & Core Translator | approved | 2026-10-06 |
| F-02 | Provider Connections & OAuth | approved | 2026-10-06 |
| F-03 | Usage Tracking & Quota Sync | approved | 2026-10-06 |
| F-04 | Token Saver Engine | approved | 2026-10-06 |
| F-05 | Minimal Dashboard UI | approved | 2026-10-06 |
| F-06 | Security Hardening & Gateway API Keys | approved | 2026-10-07 |

## Known Gaps (update 07-10-2026 pasca implementasi paket 4–6)
Requirement berikut telah diselesaikan:
- [x] GR-03 (failover): 429/5xx secara otomatis failover ke connection berikutnya sebelum byte pertama dikirim, akun bermasalah diberi cooldown 60s.
- [x] F-01 REQ-03: tool calling didukung bidirectional (OpenAI <-> Claude); `/v1/messages` diterjemahkan ke provider non-Claude; endpoint `/v1/responses` ditambahkan; `anthropic-beta` diteruskan.
- [x] F-02 registry: registry `codex`, `github`, `kiro`, `antigravity` telah disinkronkan dengan 9router.
- [x] F-03 REQ-18: streaming usage mencatat token dengan `stream_options.include_usage` dan fallback estimasi jika upstream tidak mengirim usage chunk.

Sisa gap yang masih ditangguhkan:
- F-02 REQ-11/REQ-12/REQ-16: alur login interaktif OAuth di browser (device code flow/social login), dan background timer loop mandiri.
- F-03 REQ-21: live quota fetcher per vendor masih mengembalikan dummy/stub.

## Feature Requirements
### F-01 — Base Gateway & Core Translator
- **Scope:** Endpoint gateway `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, dan `/v1/models` dengan Hub-and-Spoke translator untuk streaming SSE dan non-streaming.
- **REQ-01 (Chat Endpoint):** WHEN client mengirim request `POST /v1/chat/completions` THEN sistem SHALL memproses payload format OpenAI dan mengembalikan respons OpenAI yang valid. (Ref: AC-01)
- **REQ-02 (Messages Endpoint):** WHEN client mengirim request `POST /v1/messages` THEN sistem SHALL memproses payload format Anthropic dan mengembalikan respons Anthropic yang valid. (Ref: AC-02)
- **REQ-03 (Hub-and-Spoke):** WHEN format sumber berbeda dengan format target provider THEN sistem SHALL menerjemahkan payload melalui pivot format OpenAI sebelum dikirim ke upstream. (Ref: AC-03)
- **REQ-04 (Streaming):** WHILE streaming diaktifkan (`stream: true`) THEN sistem SHALL mengalirkan event SSE ke client secara inkremental menggunakan native TransformStream. (Ref: AC-04)
- **REQ-05 (Discovery):** WHEN client mengirim `GET /v1/models` THEN sistem SHALL mengembalikan daftar model aktif dalam format skema OpenAI Model List. (Ref: AC-05)
- **REQ-06 (Validation):** IF body request tidak valid atau model tidak ditemukan THEN sistem SHALL mengembalikan status HTTP 400 atau 404 dengan pesan error standar OpenAI. (Ref: AC-06)
- **REQ-07 (Transport Failure):** IF provider upstream gagal sebelum byte respons pertama dikirim THEN sistem SHALL mengembalikan status HTTP error yang tepat tanpa membiarkan koneksi menggantung. (Ref: AC-07)
- **REQ-08 (Warmup Intercept):** WHERE request terdeteksi sebagai prompt warmup atau model naming Claude Code THEN sistem SHALL mengembalikan respons instan sintetis tanpa memanggil provider upstream. (Ref: AC-08)
- **Verification:** Unit tests untuk translator roundtrip (OpenAI ↔ Claude ↔ Gemini) dan integration tests untuk endpoint HTTP `/v1/chat/completions` dan `/v1/messages`.

### F-02 — Provider Connections & OAuth
- **Scope:** Penyimpanan akun kredensial ke SQLite (`connections`), OAuth token lifecycle (refresh, expiry), failover cooldown saat limit rate (429), dan konfigurasi proxy per koneksi.
- **REQ-09 (SQLite Schema):** WHEN sistem diinisialisasi THEN database SQLite `data/zenroute.db` SHALL dibuat dengan tabel `connections` dan indeks yang sesuai bila belum ada. (Ref: AC-01)
- **REQ-10 (Credential Selection):** WHEN request dialihkan ke suatu provider THEN sistem SHALL memilih connection aktif yang tidak dalam masa cooldown menggunakan strategi rotasi/prioritas. (Ref: AC-02)
- **REQ-11 (Proactive Refresh):** IF access token suatu connection telah kedaluwarsa THEN sistem SHALL memperbarui token secara otomatis sebelum request diteruskan ke upstream. (Ref: AC-03)
- **REQ-12 (Reactive Refresh 401):** IF upstream mengembalikan status HTTP 401 atau 403 THEN sistem SHALL me-refresh token sekali dan mengulang eksekusi request ke upstream. (Ref: AC-04)
- **REQ-13 (Cooldown 429):** IF upstream mengembalikan status HTTP 429 THEN sistem SHALL menandai connection dengan cooldown sementara (`cooldown_until`). (Ref: AC-05)
- **REQ-14 (Proxy Routing):** WHERE connection memiliki konfigurasi `proxy_url` THEN sistem SHALL merutekan HTTP request melalui proxy yang dikonfigurasi. (Ref: AC-06)
- **REQ-15 (Account Management):** WHEN connection didaftarkan atau diupdate THEN sistem SHALL memvalidasi parameter dan menyimpannya ke tabel SQLite. (Ref: AC-07)
- **REQ-16 (Background Refresher):** WHILE background refresh loop aktif THEN sistem SHALL memindai dan memperbarui token OAuth yang mendekati kedaluwarsa (<5 menit). (Ref: AC-08)
- **Verification:** Integration tests menggunakan `:memory:` database untuk query CRUD koneksi, mock OAuth token refresh, dan simulasi penanganan 429/401.

### F-03 — Usage Tracking & Quota Sync
- **Scope:** Ekstraksi metrik token (in/out/total/duration) per request chat, penulisan ke tabel SQLite `usage_history`, live quota/balance sync untuk provider yang didukung, dan endpoint agregasi `/api/usage` & `/api/quota`.
- **REQ-17 (Non-Streaming Usage):** WHEN non-streaming chat request selesai THEN sistem SHALL mengekstrak metrik token dari respons dan menyimpannya ke tabel `usage_history`. (Ref: AC-01)
- **REQ-18 (Streaming Usage Tap):** WHILE streaming SSE berlangsung THEN sistem SHALL menangkap event usage tanpa memblokir transfer data ke client dan menyimpan total token ke `usage_history` saat stream selesai. (Ref: AC-02)
- **REQ-19 (Usage Analytics API):** WHEN client meminta `GET /api/usage` THEN sistem SHALL mengembalikan agregasi data token yang dapat difilter berdasarkan rentang waktu atau provider. (Ref: AC-03)
- **REQ-20 (Quota Status API):** WHEN client meminta `GET /api/quota` THEN sistem SHALL mengembalikan status sisa kuota dan saldo akun dari cache. (Ref: AC-04)
- **REQ-21 (Live Quota Sync):** IF provider mendukung endpoint saldo/kuota THEN sistem SHALL menyinkronkan data sisa kuota live ke cache status koneksi. (Ref: AC-05)
- **REQ-22 (Non-Blocking Failure):** IF persistensi usage mengalami error THEN sistem SHALL tidak menggagalkan respons utama chat ke client. (Ref: AC-06)
- **REQ-23 (Exhausted Account Exclusion):** WHEN kuota akun terdeteksi 0 atau habis THEN sistem SHALL mengabaikan akun tersebut dari pemilihan rute aktif. (Ref: AC-07)
- **Verification:** Unit tests penulisan `usage_history` via SQLite `:memory:`, streaming SSE usage tap test, dan endpoint testing `/api/usage`.

### F-04 — Token Saver Engine
- **Scope:** Pipeline pemadatan prompt in-memory: algoritma RTK untuk deduplikasi log terminal & tool outputs, penyisipan instruksi efisiensi Caveman ke system prompt, dan prinsip fail-open request.
- **REQ-24 (RTK Compaction):** WHEN RTK aktif THEN sistem SHALL memadatkan baris berulang pada teks yang diketik user tanpa merusak struktur sintaks kode. Hasil tool dan giliran assistant tidak diubah (revisi F-06: hasil tool berisi isi file mentah yang dicocokkan persis saat agent mengedit). (Ref: AC-01)
- **REQ-25 (Caveman Injection):** WHEN Caveman aktif THEN sistem SHALL menyisipkan aturan instruksi efisiensi jawaban ke system prompt. (Ref: AC-02)
- **REQ-26 (Fail-Open Guarantee):** IF pemadatan token mengalami exception THEN sistem SHALL mengembalikan payload asli secara fail-open tanpa menggagalkan request HTTP. (Ref: AC-03)
- **REQ-27 (Toggle Settings):** WHEN RTK atau Caveman dinonaktifkan THEN sistem SHALL meneruskan payload tanpa modifikasi. (Ref: AC-04)
- **REQ-28 (Code Integrity):** WHILE memadatkan konten THEN sistem SHALL menjaga keutuhan blok kode markdown (` ``` `) dan struktur JSON. (Ref: AC-05)
- **REQ-29 (Per-Request Override):** WHEN request menyertakan header `x-zenroute-token-saver: false` THEN sistem SHALL melewati pipeline pemadatan. (Ref: AC-06)
- **REQ-30 (Savings Metrics):** WHEN pemadatan selesai THEN sistem SHALL menghitung estimasi karakter/token yang dihemat untuk keperluan monitoring audit. (Ref: AC-07)
- **Verification:** Unit tests pemadatan log berulang (RTK), verifikasi penyisipan Caveman pada format OpenAI & Anthropic, dan simulasi fail-open.

### F-05 — Minimal Dashboard UI
- **Scope:** Antarmuka web server-side rendered (SSR) via Hono untuk navigasi Overview, manajemen akun Connections, analitik Usage & Quota, dan konfigurasi Settings.
- **REQ-31 (Overview Page):** WHEN pengguna mengakses `GET /` atau `GET /dashboard` THEN sistem SHALL merender halaman Overview dengan status gateway dan ringkasan metrik. (Ref: AC-01)
- **REQ-32 (Connections Page):** WHEN pengguna mengakses tab Connections THEN sistem SHALL menampilkan daftar akun terdaftar dengan tombol tindakan dan status kuota. (Ref: AC-02)
- **REQ-33 (Connection Form):** WHEN form penambahan akun dikirim (`POST /dashboard/connections`) THEN sistem SHALL memvalidasi dan menyimpan akun baru ke SQLite. (Ref: AC-03)
- **REQ-34 (Usage Page):** WHEN pengguna mengakses tab Usage THEN sistem SHALL menyajikan tabel riwayat dan agregasi token per model. (Ref: AC-04)
- **REQ-35 (Settings Page):** WHEN pengguna mengakses tab Settings THEN sistem SHALL menampilkan form pengaturan global dari SQLite. (Ref: AC-05)
- **REQ-36 (Settings Form):** WHEN form pengaturan dikirim (`POST /dashboard/settings`) THEN sistem SHALL menyimpan nilai baru ke tabel `settings`. (Ref: AC-06)
- **REQ-37 (Zero Bundler SSR):** WHILE dashboard web dirender THEN sistem SHALL menggunakan HTML/JSX bawaan Hono tanpa memerlukan build step frontend (ukuran <50 KB). (Ref: AC-07)
- **Verification:** Integration tests rendering halaman `/dashboard` dan `/dashboard/connections`, serta form POST testing via `app.request`.

### F-06 — Security Hardening & Gateway API Keys
- **Scope:** API key gateway yang tersimpan sebagai hash, penegakan `require_api_key`, pemisahan kredensial klien dari upstream, hardening jaringan dan dashboard, timeout stream, dan settings token saver yang tersambung.
- **REQ-38 (Key Storage):** WHEN API key dibuat THEN sistem SHALL menampilkan plaintext sekali dan hanya menyimpan hash SHA-256 serta prefix tampilan.
- **REQ-39 (Key Enforcement):** WHILE `require_api_key` aktif atau bind non-loopback THEN sistem SHALL menolak request `/v1` tanpa key zenroute aktif dengan HTTP 401.
- **REQ-40 (Credential Isolation):** THE SYSTEM SHALL tidak meneruskan header auth klien ke upstream; IF tidak ada connection aktif THEN sistem SHALL membalas HTTP 503.
- **REQ-41 (Control Plane Access):** WHEN request dashboard atau `/api` datang dari alamat non-loopback THEN sistem SHALL menolak dengan HTTP 403; WHEN POST dashboard datang lintas origin THEN sistem SHALL menolak dengan HTTP 403.
- **REQ-42 (Host & CORS):** WHILE bind loopback THEN sistem SHALL menolak Host non-loopback kecuali terdaftar di `ZENROUTE_ALLOWED_HOSTS`; CORS hanya aktif untuk origin di `ZENROUTE_CORS_ORIGINS`; POST `/v1` wajib `Content-Type: application/json`.
- **REQ-43 (Output Escaping):** THE SYSTEM SHALL meng-escape semua nilai dinamis yang dirender di dashboard.
- **REQ-44 (Stream Timeouts):** THE SYSTEM SHALL membatasi waktu tunggu header respons upstream dan jeda antar-chunk, tanpa batas durasi total stream.
- **REQ-45 (Settings Wiring):** WHEN Settings token saver diubah THEN request berikutnya SHALL mengikuti nilai baru; Caveman default nonaktif.
- **Verification:** `tests/apiKeys.test.js`, `tests/security.test.js`, `tests/dashboardKeys.test.js`, `tests/timeout.test.js`, `tests/tokenSaver.test.js`.
