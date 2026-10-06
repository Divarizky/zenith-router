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

## Feature Registry
| ID | Feature | Status | Updated |
|---|---|---|---|
| F-01 | Base Gateway & Core Translator | draft | 2026-10-06 |
| F-02 | Provider Connections & OAuth | draft | 2026-10-06 |
| F-03 | Usage Tracking & Quota Sync | draft | 2026-10-06 |
| F-04 | Token Saver Engine | draft | 2026-10-06 |
| F-05 | Minimal Dashboard UI | draft | 2026-10-06 |

## Feature Requirements
<!-- Requirement approved per feature. ID REQ-xx scoped di dalam F-xx. -->
<!-- kosong sampai feature requirement disetujui -->
