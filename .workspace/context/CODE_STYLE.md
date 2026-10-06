# CODE_STYLE — zenroute

Konvensi kode agar hasil generate terbaca, konsisten, dan mudah dipelihara.
Ikuti pola existing; jangan memaksa gaya baru jika codebase sudah punya konvensi.

## Stack & Tools <!-- auto -->
- Bahasa & Framework: JavaScript (Node.js 22+, ECMAScript Modules `type: module`), Hono — Source: `package.json`
- Database: `node:sqlite` (DatabaseSync) tanpa ORM eksternal — Source: `README.md`
- Code Formatter: Standard 2-space indentation, semicolons, double quotes untuk strings.

## Naming & Structure <!-- auto -->
- File: camelCase (`tokenSaver.js`, `backgroundRefresh.js`). File route gateway memakai nama singular/plural sesuai standar API (`chat.js`, `models.js`).
- Fungsi & Variabel: camelCase (`getProviderCredentials`, `translateRequest`).
- Konstanta Global & Enums: UPPER_SNAKE_CASE (`DEFAULT_PORT`, `FORMATS`, `HTTP_TIMEOUT_MS`).
- Classes: PascalCase (`BaseExecutor`, `DefaultExecutor`).
- Boolean: Prefiks deklaratif (`isEnabled`, `isStreaming`, `hasExpired`).

## Comments & Cleanliness <!-- auto -->
- Gunakan komentar hanya untuk menjelaskan WHY (misalnya alasan penanganan anomali upstream status code atau aturan ToS).
- Hindari dead imports dan console logging sampah pada alur streaming utama.

## Verification Checklist <!-- auto -->
- Verifikasi syntax dan runtime dengan `node --check <file>` atau jalankan server test sebelum commit.
- Pastikan perubahan tidak menambahkan dependensi pihak ketiga baru ke `package.json` kecuali disetujui eksplisit.
