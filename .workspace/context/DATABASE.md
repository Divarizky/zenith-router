# DATABASE — zenroute

Struktur data, relasi, dan aturan perubahan skema yang aman.
Model yang masih kandidat disimpan di work card `F-<id>.md`; model approved dicatat di sini.

## Stack & Connection <!-- auto -->
- Database & Provider: SQLite lokal menggunakan native `node:sqlite` (`DatabaseSync` bawaan Node.js 22+) — Source: `src/db/index.js`
- Lokasi File DB: `<root project>/data/zenroute.db`, tidak bergantung CWD; bisa diganti lewat env `ZENROUTE_DB_PATH`. Run `node --test` otomatis memakai `:memory:`.
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
- Deskripsi: Konfigurasi sistem global (key-value).
- Fields: `key` (TEXT PRIMARY KEY), `value` (TEXT), `updated_at` (INTEGER).
- Keys: `require_api_key`, `token_saver_rtk`, `token_saver_caveman`, `default_fallback_model` (belum dipakai gateway).

### api_keys
- Deskripsi: API key gateway zenroute. Plaintext tidak pernah disimpan.
- Fields: `id` (INTEGER PRIMARY KEY), `name` (TEXT), `key_prefix` (TEXT, 10 karakter pertama untuk tampilan), `key_hash` (TEXT UNIQUE, SHA-256 hex), `is_active` (INTEGER), `created_at` (INTEGER), `last_used_at` (INTEGER).
- Constraints & Index: index unik pada `key_hash` untuk lookup verifikasi.

## Migrations & Schema Changes <!-- auto -->
- Skema diinisialisasi melalui DDL script di `src/db/schema.sql`.
- Perubahan skema masa depan ditambahkan secara idempotent (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` terproteksi).

## Seed Data <!-- auto -->
- Tidak ada seed. Nilai default settings ada di kode (`src/services/settings.js`): `require_api_key=false`, `token_saver_rtk=true`, `token_saver_caveman=false`, `default_fallback_model=glm/glm-4-flash`.
