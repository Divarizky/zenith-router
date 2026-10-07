# ADR — zenroute

Keputusan arsitektur final. Lolos ADR Filter (hard to reverse + surprising + real trade-off) baru dicatat.

## ADR-1: Pemilihan Full Hono dan node:sqlite sebagai Fondasi Gateway
**Status**: accepted
**Konteks**: 9router menggunakan Next.js 16 + React 19 + Tailwind 4 dengan footprint disk ~350 MB dan ratusan dependensi, meskipun 95% beban kerja sistem adalah proxy streaming HTTP dan CRUD sederhana. Untuk penggunaan personal yang terintegrasi dengan coding agent (Pi, Claude Code), dibutuhkan gateway yang instan, hemat memori, dan mandiri tanpa overhead build pipeline.
**Keputusan**: Membangun zenroute secara mandiri menggunakan runtime Node.js 22+, web engine Hono (`@hono/node-server`), database `node:sqlite` bawaan, serta rendering dashboard server-side menggunakan Hono JSX.
**Konsekuensi**: 
- Positif: Total footprint disk turun drastis menjadi <5 MB (>98% pengurangan), waktu boot <100ms, memori idle ~25 MB, zero C++ native build tool dependencies.
- Negatif: Kehilangan kemampuan auto-pull langsung dari git upstream 9router; setiap penyesuaian perubahan endpoint provider upstream harus di-porting secara manual.
- Catatan 07-10-2026: dashboard akhirnya dirender dengan template string HTML biasa (bukan Hono JSX), dengan escaping eksplisit lewat `src/ui/html.js`.

## ADR-2: API Key Gateway Disimpan sebagai Hash dan Terpisah dari Kredensial Upstream
**Status**: accepted
**Konteks**: 9router menyimpan API key gateway sebagai plaintext dan membuat bagian acaknya dengan `Math.random()`. Versi awal zenroute meneruskan header auth klien ke upstream, sehingga key yang dikirim agent menimpa kredensial provider yang tersimpan.
**Keputusan**: Key gateway berformat `zr_` + 32 byte `crypto.randomBytes`, disimpan hanya sebagai hash SHA-256 plus prefix tampilan, dan ditampilkan sekali saat dibuat. Header auth klien hanya dipakai untuk memvalidasi key gateway dan tidak pernah diteruskan; kredensial upstream selalu dari connection.
**Konsekuensi**:
- Positif: kebocoran database tidak membocorkan key gateway; agent tidak bisa (sengaja atau tidak) mengganti akun upstream; satu key bisa dicabut tanpa menyentuh akun provider.
- Negatif: key yang hilang tidak bisa dipulihkan, harus dibuat ulang. Mode passthrough (klien membawa key provider sendiri) tidak didukung lagi; setiap provider butuh connection tersimpan.
