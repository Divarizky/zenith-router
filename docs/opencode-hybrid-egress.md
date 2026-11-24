# OpenCode hybrid egress WARP/Proton

Fitur ini opt-in dan hanya memengaruhi provider `opencode`. Mode lama (`off`, atau
policy `direct`/`prefer`/`require` tanpa registry hybrid) tetap dipertahankan.
Tidak ada migrasi SQLite; konfigurasi disimpan sebagai settings JSON.

## Setting

```text
opencode_egress_mode       = off | shadow | enforce
opencode_egress_registry   = {"2":{"adapter":"warp","lane":1},"12":{"adapter":"proton","lane":"proton"}}
opencode_proxy_pool_ids    = [2,12]
opencode_proton_probe_url  = https://example.invalid/my-ip
```

`opencode_egress_registry` memetakan pool ID secara eksplisit. Runtime tidak
menebak adapter dari nama, port, atau posisi pool. Adapter WARP memakai lane
`1..10`; adapter Proton memakai label lane non-kosong.

Validasi scope bergantung pada mode:

- Dalam `enforce`, setiap pool dalam scope harus terdaftar, dan setiap mapping
  registry harus berada dalam scope. Ketidaksesuaian membuat konfigurasi invalid.
- Dalam `shadow`, registry boleh memuat Proton di luar scope OpenCode-WARP agar
  readiness dapat diamati tanpa menambahkan Proton ke routing produksi. Probe
  memakai registry yang valid, termasuk entry di luar scope.

`enforce` menolak konfigurasi invalid dengan `503 proxy_required`; konfigurasi
invalid tidak diam-diam jatuh ke mode legacy. URL probe Proton wajib HTTPS,
tanpa kredensial. Probe tidak mengirim kredensial OpenCode.

## Shadow dan readiness

`shadow` hanya menjalankan observasi; request tetap memakai planner routing lama.
Pool Proton yang terdaftar dikecualikan dari planner lama agar tidak bocor ke
round-robin biasa, baik pool itu berada di dalam maupun di luar scope. Readiness
Proton tetap dapat diprobe dari registry tanpa mengubah egress request.

Probe melewati proxy pool yang sama, timeout 5 detik, tanpa redirect, response
body maksimal 4 KiB, dan harus berisi IPv4/IPv6 yang valid. Readiness Proton hanya
disimpan di memori. Snapshot terikat pada URL pool, adapter, dan URL probe;
perubahan konfigurasi membuat snapshot stale. TTL readiness adalah 180 detik
berdasarkan waktu observasi, bukan waktu refresh scheduler. Scheduler dijalankan
saat startup dan kira-kira setiap 60 detik dengan single-flight.

Readiness hanya menunjukkan bahwa probe berhasil melalui jalur tersebut. Ini
tidak membuktikan kill switch VPN atau menjamin semua trafik host memakai VPN.
Lakukan staging gate terpisah: hentikan interface/route Proton dan pastikan
probe gagal serta mode `enforce` tidak mengirim request direct.

## Routing enforce

Pool WARP yang ready diprioritaskan dengan round-robin lane. Bila Proton ready,
rencana request berisi paling banyak dua WARP lalu satu Proton; tanpa Proton
maksimal tiga WARP. Pool cooling down, stale, unknown, draining, nonaktif, atau
invalid dikeluarkan. Bila tidak ada lane eligible, gateway mengembalikan
`503 proxy_required` tanpa dispatch direct.

Proton hanya menjadi backup setelah transport failure WARP yang aman, atau menjadi
lane pertama bila sejak awal tidak ada WARP eligible. Jika seluruh lane WARP tidak
eligible—termasuk karena cooldown exhausted setelah `429`—Proton menjadi satu-satunya
kandidat availability. Respons upstream seperti `429`, `Retry-After`, penolakan auth,
dan penolakan model tidak boleh dipakai untuk melompati aturan itu dalam request yang
sama; guard `hybridProtonBlocked` tetap memotong Proton setelah respons WARP
non-transport. Dispatch tetap dibatasi oleh budget/deadline request dan abort klien.

## Aktivasi, metrik, dan rollback

1. Buat pool dan uji koneksi satu per satu di dashboard.
2. Tulis registry dan scope pada database staging.
3. Set mode `shadow`; amati log `[EGRESS]`, readiness, status probe, latency,
   error proxy, dan jumlah dispatch per request.
4. Jalankan staging gate kill switch Proton di atas.
5. Ubah mode ke `enforce` hanya setelah readiness dan routing fail-closed lulus.

Rollback aman: ubah mode ke `off`, lalu gunakan policy `require` dengan scope
WARP-only yang sudah ada. Untuk rollout produksi, validasi konfigurasi dan
readiness di lingkungan target, jalankan gate kill-switch Proton, dan pastikan
jalur fail-closed sebelum mengaktifkan `enforce`. Perubahan database tetap
menggunakan settings key-value; tidak ada migrasi schema SQLite.
