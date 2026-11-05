# pi-zenith-router

Extension Pi untuk gateway lokal [zenith-router](../../README.md). Extension ini mendaftarkan provider `zenith-router` dan menerbitkan data kuota untuk extension `usage-tracker`.

Provider `zenith` yang sudah ada di `provider-gateway` tidak diubah dan tetap berjalan berdampingan.

## Pemasangan

```bash
pi install /path/ke/zenith-router/extensions/pi
```

## Fitur

- Mendaftarkan provider `zenith-router` dengan API `openai-completions`. Base URL-nya `http://127.0.0.1:20120/v1`, atau `${ZENITH_URL}/v1` bila env `ZENITH_URL` diset.
- Daftar model diambil dari `GET /v1/models`. Bila gateway tidak menjawab, dipakai cache di `~/.pi/agent/cache/zenith-router-models.json`, lalu daftar fallback kecil.
- API key dibaca Pi lewat mekanisme auth-nya. Extension ini tidak membaca `auth.json` atau `.env`, dan tidak menampilkan nilai key.
- Saat refresh model, memakai `refreshModels` dengan jeda minimal lima menit. Permintaan yang berjalan bersamaan berbagi satu fetch.
- Menerbitkan hasil `GET /api/quota` lewat `pi.events` pada channel `zenith-router:quota`, dengan payload `{ connections, fetchedAt }`.
- Command `/zenith-router` menampilkan status gateway, jumlah model dan sumbernya, serta ringkasan kuota.

## Kontrak kuota

`/api/quota` hanya dibaca dari origin loopback, karena endpoint itu control-plane dan tidak memakai API key gateway. Bila `ZENITH_URL` mengarah ke alamat non-loopback, kuota tidak diambil.

Payload yang diterbitkan berbentuk array koneksi apa adanya, sama dengan `/api/quota`. Ini sesuai dengan yang dibaca `usage-tracker/src/zenith.ts`.

## Pengujian

```bash
npm install
npm test
npm run typecheck
```

## Batasan

- Belum diuji hidup di dalam sesi Pi yang berjalan. Pengujian di repo ini memakai server HTTP lokal dan fake `ExtensionAPI`.
- Gateway Zenith Router mempublikasikan `capabilities` (`vision`, `reasoning`, `tools`), `context_length`, dan `max_completion_tokens` pada `/v1/models`. Jika suatu model kustom tidak memiliki metadata, extension akan menerapkan fallback konservatif.
