# DATABASE — zenroute

Struktur data, relasi, dan aturan perubahan skema yang aman.
Model yang masih kandidat disimpan di work card `F-<id>.md`; model approved dicatat di sini.

## Stack & Connection <!-- auto -->
- Database & Provider: SQLite lokal menggunakan native `node:sqlite` (`DatabaseSync` bawaan Node.js 22+) — Source: `src/db/index.js`
- Lokasi File DB: `data/zenroute.db` (dibuat otomatis saat inisialisasi)
- Mode Akses: WAL (Write-Ahead Logging) diaktifkan untuk konkurensi pembacaan tinggi.

## Core Models <!-- auto -->
### connections
- Deskripsi: Menyimpan kredensial akun provider (API key, OAuth access/refresh token, status lock, proxy URL).
- Fields: `id` (INTEGER PRIMARY KEY), `provider` (TEXT), `name` (TEXT), `auth_type` (TEXT), `credentials` (TEXT JSON), `proxy_url` (TEXT), `is_active` (INTEGER), `last_used_at` (INTEGER), `cooldown_until` (INTEGER), `created_at` (INTEGER).
- Constraints & Index: Index pada `(provider, is_active)`.

### combos
- Deskripsi: Definisi grup model gabungan beserta strategi failover.
- Fields: `id` (INTEGER PRIMARY KEY), `name` (TEXT UNIQUE), `strategy` (TEXT), `models` (TEXT JSON), `created_at` (INTEGER).

### usage_history
- Deskripsi: Catatan agregat token dan pemanggilan model untuk tracking biaya/kuota.
- Fields: `id` (INTEGER PRIMARY KEY), `connection_id` (INTEGER), `model` (TEXT), `input_tokens` (INTEGER), `output_tokens` (INTEGER), `total_tokens` (INTEGER), `duration_ms` (INTEGER), `timestamp` (INTEGER).
- Constraints & Index: Index pada `(connection_id, timestamp)`.

### settings
- Deskripsi: Konfigurasi sistem global (single-row key-value).
- Fields: `key` (TEXT PRIMARY KEY), `value` (TEXT), `updated_at` (INTEGER).

## Migrations & Schema Changes <!-- auto -->
- Skema diinisialisasi melalui DDL script di `src/db/schema.sql`.
- Perubahan skema masa depan ditambahkan secara idempotent (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` terproteksi).

## Seed Data <!-- auto -->
- Inisialisasi otomatis memasukkan pengaturan default ke tabel `settings` (misal `requireApiKey = false`, `defaultFallbackStrategy = "fallback"`).
