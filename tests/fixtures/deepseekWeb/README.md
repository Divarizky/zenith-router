# Fixture DeepSeek Web

Folder ini menyimpan bahan uji untuk transport `deepseek-web`. Isinya dibagi dua:

- **Vektor PoW** (`pow-challenge.json`) — contoh dari README `@rezaparsian/deepseek-pow-solver`, bukan tangkapan API. Jawabannya (`32186`) sudah dicocokkan dengan paket Python `deepseek-pow`, jadi bisa dipakai sebagai vektor uji lintas implementasi.
- **Tangkapan asli** — hanya boleh dibuat dengan akun sendiri lewat `scripts/captureDeepSeekWebFixtures.js`, dan hasil mentahnya disimpan di `private/` yang diabaikan git.

## Mengapa perlu tangkapan asli

Parser dan streaming bergantung pada bentuk data yang sebenarnya: nama endpoint, struktur `data.biz_data.challenge`, fragmen SSE (`RESPONSE` dan `THINKING`), dan bentuk `history_messages`. Menebak bentuk itu menghasilkan parser yang lulus tes sendiri tetapi gagal di upstream. Karena itu implementasi transport (TASK-76/79/80/81) menunggu setidaknya satu tangkapan asli.

## Cara mengambil

```bash
# 1) Simpan token + cookie dari browser yang sudah login ke chat.deepseek.com
#    ke file JSON: { "token": "...", "cookies": "a=1; b=2" }
CHATBRAIN_SESSION=./.websession.json node scripts/captureDeepSeekWebFixtures.js --prompt "halo"

# Atau lewat env, tanpa file:
DEEPSEEK_TOKEN=... DEEPSEEK_COOKIES='a=1; b=2' node scripts/captureDeepSeekWebFixtures.js

# Cek rencana request tanpa menyentuh jaringan:
node scripts/captureDeepSeekWebFixtures.js --dry-run
```

Skrip menulis:

| File | Isi |
|---|---|
| `challenge.json` | respons `create_pow_challenge` + `durationMs` solve |
| `completion.sse.txt` | respons SSE mentah `chat/completion` |
| `history.json` | `history_messages` untuk sesi yang baru dibuat |
| `metadata.json` | waktu, status HTTP, model, catatan sanitasi |

## Aturan sanitasi

- Token dan cookie tidak pernah ditulis ke fixture; nilai sensitif diganti `"<redacted>"`.
- Jangan memakai prompt yang memuat data pribadi, kredensial, atau isi repositori privat: keluaran model ikut tersimpan.
- File di `private/` tidak di-commit. Fixture yang layak dibagikan boleh dipindahkan ke folder ini setelah ditinjau manual.

## Status

`pow-challenge.json` sudah dipakai `tests/deepseekWebPow.test.js`. Waktu solve tercatat lewat `node scripts/benchDeepSeekPow.js`: difficulty 144000 memberi p50 ~19 ms dan p95 ~22 ms di mesin pengembangan.

Tangkapan asli pertama (23-10-2026, mode thinking, prompt "Sebutkan tiga nama buah dalam satu kalimat pendek.") sudah ditinjau dan dipindah ke folder ini:

| File | Isi |
|---|---|
| `completion-thinking.sse.txt` | stream `chat/completion` mentah: `event: ready`, snapshot `{"v":{"response":...}}`, patch `{"p","o","v"}`, frame tanpa path `{"v":"..."}`, `BATCH`, `title`, `close` |
| `history-thinking.json` | `history_messages` sesi yang sama; id sesi diganti `sess-fixture` |

Sesi upstream-nya sudah dihapus. Keduanya dipakai `tests/deepseekWebTransport.test.js`: teks hasil parser stream harus sama persis dengan fragmen `THINK`/`RESPONSE` di history.
