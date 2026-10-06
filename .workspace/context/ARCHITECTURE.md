# Architecture — zenroute

## Overview
zenroute mengadopsi arsitektur layered micro-gateway berorientasi pipeline. Permintaan HTTP dari klien coding agent masuk melalui Hono routing layer, divalidasi dan dinormalisasi formatnya oleh translator, dialirkan melalui engine token saver, dan dieksekusi oleh executor yang terikat pada connection akun upstream terpilih.

## Module Map <!-- auto -->
- `src/gateway/` — Entrypoint API handler untuk protokol OpenAI, Anthropic, dan Responses.
- `src/translator/` — Hub-and-Spoke payload converter (format client ↔ format provider).
- `src/services/auth.js` — Resolver kredensial, selector akun, dan state machine cooldown.
- `src/services/combo.js` — Logika urutan fallback dan load balancing lintas model/provider.
- `src/services/tokenSaver.js` — Pipeline kompresi token in-memory (RTK & Caveman).
- `src/services/usage.js` — Pencatat metrik pemakaian token dan sinkronisasi kuota.
- `src/executors/` — Layer eksekusi transport jaringan (HTTP fetch, proxy routing, SSE parsing).
- `src/providers/` — Definisi registry statis dan alur OAuth untuk masing-masing provider.
- `src/db/` — Akses persistensi lokal berbasis `node:sqlite`.
- `src/ui/` — Server-side dashboard renderer berbasis Hono JSX.

## Dependency Direction <!-- auto -->
- `gateway` → `translator` + `services` + `executors`: Gateway mengorkestrasi pipeline tanpa mengetahui detail protokol transport provider.
- `executors` → `providers`: Executor mengambil spesifikasi endpoint, header, dan auth type dari provider registry.
- `services` → `db`: Layanan auth, combo, dan usage bergantung pada data persistensi SQLite untuk membaca state dan menulis histori.
- `ui` → `services` + `db`: Dashboard UI membaca status langsung dari DB dan memicu aksi melalui service layer.
