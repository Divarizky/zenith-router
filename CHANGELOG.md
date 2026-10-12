# Changelog

Semua perubahan penting Zenith Router dicatat di sini. Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/), versi memakai [Semantic Versioning](https://semver.org/lang/id/).

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
