## [Unreleased]

Provider DeepSeek Web Chat lewat sesi browser, batas sesi paralel per akun, dan observability slot di dashboard.

### Provider `dsw` (DeepSeek Web Chat)

- Provider baru berkategori `session` yang memakai user token dan cookies dari `chat.deepseek.com`, bukan API resmi. Token disimpan di kredensial koneksi dan dikirim apa adanya; gateway tidak pernah meneruskan header auth klien ke upstream.
- Transport menangani PoW challenge (WASM di-vendor, MIT, tercatat di `NOTICE`), pembuatan chat session, `chat/completion` dengan header `x-ds-pow-response`, pembacaan history sebagai sumber teks otoritatif, dan fallback ke fragmen SSE bila history belum selesai. Proxy per akun tetap dihormati.
- Token mati tidak di-refresh: 401/403 diteruskan dengan penanda `X-Zenith-Auth-Expired: 1`. Klien yang memutus koneksi dijawab 499.
- Tool call dari model (tag `<tool_call>` maupun dialek DSML) diparse menjadi `tool_calls` native, sehingga `/v1/chat/completions`, `/v1/messages` (blok `tool_use`, termasuk streaming `input_json_delta`), dan `/v1/responses` (`function_call`) bekerja tanpa format baru. Markup tidak pernah bocor ke `content`, dan blok kode panjang yang menempel dipangkas.
- Karena upstream tidak melaporkan token, `usage` diisi estimasi dan ikut menghitung argumen tool.

### Batas sesi paralel per akun

- Traffic Guard kini memakai cap per akun lewat urutan setting `provider_concurrency:<id>` → field `concurrency` registry → `max_account_concurrency`. `dsw` menetapkan default 3 tanpa mengubah provider lain; kartu **Batas Sesi Paralel** bisa menimpanya 1–10.
- Antrean utama menunggu maksimal 30 detik lalu menjadi 429 `account_busy` dengan `Retry-After: 5` dan failover ke akun berikutnya. Antrean bantu berhenti di 2 detik dan tidak pernah menyalip percakapan.
- Sesi web per akun dibatasi 3 rantai utama + 2 bantu, dengan single-flight per rantai, TTL 6 jam, dan eviction aux-first.

### DeepSeek Web: agent tidak lagi mengulang jawaban lama

- Turn yang ditolak upstream dulu dijawab dengan jawaban turn sebelumnya, karena DeepSeek membalas penolakan dengan HTTP 200 berisi JSON (`biz_code`) dan gateway langsung membaca pesan assistant terakhir di history. Agent lalu menjalankan tool call yang sama berulang-ulang (terlihat di `usage_history`: delapan respons berturut-turut dengan 186 token output identik). Sekarang body error dibaca sebagai error, jawaban dicocokkan dengan id dari `event: ready`, dan turn lanjutan yang ditolak diulang sekali di chat baru.
- Token mati (`{"code":40003}` dengan HTTP 200) kini ditandai kedaluwarsa, bukan error sementara.
- Parser stream mengikuti bentuk asli: path dan operasi patch terbawa ke frame berikutnya (`{"v":"..."}`), `APPEND` selalu menyambung, `BATCH` dan `event: ready` dibaca. Fixture tangkapan asli ada di `tests/fixtures/deepseekWeb/`.
- Percakapan dengan session key yang sama (subagent, klien tanpa header sesi) kini punya chat web masing-masing dan berjalan paralel.
- Hasil tool diberi nama tool dan id panggilannya, karena klien Claude, Codex, dan Responses tidak mengirim `name`. Batas hasil tool naik dari 4.000 ke 12.000 karakter dengan potongan awal dan akhir.
- Reasoning `deepseek-reasoner` di-stream sambil berjalan, dan `usage` melaporkan `reasoning_tokens`.
- Chat web yang tidak dipakai lagi dihapus dari sidebar (`ZENITH_DEEPSEEK_KEEP_SESSIONS=1` untuk menyimpan).
- Login browser: menutup jendela langsung menghentikan proses, dan login ulang atau token tempelan yang sama tidak menambah akun kembar.

### DeepSeek Web: tool call rusak tidak lagi tampil sebagai teks

- Perintah bash yang muncul mentah di akhir jawaban berasal dari tool call yang gagal diparse, lalu dikirim sebagai `content` dengan `finish_reason: stop`. Parser kini menerima JSON dengan kutip tidak di-escape, invoke tanpa prefix DSML (`<function_calls><invoke>`), parameter tanpa tag penutup, DSML tanpa `</invoke>`, dan satu parameter `arguments` yang membungkus seluruh argumen. Markup di dalam code fence jawaban tidak lagi dijalankan.
- Blok tool call yang tetap tidak terbaca dibuang, tidak ditampilkan, dan ditandai `malformed`. `turns.js` mengulang sekali di chat baru; kalau gagal lagi klien menerima 502 `malformed_tool_call`.

### DeepSeek Web: penyebab turn kosong ikut dilaporkan

- Turn yang selesai tanpa teks dulu selalu jadi 502 `history_incomplete` tanpa keterangan. Parser stream sekarang mencatat event non-`message` (`title`, `close`, `update_session`) beserta teks penjelasnya dan status akhir stream, lalu memasukkannya ke pesan error, mis. `status=CONTENT_FILTER; events=close; hint="..."; history=empty`.
- Penyebab yang dikenal dipetakan ke kode sendiri: status filter → 400 `content_filtered`; penolakan karena percakapan terlalu panjang → 413 `conversation_limit` (diulang sekali di chat baru); upstream sibuk → 429 `rate_limit_exceeded`; status `INCOMPLETE` → 502 `upstream_incomplete`. 413 dan 400 tidak memarkir akun karena bukan masalah kredensial.

### DeepSeek Web: mode thinking dan model `deepseek-reasoner`

- Model kedua `deepseek-reasoner` mengirim `thinking_enabled: true`; `deepseek-chat` tetap default dengan thinking mati.
- Reasoning kini benar-benar terbaca: upstream menamai fragmennya `THINK` (bukan `THINKING`), dan stream-nya berbentuk patch `{"p":"response/fragments/-1/content","v":"..."}`. Keduanya ditangani, sehingga `reasoning_content` terisi di respons non-stream maupun sebagai delta sebelum jawaban pada stream.
- Verifikasi nyata: satu turn `deepseek-reasoner` mengembalikan 258 karakter `reasoning_content` untuk jawaban 52 karakter, dan token reasoning ikut dihitung di `usage`.

### Dialog login DeepSeek mengikuti pola provider OAuth

- Tombol `Login di browser` kini jadi satu aksi utama di dialog, statusnya memakai blok `#oauth-status.oauth-status` yang sama dengan Antigravity/Claude/OpenAI, dan tempel token manual dilipat di `<details class="manual">`.
- Label akun dan proxy dibaca dari `acct-name`/`acct-proxy` seperti alur OAuth, dan dialog memakai `zrSessionLoginCancel()` untuk membatalkan flow.

### Login browser mengikuti default browser dan memakai sesi profil Anda

- Browser yang dibuka kini mengikuti default browser OS (Edge pada mesin ini), bukan selalu Chrome.
- Jendela login menyalin sesi dari profil browser Anda (`Local State`, cookie, `Local Storage/leveldb`), sehingga login DeepSeek yang sudah ada langsung terpakai tanpa menyentuh profil asli dan tanpa menutup browser yang sedang berjalan.
- Profil dipilih berdasarkan yang mengenal `deepseek.com` (`Default`/`Profile 1`/...), bukan hardcoded `Default`.
- `ZENITH_LOGIN_PROFILE=isolated` mengembalikan perilaku profil kosong.

### Login browser: verifikasi sesi dan pemakaian browser yang sudah terbuka

- Login sekali klik tidak lagi menyimpan akun dari halaman yang belum selesai login. Token wajib berasal dari halaman di luar `/sign_in`, panjangnya wajar, dan lolos verifikasi ke endpoint PoW (`verifySessionToken`); placeholder SPA seperti `undefined`/`null` kini dinormalkan menjadi kosong sehingga jendela tidak tertutup sebelum Anda sempat login.
- Kalau Chrome/Edge sudah berjalan dengan port debugging (default `http://127.0.0.1:9222`, bisa diubah lewat `ZENITH_CDP_ENDPOINT`), login membuka tab di browser itu dan memakai sesi yang sudah ada. Kalau tidak, gateway tetap membuka jendela profil sementara seperti sebelumnya.
- Dialog menampilkan fase nyata dari server (`Membuka browser...`, `Membuka tab di browser yang sudah berjalan...`, `Memeriksa sesi login...`, `Menunggu login...`) lewat field `phase` pada poll.

### Cooldown dua percobaan

- Kegagalan upstream tidak lagi langsung memarkir akun. 429/5xx serta 401/403 tanpa refresh baru menulis cooldown setelah **dua request klien terpisah** gagal pada akun yang sama; retry internal dalam satu request (failover akun, same-account retry, anggota combo, fallback default) dihitung satu percobaan lewat `requestId` yang dibagi `routeRequest`.
- Request pertama kini mengembalikan error upstream asli (mis. 500, 502, 429, atau 401) bukan pesan `All accounts are cooling down`, dan pesan itu baru muncul setelah akun benar-benar diparkir. Keberhasilan di antaranya mereset hitungan, dan `initDb` mengosongkan streak agar tes tidak saling mewarisi.

### Dashboard kuota

- Kartu Antigravity di halaman Kuota kini selalu menampilkan batas **Gemini 4 Argon mingguan** di depan, di luar collapse "Tampilkan N baris lagi". Baris ini menentukan apakah model Argon masih bisa dipanggil, jadi tidak boleh tersembunyi saat kartu memuat banyak pool. Urutan pool lain tidak berubah; hanya baris Argon mingguan yang dipin ke atas.

### Prefix dan ikon provider

- Prefix model provider web chat menjadi `dsw` (`dsw/deepseek-chat`). Alias lama `dweb` dan `chatbrain` tetap diterima sehingga klien yang sudah dikonfigurasi tidak putus.
- Ikon provider diganti mark DeepSeek resmi (128×128 RGBA, path logo resmi tanpa dependensi baru; atribusi ditambahkan di `NOTICE`).

### Login sekali klik (CDP)

- Dialog **Tambah Akun** untuk provider sesi mendapat tombol **Login di browser** (kolom token manual tetap ada di bawahnya): server membuka Chrome/Edge yang sudah terpasang dengan profil sementara ke halaman login DeepSeek, pengguna login manual, lalu token dan cookies disimpan otomatis sebagai akun baru. Tidak ada dependensi npm baru; browser digerakkan lewat Chrome DevTools Protocol.
- Flow berjalan di background dengan id acak dan TTL 5 menit, dipoll dashboard lewat `/dashboard/providers/accounts/login/{start,poll,cancel}`. Token tidak pernah dikirim ke halaman maupun log, profil sementara dihapus setelah selesai, dan proses browser dimatikan beserta anak-anaknya di Windows.
- Token hasil tangkapan dinormalkan dari bentuk `localStorage.userToken` (`{"value":"...","__version":"0"}`), `Bearer ...`, atau nilai berkutip, sama seperti input manual.
- Override `ZENITH_BROWSER_PATH` untuk menunjuk browser tertentu dan `ZENITH_LOGIN_TIMEOUT_MS` untuk mengubah batas tunggu. Alasan memilih CDP dibanding Selenium dicatat di ADR-6.

### Health check sesi

- Detail provider memeriksa token lewat `create_pow_challenge` (tanpa memulai percakapan), menampilkan badge `Sesi OK`, `Sesi kedaluwarsa`, atau `Gagal dicek`, dengan cache 5 menit (error 60 detik) dan dedupe probe bersamaan.
- Aksi **Periksa sesi** memaksa probe baru; **Perbarui sesi** mengganti token dan cookies tanpa menyentuh proxy serta membuang verdict lama. Kartu provider di halaman daftar ikut memperingatkan sesi kedaluwarsa.

### Observability

- `getProviderTraffic()` melaporkan `inFlight`, `queue`, `cap`, `perAccountCap`, dan rincian per akun. Dashboard menampilkan `${inFlight}/${cap} dipakai` plus jumlah antrean di kartu batas, dan kolom **Slot** per akun dengan penanda `+n` untuk waiter.

### Dokumentasi dan UI

- README menambah bagian Provider DeepSeek Web: cara mengambil token, contoh `curl` non-stream/stream/tool, arti batas per akun, cara memperbarui sesi, dan peringatan ToS.
- UI menampilkan peringatan risiko pemblokiran akun pada section Session Providers, modal tambah akun, dan detail provider. Provider tetap nonaktif sampai pengguna menambahkan akun sendiri.
- ADR-5 mencatat keputusan D1–D10 implementasi provider ini.

## [0.1.7] - 22-10-2026

Ketahanan OpenCode free tier, kuota Antigravity per pool, integrasi kuota OpenRouter dan Ollama Cloud, login Claude lewat redirect resmi, dan penanganan 404 transien upstream.

### Endpoint & Katalog OpenCode

- Base URL OpenCode kini dibaca dari `models.opencode.ai/api.json` (TTL 6 jam), sama dengan yang dipanggil CLI resmi: `https://opencode.ai/inference/openai/v1`. Gateway lama `/inference/v1` menyaring trafik lebih ketat dan menolak keluarga nemotron dan space-bunny.
- Daftar model gratis disinkronkan dari katalog yang sama; keputusan gratis mengikuti `cost.input`, bukan akhiran nama, dan model `status: deprecated` berhenti dirutekan serta ditolak lokal dengan HTTP 410 sebelum dikirim ke upstream.
- `ZENITH_OPENCODE_BASE_URL` mengarahkan request ke proses bridge eksternal (misal `opencode-free-bridge` di WSL) tanpa mengubah kode. Bridge hanya melayani chat completions, jadi semua model dipaksa ke lane chat dan pindah lane otomatis dimatikan selama override aktif.

### Gate 403 Free Tier

- Pada 403 `FreeTierError`, executor melakukan satu retry dengan session ID baru. Bila tetap ditolak, request berikutnya dijawab lokal selama 30 detik (naik dua kali lipat per penolakan beruntun, maksimal 10 menit; pesan blokir jaringan/IP langsung memulai cooldown tanpa retry; 426 diberi label `version-rejected`) dengan `Retry-After` dan `X-OpenCode-Gate: ip-throttled|shape-rejected` alih-alih diteruskan, sehingga blokir per-IP tidak diperpanjang oleh retry klien. Session ID baru dari retry disimpan menggantikan yang ditolak, dan `Retry-After` serta label `X-OpenCode-*` ikut diteruskan ke klien.
- Audit bentuk request memeriksa anchor yang diukur upstream (tool `read`, User-Agent `opencode/*`, header sesi, stream) untuk membedakan egress yang diblokir dari request yang dibentuk salah.
- Status lokal selama cooldown adalah 429, yang tetap memicu Default Fallback Model sehingga request pindah ke model cadangan, bukan berhenti di dead end. Override: `ZENITH_OPENCODE_GATE_COOLDOWN_MS` (default 30000, 0 menonaktifkan) dan `ZENITH_OPENCODE_GATE_STATUS`.

### Ketahanan Transport Upstream

- Reset socket yang ditutup upstream saat idle (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, `UND_ERR_CLOSED`) diulang sekali di koneksi baru, hanya untuk body string. Kegagalan DNS dan connect tidak diulang.
- Kegagalan transport tidak lagi mengunci akun. Hanya cooldown per model yang dilewati, dan failover tetap berjalan ke koneksi lain.
- Pesan 502 menyebut langkah yang gagal dan host tujuan (contoh: `[ENOTFOUND getaddrinfo] host=...`), dan string abort tidak lagi tampil sebagai `undefined`.
- Klien yang memutus koneksi dijawab 499 `client_closed`, tidak dicatat sebagai `[FAILOVER]`, dan tidak mengunci akun.

### Failover Kuota & Auth

- Waktu reset kuota dibaca dari body error 429 Google (`RetryInfo.retryDelay` dan `ErrorInfo.metadata.quotaResetTimeStamp`/`quotaResetDelay`) selain header `Retry-After`, sehingga akun yang kuotanya habis dikunci sampai reset — bukan 60 detik yang membuat request terus mencoba akun yang sama.
- Percobaan refresh token yang tetap menjawab 401/402/403 mengunci akun 10 menit dan melanjutkan request ke koneksi berikutnya, alih-alih langsung mengembalikan error ke klien.

### Prioritas Akun

- Setiap akun punya nomor prioritas per provider (#1, #2, dst.). Gateway selalu memakai akun #1 selama tersedia; akun berikutnya hanya dipakai saat akun di atasnya limit, cooldown, kuota habis, nonaktif, atau tidak melayani model yang diminta, lalu kembali ke #1 begitu pulih.
- Urutan diatur dengan tombol naik/turun di tabel akun halaman detail provider. Akun baru masuk di nomor terakhir, dan nomor dirapatkan saat akun dihapus.
- Database lama otomatis diberi nomor sesuai urutan akun dibuat.
- Pilihan Strategi Rotasi Akun (`lru`/`sticky`) dihapus dari Settings. Beban tidak lagi dibagi bergantian antar akun: kuota akun #1 terpakai lebih dulu.

### Refresh Token OAuth

- Refresh token tidak lagi berhenti diam-diam. Sebelumnya, permintaan refresh yang ternyata tidak perlu (token sudah diperbarui proses lain) meninggalkan hasil lama di cache refresh. Sejak itu setiap refresh untuk akun tersebut, termasuk refresh paksa setelah 401, mengembalikan token lama tanpa memanggil penyedia token. Satu jam kemudian akun terus menjawab 401 sampai server di-restart. Cache kini selalu dibersihkan setelah refresh selesai.
- Request ke endpoint token dibatasi 30 detik, sehingga endpoint yang tidak menjawab tidak lagi menahan penjadwal, quota sync, dan request akun yang sama.
- Refresh yang berhasil dicatat di Console Log beserta jam berlakunya token baru.

### Atribusi Akun

- Respons ketiga endpoint (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`) menyertakan header `X-Zenith-Account` pada mode streaming maupun non-streaming; log `[USAGE]` menyertakan `account="<nama>"`.
- Panel Recent Requests kini bergabung dengan `connections` (kolom `connection_name`), dan halaman Usage menambah kartu Token Consumption by Account.

### Login Dashboard Wajib

- Dashboard kini mewajibkan login sebelum terbuka lewat halaman `/dashboard/login`.
- Password awal adalah `ZENITH_INITIAL_PASSWORD` dari env atau default `123456`. Hash disimpan di database settings (`dashboard_password_hash`) memakai algoritma `scrypt` bawaan `node:crypto` tanpa dependensi tambahan.
- Sesi login disimpan dalam cookie `zenith_session` (HMAC-SHA256, HttpOnly, SameSite=Lax, 24 jam) dengan secret sesi acak di `data/session-secret` (atau env `ZENITH_SESSION_SECRET`).
- Limiter login berbasis memori: 5x kegagalan berturut-turut mengunci login bertahap (30 detik, 2m, 10m, 30m).
- Banner peringatan kuning tampil di dashboard selama password masih default `123456` untuk mengingatkan pengguna menggantinya di Settings.
- Halaman Settings menambah form ganti password (validasi password lama) dan toggle "Wajibkan Login Dashboard" (`require_login`).
- Menu CLI terminal (`bin/zenith.js`) menyediakan opsi "Reset Password Dashboard ke Default (123456)" untuk pemulihan darurat jika pengguna lupa password.
- Endpoint inferensi `/v1/*` dan status `/health` tetap memakai mekanisme Gateway API Key (`zr_...`) dan tidak terpengaruh oleh login dashboard.

### Proteksi Control Plane

- Env `ZENITH_ADMIN_TOKEN` mengaktifkan token admin untuk `/`, `/dashboard/*`, `/api/*`, dan `/callback`. Request dari container/jaringan yang menerobos loopback kini ditolak 403 tanpa token yang benar, sehingga kredensial provider tidak bisa dibaca dari endpoint dashboard atau API admin.
- Token diterima lewat header `x-zenith-admin-token`, `Authorization: Bearer`, atau cookie sesi dashboard. Perbandingan token memakai hash SHA-256 + `timingSafeEqual`.
- Navigasi browser tanpa token mendapat form login (status 403); `POST /dashboard/login` memvalidasi token lalu memasang cookie `zenith_admin_token` (HttpOnly, SameSite=Lax, 7 hari) dan kembali ke URL asal yang disaring ke path lokal. `POST /dashboard/logout` mencabut cookie.
- Key gateway `zr_...` tidak membuka control plane; hanya `ZENITH_ADMIN_TOKEN` yang berlaku di sana. Endpoint data plane `/v1/*` tetap memakai `gatewayAuth` dan tidak terpengaruh. Tanpa `ZENITH_ADMIN_TOKEN`, perilaku lama (loopback-only) tidak berubah.

### Dashboard Tanpa Reload

- Seluruh aksi dashboard (sinkron kuota, sinkron model gratis, tambah/hapus/pindah akun, combo, proxy, API key, Settings, Token Saver, import model) kini berjalan tanpa reload halaman. Submit dikirim lewat fetch, hasil redirect diikuti, lalu isi halaman diganti di tempat dengan status sementara di tombol (spinner). Scroll dan posisi halaman dipertahankan untuk aksi di halaman yang sama.
- Engine `public/zr-live.js` memakai delegation di `document` dan mengeksekusi ulang script halaman setelah swap; EventSource Live Console, polling Recent Requests/topologi, dan timer login OAuth didaftarkan ke registry cleanup sehingga ditutup sebelum elemen lama dibuang.
- Form tetap berfungsi tanpa JavaScript (handler tetap redirect). Form yang butuh navigasi asli bisa diberi atribut `data-native`. Bila sesi admin berakhir di tengah aksi, browser dialihkan otomatis ke halaman login.

### Default Fallback Model

- Model yang gagal pada seluruh akunnya dialihkan ke `default_fallback_model`, baik model tunggal maupun combo aktif.
- Percobaan per request mencegah target yang sama dipanggil dua kali, dan guard abort klien menghentikan peralihan saat klien sudah disconnect.
- Kolom `usage_history.fallback_from` mencatat model atau combo yang diminta klien, sehingga Recent Requests menampilkan asal peralihan sebagai "asal → model-penjawab".
- Dropdown di Settings menawarkan Nonaktif, combo aktif, dan model per provider berkoneksi aktif; nilai tersimpan yang sudah tidak tersedia tetap ditampilkan.

### Kuota Pool Antigravity

- Kuota 5 jam dan mingguan per kelompok model dibaca dari `retrieveUserQuotaSummary` saat sinkronisasi kuota.
- Setiap kelompok model berbagi satu limit 5 jam dan satu limit mingguan; bucket yang dinonaktifkan dilewati dan window yang tidak dikenal dibuang, bukan dipaksa ke window yang dikenal.
- Routing ke model Antigravity dihentikan selama pool kelompoknya habis, sampai waktu reset terjadwal.

### Kuota OpenRouter

- Endpoint resmi `/api/v1/key` dan `/api/v1/credits` dipakai untuk mengambil limit key, saldo akun, dan pemakaian harian serta bulanan.
- Kegagalan salah satu endpoint tidak menggagalkan yang lain, sehingga kuota tetap tampil sebagian.
- Free tier tanpa limit key tidak ditandai habis meski saldo nol; bila limit key sudah ada, status habis mengikuti limit tersebut.

### Kuota Ollama Cloud

- Saldo diambil dari `https://ollama.com/api/balance`, dengan override `ZENITH_OLLAMA_BALANCE_URL`.
- Allowance bulanan, window sesi, window mingguan, dan kredit yang dibeli ditampilkan sebagai baris terpisah, sehingga seluruh jenis kuota terlihat sekaligus.
- Kredit yang dibeli mencegah akun ditandai habis saat allowance bulanan sudah nol.

### Reasoning Content DeepSeek

- Model DeepSeek dalam thinking mode menolak request multi-turn bila pesan assistant sebelumnya tidak membawa `reasoning_content` (HTTP 400).
- Setiap giliran assistant historis kini pastikan field tersebut ada, baik pada jalur utama maupun retry pergantian protokol, sehingga klien yang membuang blok thinking tidak memicu error.

### Kuota Free Tier xKiro

- Respons 429 dengan header `x-ratelimit-scope: free` mengunci seluruh model free tier milik akun tersebut, bukan hanya model yang sedang dipanggil, sesuai durasi `Retry-After`. Berlaku untuk semua provider yang mengirim header tersebut.
- Kuota akun disinkronkan segera setelah 429, sehingga batas harian yang terpakai tercatat tanpa menunggu jadwal sinkron berikutnya.

### Login Claude OAuth

- Login memakai redirect URI resmi `https://platform.claude.com/oauth/code/callback` (dapat dioverride lewat `CLAUDE_CODE_REDIRECT_URI`), sama persis pada authorization dan token exchange.
- Scope ditambahkan `user:sessions:claude_code` dan `user:mcp_servers`, dan parameter `prompt=login` memaksa browser tidak memakai sesi Claude lama.
- Callback diarahkan ke halaman Claude, jadi login diselesaikan manual dengan menempel callback URL atau `code#state`. Parser menangani URL penuh, `code#state`, code polos, error provider, dan input tidak valid; state yang tidak cocok ditolak.
- Pengambilan profil best-effort: kegagalan tidak membatalkan login. Bila berhasil, UUID akun, email, UUID dan nama organisasi, serta tier rate limit disimpan di kredensial; yang ditampilkan di baris akun adalah email, nama organisasi, dan tier rate limit.
- Identitas klien Claude Code kini konsisten di login, bootstrap, dan runtime: User-Agent `claude-cli/... (external, cli)`, `X-App: cli`, dan `Anthropic-Dangerous-Direct-Browser-Access`.
- `x-claude-code-session-id` diteruskan dari `metadata.user_id`, yang hanya boleh sampai ke Claude. Untuk provider lain, `metadata.user_id` dibuang tanpa merusak metadata lainnya.
- Dialog login Claude di UI disesuaikan untuk alur salin dan tempel kode (bukan URL callback), dengan placeholder petunjuk kode dan pesan error yang spesifik.

### 404 Transien Upstream

- 404 upstream dengan pola Google "model not found for API version / not supported for generateContent", yang menyebut model yang tidak benar-benar dikirim, tidak lagi diteruskan apa adanya ke klien. Berlaku pada provider Cloud Code (Antigravity), satu-satunya provider yang bicara dengan layanan itu.
- Request dipindahkan ke akun lain bila tersedia; bila tidak ada, akun yang sama dicoba satu kali tanpa cooldown atau lock model.
- 404 biasa dan 404 yang menyebut model yang benar-benar diminta tetap langsung dikembalikan.

### Ketahanan Stream

- Reset koneksi di tengah stream upstream berakhir dengan frame error sesuai protokol klien (chat, Claude, Responses), bukan stack yang membanjiri terminal.
- Hang-up klien dibedakan dari reset upstream, sehingga disconnect normal tidak dicatat sebagai kegagalan.
- Error handler yang tidak tertangani dilempar ke konsol dashboard dan dibalas JSON 500 tanpa stack, sementara `HTTPException` diteruskan apa adanya.

### Pengujian

- Seluruh test lulus (805 test), mencakup parsing katalog, resolusi URL per lane, retry identitas, cooldown lokal, penolakan model pensiun, ketahanan transport, failover kuota/auth, refresh token OAuth, prioritas akun, proteksi token admin control plane, dashboard tanpa reload, autentikasi login dashboard, pool kuota Antigravity, kuota OpenRouter, kuota Ollama Cloud, reasoning content DeepSeek, login Claude dan dialog kode, 404 transien, dan ketahanan stream.

## [0.1.6] - 17-10-2026

Model Antigravity dikelompokkan per keluarga, effort mengikuti permintaan klien, dan kuota ditampilkan per langganan akun.

### Model & Effort Antigravity

- Model Antigravity disusun per keluarga, misalnya Gemini 4 Argon, Gemini 3.8 Flash, dan Claude Opus 5.5, sehingga daftar model tidak lagi dipecah per tingkat.
- Tingkat effort dibaca dari `reasoning_effort` (OpenAI), `reasoning.effort` (Responses), atau `thinking.budget_tokens` (Claude). Tanpa penanda apa pun, tingkat default adalah medium.
- Bila akun tidak memiliki varian untuk tingkat yang diminta, tingkat diturunkan ke varian yang tersedia pada akun tersebut.
- Id model lama yang berada di luar katalog tetap diteruskan apa adanya, sehingga klien yang sudah mengunci id lama tidak langsung rusak.

### Kuota & Routing Akun

- Model yang tersedia untuk tiap akun ikut disinkronkan saat kuota diperbarui, dan `/v1/models` menggabungkan katalog dengan model milik akun aktif.
- Akun dilewati bila tidak memiliki model yang diminta, atau bila kuotanya habis dan waktu reset belum tiba.
- Menghapus koneksi juga menghapus data model dan lock model milik koneksi tersebut.
- Dashboard menampilkan satu baris kuota per keluarga model dengan penanda kuota habis.

### Identitas Klien

- Identitas klien Antigravity diperbarui sehingga model terbaru ikut tersedia pada akun berlangganan.

### Pengujian

- Seluruh test lulus (630 test), mencakup pengelompokan model, pemetaan effort, routing kuota, kartu kuota, dan pembersihan data saat koneksi dihapus.

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

### Proxy Pool & Rotasi

- Halaman mandiri **Proxy Pools** di sidebar (`/dashboard/proxies`) dengan antarmuka divide-y: tombol header Batch Import dan Add Proxy Pool dialog modal, status ringkasan (Total dan Active), daftar baris dengan badge dot status tes (`ok`/`error`/`unknown`), status aktif, dan jumlah akun terikat (`X bound`), serta aksi cepat (toggle aktif/nonaktif, tes kesehatan 8 detik, modal ubah aman, dan hapus terlindungi).
- Pengikatan proxy akun provider: akun dapat dihubungkan ke proxy dari daftar pool, alamat manual, atau koneksi langsung; seluruh lalu lintas akun (chat, kuota, token refresh, import model) mengikuti binding tersebut dan gagal tertutup (fail-closed) tanpa membocorkan request ke koneksi langsung saat proxy bermasalah.
- Impor massal daftar proxy menerima format URL lengkap `http://...`, `host:port`, dan `host:port:user:pass`.
- Rotasi proxy untuk provider tanpa akun (noAuth): pilihan strategi tidak aktif, bergiliran (round-robin), atau acak, dengan retry otomatis hingga 3 percobaan per request.
- Transport proxy kustom `proxyFetch` dengan dukungan `Proxy-Authorization` untuk tunnel CONNECT HTTPS dan forward HTTP, pembatalan request terikat waktu, dan penyaringan password dari pesan error.

### Protokol OpenCode & Kompatibilitas Tool

- Mengatasi penolakan 403 FreeTierError dari OpenCode Zen dengan menerapkan pembentukan ID sesi (`ses_`) ber-prefix 48-bit inversi bitwise timestamp dan ID request (`msg_`) dengan timestamp menaik, serta User-Agent resmi `opencode/1.19.0`.
- Cache sesi stabil berbasis percakapan klien di memori proses (TTL 30 menit, kapasitas 1000 entri LRU) agar giliran percakapan multi-turn tidak memicu sesi baru atau kebocoran kuota.
- Pemaksaan streaming upstream (`forceStream: true`) untuk seluruh model gratis OpenCode dengan agregasi transparan bagi klien non-streaming.
- Pengerasan endpoint Responses API: sanitasi nama tool `[a-zA-Z0-9_-]` dengan pemulihan nama asli di respons, pemasangan otomatis output sintetis `{}` untuk function call yatim (dan pembuangan output yatim), pembatasan `max_output_tokens` di rentang 16–65536, serta pembersihan field tersebut pada backend Codex.
- Normalisasi halusinasi parameter tool bawaan Claude Code (Bash, Read, Edit, Write, MultiEdit, Glob, Grep) dari model non-Anthropic saat melayani klien `/v1/messages`, mempertahankan filter `glob` pada Grep.

### Proyek & Keamanan

- Total 464 test (45 test baru) 100% hijau, mutasi terverifikasi.
- Pencegahan stored XSS pada tombol Edit dashboard Proxy Pools dengan encoding JSON + atribut HTML ganda.
- Kredit konsep antarmuka Proxy Pools kepada proyek referensi upstream (lihat [NOTICE](NOTICE)).

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
- Konsep rantai combo dan dialog pemilih model mengacu pada proyek referensi upstream (lihat [NOTICE](NOTICE)).

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
