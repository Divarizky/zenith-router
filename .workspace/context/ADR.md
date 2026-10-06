# ADR — zenroute

Keputusan arsitektur final. Lolos ADR Filter (hard to reverse + surprising + real trade-off) baru dicatat.

## ADR-1: Pemilihan Full Hono dan node:sqlite sebagai Fondasi Gateway
**Status**: accepted
**Konteks**: 9router menggunakan Next.js 16 + React 19 + Tailwind 4 dengan footprint disk ~350 MB dan ratusan dependensi, meskipun 95% beban kerja sistem adalah proxy streaming HTTP dan CRUD sederhana. Untuk penggunaan personal yang terintegrasi dengan coding agent (Pi, Claude Code), dibutuhkan gateway yang instan, hemat memori, dan mandiri tanpa overhead build pipeline.
**Keputusan**: Membangun zenroute secara mandiri menggunakan runtime Node.js 22+, web engine Hono (`@hono/node-server`), database `node:sqlite` bawaan, serta rendering dashboard server-side menggunakan Hono JSX.
**Konsekuensi**: 
- Positif: Total footprint disk turun drastis menjadi <5 MB (>98% pengurangan), waktu boot <100ms, memori idle ~25 MB, zero C++ native build tool dependencies.
- Negatif: Kehilangan kemampuan auto-pull langsung dari git upstream 9router; setiap penyesuaian perubahan endpoint provider upstream harus di-porting secara manual.
