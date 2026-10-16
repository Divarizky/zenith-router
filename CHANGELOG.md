## [0.1.5] - 16-10-2026

Adaptasi OpenCode v2, fidelitas konteks lintas provider, dan stabilisasi pengujian.

### OpenCode & Upstream Protocol

- Upgrade ke protokol v2 inference, rute `/inference/v1/*` dan header sesi kanonikal, dengan generator ID sesi 48-bit.
- Dua tool fingerprint kanonikal (`read` dan `shell`) dengan aliasing otomatis tool klien yang bertabrakan.
- Kalkulasi budget token dengan pembatasan per lane (chat 131072, responses 65536) dan preservasi saat retry.
- Pemulihan otomatis 400 `ModelProtocolUnsupported` dengan pergantian payload lintas lane dan cache lane TTL 1 jam.
- Impor model OpenCode dari endpoint v2 dengan filter free-model yang diperbarui.

### Fidelitas Konteks & Translator

- Penerusan langsung (passthrough) saat format sumber dan target sama, termasuk Body Responses mentah.
- Preservasi `reasoning`, `include`, dan tool kustom pada `/v1/responses`.
- Pemetaan tool call, gambar, `stop` dan `max_tokens` antar format (Claude, OpenAI, Responses, Gemini, Kiro, CommandCode).
- Pulihkan nama tool di respons dan pertahankan thought signature Gemini lintas giliran percakapan.
- Executor Codex men strip field tak didukung (`max_output_tokens`, `temperature`, `top_p`, `top_k`) dengan default `store=false`.
- RTK mempertahankan baris kosong tanpa collapsing; executor CommandCode menyelesaikan nama tool result dari lookup, netral workingDir, dan mime data-URL.

### Pengujian

- Matriks fidelitas end-to-end (sumber -> target) melalui `tests/contextFidelity.test.js`.
- Suite khusus Opencode (alias, retry-budget, protocol-fallback) dan budget token.
- Total 570 test lulus (100 %) tanpa regresi dari perilaku retry/p passing cache.

## [0.1.4] - 14-10-2026

Pemeriksaan kuota live Command Code, failover combo pada error stream SSE, dukungan proxy SOCKS5 native, fingerprinting Freebuff, dan penyegaran UI update banner.

### Kuota & Penggunaan

- Fetcher kuota live Command Code (`src/services/quota/commandcode.js`) membaca endpoint `/alpha/billing/credits` dan `/alpha/billing/subscriptions` Command Code API dengan bearer auth.
- Visualisasi di kartu Usage: menampilkan batas jendela 5 jam ("5-hour") dan mingguan ("Weekly") lengkap dengan persentase pemakaian dan hitung mundur reset, saldo kredit ("Credits"), serta pill nama paket langganan (seperti "Go", "Pro", "Ultra").
- Akun ditandai habis (`is_exhausted`) otomatis hanya jika flag `exceeded` aktif pada jendela; saldo kredit kosong tidak mengunci model gratis.

### Routing & Failover Combo

- Probe error stream SSE (`src/services/streamProbe.js`): mendeteksi error upstream yang dikirim dengan status HTTP 200 di dalam stream SSE (seperti rate-limit atau quota error dari Cline).
- Respons stream yang sehat di-replay utuh tanpa latensi tambahan bagi klien; jika event pertama berisi error, payload diubah menjadi status HTTP error (429/401/502).
- Failover combo dan mekanisme cooldown akun terpicu saat anggota stream pertama gagal, alih-alih menampilkan error mentah ke pengguna.
- Normalisasi envelope error Cline (`src/executors/cline.js`) berstatus HTTP 200 `{"success":false,"error":{...}}` menjadi respons error HTTP formal.

### Jaringan & Transport Proxy

- Dukungan proxy SOCKS5 native (`src/executors/proxy.js`) mengikuti RFC 1928 dan RFC 1929 menggunakan `node:net` bawaan tanpa dependensi eksternal.
- Resolusi alamat target melalui proxy (ATYP `0x03` DOMAINNAME) untuk mencegah kebocoran DNS lokal.
- Mendukung autentikasi username/password (metode `0x02`) maupun koneksi tanpa autentikasi (`0x00`), serta pembatalan melalui `AbortSignal`.

### Penyedia & Eksekutor

- Pengerasan Freebuff (`src/executors/freebuff.js`): cache sesi stabil in-memory (TTL 30 menit, kapasitas 1000 entri LRU) per pasangan model dan kunci sesi, rotasi User-Agent CLI resmi acak, header penolakan pengumpulan data (`provider: { data_collection: "deny" }`), dan sentinel stop `cb_easp` untuk mencegah error 403 `free_mode_cli_required`.
- Pembaruan impor model Command Code (`src/services/modelImport.js`): pengambilan daftar model via `rawTransport` (HTTP langsung) dan penyaringan model `/messages` Claude yang belum didukung endpoint generate.

### Tampilan & Pengujian

- Desain ulang update banner sidebar (`src/ui/layout.js`) dengan badge indikator, kontras yang lebih tajam, dan tombol aksi pembaruan langsung.
- Total 496 test (32 test baru) 100% lulus.

## [0.1.3] - 14-10-2026

Manajemen Proxy Pool mandiri, rotasi proxy provider tanpa akun, pembaruan protokol OpenCode 1.19.0, dan normalisasi tool Claude Code.

### Proxy Pool & Rotasi (F-08)

- Halaman mandiri **Proxy Pools** di sidebar (`/dashboard/proxies`) dengan antarmuka divide-y serupa 9router: tombol header Batch Import dan Add Proxy Pool dialog modal, status ringkasan (Total dan Active), daftar baris dengan badge dot status tes (`ok`/`error`/`unknown`), status aktif, dan jumlah akun terikat (`X bound`), serta aksi cepat (toggle aktif/nonaktif, tes kesehatan 8 detik, modal ubah aman, dan hapus terlindungi).
- Pengikatan proxy akun provider: akun dapat dihubungkan ke proxy dari daftar pool, alamat manual, atau koneksi langsung; seluruh lalu lintas akun (chat, kuota, token refresh, import model) mengikuti binding tersebut dan gagal tertutup (fail-closed) tanpa membocorkan request ke koneksi langsung saat proxy bermasalah.
- Impor massal daftar proxy menerima format URL lengkap `http://...`, `host:port`, dan `host:port:user:pass`.
- Rotasi proxy untuk provider tanpa akun (noAuth): pilihan strategi tidak aktif, bergiliran (round-robin), atau acak, dengan retry otomatis hingga 3 percobaan per request.
- Transport proxy kustom `proxyFetch` dengan dukungan `Proxy-Authorization` untuk tunnel CONNECT HTTPS dan forward HTTP, pembatalan request terikat waktu, dan penyaringan password dari pesan error.

### Protokol OpenCode & Kompatibilitas Tool (F-09)

- Mengatasi penolakan 403 FreeTierError dari OpenCode Zen dengan menerapkan pembentukan ID sesi (`ses_`) ber-prefix 48-bit inversi bitwise timestamp dan ID request (`msg_`) dengan timestamp menaik, serta User-Agent resmi `opencode/1.19.0`.
- Cache sesi stabil berbasis percakapan klien di memori proses (TTL 30 menit, kapasitas 1000 entri LRU) agar giliran percakapan multi-turn tidak memicu sesi baru atau kebocoran kuota.
- Pemaksaan streaming upstream (`forceStream: true`) untuk seluruh model gratis OpenCode dengan agregasi transparan bagi klien non-streaming.
- Pengerasan endpoint Responses API: sanitasi nama tool `[a-zA-Z0-9_-]` dengan pemulihan nama asli di respons, pemasangan otomatis output sintetis `{}` untuk function call yatim (dan pembuangan output yatim), pembatasan `max_output_tokens` di rentang 16–65536, serta pembersihan field tersebut pada backend Codex.
- Normalisasi halusinasi parameter tool bawaan Claude Code (Bash, Read, Edit, Write, MultiEdit, Glob, Grep) dari model non-Anthropic saat melayani klien `/v1/messages`, mempertahankan filter `glob` pada Grep.

### Proyek & Keamanan

- Total 464 test (45 test baru) 100% hijau, mutasi terverifikasi.
- Pencegahan stored XSS pada tombol Edit dashboard Proxy Pools dengan encoding JSON + atribut HTML ganda.
- Kredit konsep antarmuka Proxy Pools kepada 9router (MIT).

## [0.1.2] - 12-10-2026

Fitur combo dari routing sampai dashboard, digabung dengan halaman Providers.

### Rantai model (combo)

- Combo memanggil beberapa model lintas provider lewat satu nama. Strategi `fallback` menurut urutan anggota, atau `round-robin` yang bergiliran per request; jumlah model per giliran diatur lewat setting `combo_round_robin_count`.
- Rate limit pada satu model hanya mengunci pasangan (koneksi, model) itu, bukan seluruh akun. Kunci akun dan kunci model disimpan terpisah dan tidak pernah dipendekkan.
- Request berisi gambar otomatis memprioritaskan anggota yang mendukung vision, dan error combo mengikuti format endpoint yang dipanggil (OpenAI atau Anthropic).
- Entri combo di `GET /v1/models` membawa rollup kapabilitas seluruh anggota dan context window terkecil di rantainya.

### Dashboard combo

- Halaman combo: membuat, mengubah urutan anggota, mengganti strategi, mengaktifkan/menonaktifkan, menghapus, dan mengganti nama. Tiap combo dirender sebagai kartu dengan satu bagian Edit.
- Dialog "Pilih model" menampilkan model dari provider yang terhubung, dikelompokkan per provider lengkap dengan ikon, badge vision/reasoning, dan context window; pencarian langsung dan multi-select tanpa menutup dialog. Tanpa JavaScript, textarea biasa tetap berfungsi penuh.
- Riwayat pemakaian mencatat nama combo (`combo_name`) pada ketiga gateway untuk jalur stream dan non-stream; panel Recent Requests menampilkan "combo → model".

### Penyatuan halaman

- Menu Combos digabung ke halaman Providers lewat tab Providers/Combos; label sidebar menjadi "Providers & Combos". URL `/dashboard/combos` lama tetap hidup sebagai redirect dengan query diteruskan.

### Upgrade otomatis

- Sidebar memeriksa rilis terbaru di GitHub lalu menawarkan Upgrade sekali klik: backup database via `VACUUM INTO`, checkout tag, `npm install`, dan restart otomatis dengan health check. Instalasi yang bukan clone git hanya menerima tautan unduhan, dan semua kejadian tercatat di `data/updater.log`.

### Proyek

- Suite 370 test dengan enam file test baru; perubahan krusial diverifikasi mutation testing.
- Konsep rantai combo dan dialog pemilih model mengacu pada 9router (MIT).

## [0.1.1] - 12-10-2026

Perbaikan untuk kompatibilitas provider, observabilitas, dan dashboard.

### Kemampuan model

- Data `vision` dan `reasoning` kini disimpan per model saat sinkronisasi, dan dikirim di `GET /v1/models` bersama `context_length` dan `max_completion_tokens`. Client yang menghormati `capabilities.reasoning` berhenti mengirim `reasoning_effort` ke model yang tidak mendukungnya.
- Tabel kapabilitas model di `src/providers/capabilities.js`, berurutan dari data API provider lalu pola nama model, lalu `null` bila tidak diketahui. Model yang tidak dikenal tidak mendapat field apa pun, bukan asumsi.
- Ikon otak dan mata di baris model pada halaman provider menandai kemampuan thinking dan vision.

### Perbaikan provider Mistral

- Role `developer` dinormalisasi menjadi `system` untuk sumber berformat OpenAI; sebelumnya ditolak 422 `union_tag_invalid`.
- Adaptasi payload per provider: `max_completion_tokens` dan `seed` diubah namanya, sedangkan `store`, `user`, `logit_bias`, `verbosity`, dan `web_search_options` dibuang. Field tersebut sebelumnya memicu 422 `extra_forbidden`.
- ID tool call dipetakan ke 9 karakter alfanumerik secara stabil antar request; bentuk lain ditolak 400 dengan kode 3280.
- `reasoning_effort` dibuang lalu request diulang sekali untuk model yang menolaknya (400 kode 3051), dan pasangan model/provider diingat supaya request berikutnya langsung mengirim tanpa field itu.
- Penolakan tingkat tier dibedakan dari rate limit biasa: 429 dengan batas 0 request per menit menjadi 403 `model_not_available`, dan 429 pada kuota token per menit yang belum tersentuh menjadi 413 `request_too_large`. Keduanya tidak lagi mendinginkan akun. 503 kini menyertakan `Retry-After` dan menyebut lama tunggu.
- Model yang ditolak semua akun karena tier dinonaktifkan otomatis dan bisa diaktifkan lagi dari halaman provider.
- Sinkronisasi model memverifikasi akses tiap model dengan request `messages` kosong yang tidak memakai token, sehingga provider gratis tidak lagi menampilkan model yang tidak bisa dipanggil.

### Observabilitas

- Refresh token proaktif dan sinkronisasi kuota latar belakang melapor hanya ke Console Log dashboard, tidak lagi ke terminal.
- Panel Recent Requests memperbarui diri tiap 2 detik lewat `GET /api/usage/recent`, dengan animasi baris baru dan jeda saat tab tidak aktif.

### Dashboard

- Tabel model memakai mode pemilihan: kolom checkbox tersembunyi sampai tombol `Pilih` ditekan, dan berubah menjadi `Batalkan Pilih` selama mode aktif. Klik baris mencentang model, link dan tombol di dalam baris tetap mengikuti perilaku normal.
- Ikon router di topologi dibuat persegi agar tidak gepeng dan diganti ke monokrom; aksen node aktif dan node terakhir dipakai tetap dipertahankan.

### Proyek

- Workflow GitHub Actions menjalankan suite test pada Node 22.13.0 dan Node 24 untuk setiap pull request dan push ke `master`.
- Branch `master` dilindungi: wajib pull request dengan minimal satu approval, tidak bisa dihapus, tidak bisa di-force-push, dan wajib lolos kedua status check test.
- README ditulis ulang untuk pengguna akhir: bagian status fitur dihapus, ditambah tabel provider, referensi kemampuan model, keamanan, dan batasan yang diketahui.

## [0.1.0] - 11-10-2026

Rilis pertama.

### Gateway dan routing

- Endpoint `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/responses`, dan `GET /v1/models`, lengkap dengan streaming SSE dan non-streaming.
- Translasi dua arah OpenAI ↔ Claude termasuk tool calling, OpenAI Responses untuk backend Codex, Google Cloud Code/Gemini `v1internal`, dan AWS EventStream binary untuk Kiro.
- Prefix model mengarah ke provider (`glm/…`, `cc/…`, `cx/…`, atau id provider apa pun).
- Failover ke akun berikutnya saat 429/5xx, cooldown 60 detik untuk akun bermasalah, refresh token otomatis (proaktif sebelum request dan pindaian latar belakang tiap 5 menit), dan satu kali coba ulang setelah 401/403.
- Traffic Guard: batas konkurensi in-flight per akun, antrean FIFO, jitter proaktif dan reaktif, plus strategi rotasi `lru` dan `sticky`.
- API key gateway `zr_…` disimpan sebagai hash SHA-256 dan hanya tampil sekali saat dibuat; bisa diwajibkan untuk semua request `/v1`.

### Akun dan provider

- Registry 21 provider: OAuth, API key, dan free tier.
- Login OAuth lewat browser dengan callback lokal (Claude, Codex, Antigravity, Cline) dan login device code (GitHub Copilot, Kilo Code, Kiro, GLM).
- Import login dari instalasi CLI lokal (Kiro, Freebuff, Command Code) serta tempel token manual.
- Proxy HTTP/HTTPS per akun, sinkronisasi model gratis saat startup dan tiap 6 jam, serta import daftar model live dari upstream.
- Manajemen akun dan model per provider di dashboard, termasuk custom model dan enable/disable massal.

### Kuota dan observabilitas

- Live quota fetcher untuk 8 provider: Codex, Claude, Kiro, xKiro, Antigravity, GitHub Copilot, GLM, dan OpenRouter.
- Kartu kuota di halaman Usage: bar per jendela atau model, hitung mundur reset, tombol Sync per akun, dan tombol Re-sync semua akun.
- Auto-refresh kuota berkala tiap 15 menit, berjalan di background tanpa pengaturan on/off.
- Topologi SVG provider aktif di sekitar router dan panel Recent Requests.
- Akun tanpa sumber data kuota disembunyikan dari halaman Kuota & Balance.
- Timestamp log memakai jam lokal, bukan UTC.

### Prompt dan token

- Token Saver dengan RTK untuk pemadatan prompt otomatis.
- Caveman untuk pemadatan agresif prompt panjang (Opt-in, default mati).
- Usage tracking untuk streaming dan non-streaming, plus audit pemakaian per API key.

### Dashboard

- Halaman Overview, Providers, Usage & Quota, Token Saver, API Keys, dan Settings, dirender server tanpa build step frontend.
- Settings terbagi menjadi `General` dan `Accounts & Connections` dalam satu form.
- Bahasa tubuh dashboard Bahasa Indonesia, sidebar dan judul halaman Inggris.
- Dashboard dan endpoint kontrol hanya menerima koneksi dari localhost.

### Perbaikan

- Bentuk tool fingerprint kini mengikuti path tujuan (`/responses`, `/messages`, `/chat/completions`) sehingga request dengan banyak tool tidak lagi ditolak 400.
- Item `function_call` pada request Responses menyertakan `call_id`, sehingga pasangan `function_call_output` valid.
- Argumen tool tidak lagi bocor ke `content` pesan saat streaming.
- Header identitas klien diterapkan pada akun Cline.
- Varian tier Antigravity memakai `thinkingLevel` di `generationConfig` alih-alih akhiran `(high)`/`(medium)`/`(low)` pada nama model, yang menyebabkan 404.
- Parser Codex membaca `rate_limit.primary_window`/`secondary_window` dan melabeli bar dari panjang jendela, bukan "Primary window" tetap.

[0.1.1]: https://github.com/Divarizky/zenith-router/releases/tag/v0.1.1
[0.1.0]: https://github.com/Divarizky/zenith-router/releases/tag/v0.1.0
