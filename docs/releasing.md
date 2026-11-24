# Checklist Release Zenith Router

Dokumen ini menyiapkan release; mengikuti checklist tidak otomatis mengubah versi,
membuat tag, push, atau menerbitkan GitHub Release.

## 1. Tentukan cakupan dan versi

- Tentukan versi SemVer dari perubahan yang benar-benar akan disertakan. Jangan
  menebak nomor release hanya dari bagian `Unreleased`.
- Audit commit sejak tag terakhir dan cocokkan ringkasannya dengan
  `CHANGELOG.md`. Cantumkan perubahan yang terlihat oleh pengguna; pindahkan
  item yang tidak ikut release atau belum terverifikasi.
- Untuk perubahan hybrid egress, jelaskan bahwa fitur bersifat opt-in. Bedakan
  hasil pengujian executor/fixture dari trafik inference nyata. Jangan menyebut
  `enforce` tervalidasi end-to-end bila gate itu belum dijalankan.
- Integrasi WARP mengandalkan service companion yang menyediakan `/status` dan
  `/signal/429`. Rilis companion `warp-proxy-pool` dikelola terpisah; catat versi
  minimum/kompatibilitas hanya setelah diuji.

## 2. Sinkronkan metadata dan dokumentasi

Saat versi disetujui:

1. Perbarui `version` di `package.json` dan `package-lock.json`.
2. Pindahkan isi yang akan dirilis dari `## [Unreleased]` ke heading versi dan
   tanggal, dengan format yang konsisten dengan bagian sebelumnya.
3. Perbarui badge versi pada `README.md` agar sama dengan metadata paket.
4. Pastikan link dokumentasi egress dan checklist ini valid; jangan menyertakan
   konfigurasi homelab, alamat IP runtime, kredensial, atau data database.

## 3. Jalankan gate lokal

Dari working tree yang bersih selain file lokal yang memang dikecualikan:

```sh
npm ci
npm test
npm pack --dry-run
```

Periksa juga perubahan dokumentasi, `git diff --check`, package contents, dan
bahwa `package.json`, `package-lock.json`, README badge, serta heading changelog
menunjuk versi yang sama. Ulangi tes dengan versi Node.js yang tercantum pada
`package.json` bila CI memakai lebih dari satu runtime.

## 4. Tag dan GitHub Release

- Buat commit release setelah review perubahan metadata dan changelog.
- Buat annotated tag `vX.Y.Z` pada commit release yang telah diverifikasi.
- Publish GitHub Release dengan ringkasan dari changelog; jangan mengklaim
  verifikasi yang belum dilakukan.
- Workflow `.github/workflows/release-manifest.yml` berjalan saat GitHub Release
  dipublikasikan dan mengunggah `release-manifest.json` berisi nama tag dan hash
  commit release. Pastikan artefak itu tersedia setelah workflow selesai.

## 5. Verifikasi pasca-release

- Pastikan tag menunjuk ke commit release yang dimaksud dan status GitHub Release
  sesuai.
- Periksa bahwa `release-manifest.json` mencatat tag serta hash commit yang sama.
- Jika menguji fitur egress, mulai dari `off`/`shadow`; jangan mengaktifkan
  `enforce` pada instalasi pengguna sebagai bagian dari release otomatis.
