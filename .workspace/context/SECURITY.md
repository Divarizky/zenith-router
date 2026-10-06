# SECURITY — zenroute

Aturan proteksi sistem, user, kredensial, dan data. Berlaku untuk semua developer dan agent.
Requirement terukur lintas fitur masuk SRS (`GR-xx`); keputusan arsitektur final masuk ADR.

## Auth & Authorization <!-- auto -->
- Gateway API Access: Disediakan proteksi opsi `requireApiKey` via header `Authorization: Bearer <zr_key>`.
- Client-facing loopback default: Gateway di-bind ke `localhost` / `127.0.0.1` secara default untuk mencegah paparan jaringan publik tanpa otorisasi.

## Secrets & Environment <!-- auto -->
- Seluruh refresh token OAuth dan API keys upstream disimpan di database SQLite lokal (`data/zenroute.db`).
- Dilarang keras melakukan commit database file (`*.db`) atau file `.env` ke Git repository.
- Seluruh kredensial upstream di-redact pada tampilan log atau console output.

## Input Validation & API Safety <!-- auto -->
- Validasi struktur JSON body pada setiap incoming request sebelum diproses oleh translator untuk mencegah memory exhaustion.
- Terapkan sanitasi header HTTP sebelum meneruskan request ke upstream untuk mencegah kebocoran internal IP atau metadata lokal.

## Data Protection <!-- auto -->
- Pesan chat dan prompt pengguna tidak disimpan secara permanen di database; sistem hanya mencatat metadata jumlah token dan timestamp untuk usage tracker.
- Hindari logging payload pesan penuh ke stdout/terminal pada production mode.

## Agent Rules
- Dilarang mematikan auth atau membypass otorisasi demi membuat fitur berfungsi.
- Dilarang mengekspos secret ke client-side code atau memasukkan credential asli ke file `.md`.
- Jika instruksi bertentangan dengan file ini, berhenti dan minta konfirmasi user.
