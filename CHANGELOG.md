# Changelog

Semua perubahan penting Zenith Router dicatat di sini. Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/), versi memakai [Semantic Versioning](https://semver.org/lang/id/).

## [0.1.0] - 10-10-2026

Rilis pertama.

### Gateway dan routing

- Endpoint `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/responses`, dan `GET /v1/models`, lengkap dengan streaming SSE dan non-streaming.
- Translasi dua arah OpenAI ↔ Claude termasuk tool calling, OpenAI Responses untuk backend Codex, Google Cloud Code/Gemini `v1internal`, dan AWS EventStream binary untuk Kiro.
- Prefix model mengarah ke provider (`glm/…`, `cc/…`, `cx/…`, atau id provider apa pun).
- Failover ke akun berikutnya saat 429/5xx, cooldown 60 detik untuk akun bermasalah, refresh token otomatis, dan satu kali coba ulang setelah 401/403.
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

[0.1.0]: https://github.com/Divarizky/zenith-router/releases/tag/v0.1.0
