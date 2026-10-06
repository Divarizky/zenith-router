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
| F-01 | Base Gateway & Core Translator | approved | 2026-10-06 |
| F-02 | Provider Connections & OAuth | draft | 2026-10-06 |
| F-03 | Usage Tracking & Quota Sync | draft | 2026-10-06 |
| F-04 | Token Saver Engine | draft | 2026-10-06 |
| F-05 | Minimal Dashboard UI | draft | 2026-10-06 |

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
