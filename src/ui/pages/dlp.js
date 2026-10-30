import { getAllSettings, setSetting } from "../../services/settings.js";
import { renderLayout } from "../layout.js";
import { dlpModeFrom } from "../../services/dlp.js";

export function renderDlpPage(port = 20120, query = {}) {
  const settings = getAllSettings();
  const currentMode = dlpModeFrom(settings);
  const isSaved = query.saved === "1" || query.saved === "true";

  const content = `
    ${
      isSaved
        ? `<div class="notice notice-ok"><span>Pengaturan DLP berhasil disimpan.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : ""
    }
    <div class="card">
      <h3>Data Loss Prevention (DLP)</h3>
      <p class="hint" style="margin-bottom: 1.25rem;">Pindai isi request keluar ke provider eksternal untuk mendeteksi rahasia seperti kunci API, token, private key, dan penugasan kredensial.</p>

      <div class="notice notice-warning" style="margin-bottom: 1.5rem;">
        <span><strong>Perhatian:</strong> Pemindaian DLP menggunakan pencocokan pola regex dan heuristik kredensial. Teks biasa atau kode sumber yang menyerupai format kunci atau penugasan variabel dapat memicu deteksi (false positive).</span>
      </div>

      <form action="/dashboard/dlp" method="POST">
        <div class="setting-row">
          <div class="setting-info">
            <strong>Mode DLP</strong>
            <p class="hint">Pilih bagaimana gateway menangani rahasia yang terdeteksi pada request keluar.</p>
          </div>
          <div class="setting-action">
            <select name="dlp_mode" class="input-select" style="min-width: 200px;">
              <option value="off" ${currentMode === "off" ? "selected" : ""}>Nonaktif (Off)</option>
              <option value="redact" ${currentMode === "redact" ? "selected" : ""}>Redaksi (Redact)</option>
              <option value="block" ${currentMode === "block" ? "selected" : ""}>Blokir (Block)</option>
            </select>
          </div>
        </div>

        <div style="margin-top: 1rem; padding: 1rem; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px;">
          <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem;">Penjelasan Mode:</h4>
          <ul style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--text-muted); line-height: 1.6;">
            <li><strong>Nonaktif (Off):</strong> Default. Tidak ada pemindaian payload, request diteruskan langsung tanpa perubahan atau overhead.</li>
            <li><strong>Redaksi (Redact):</strong> Rahasia yang terdeteksi disensor menjadi <code>[REDACTED:&lt;tipe&gt;]</code> sebelum diteruskan ke provider. Jika sensor gagal atau tidak tuntas, request otomatis ditolak (fail-closed).</li>
            <li><strong>Blokir (Block):</strong> Jika ditemukan rahasia apa pun pada payload, request langsung ditolak dengan status HTTP 422 tanpa menghubungi provider.</li>
          </ul>
        </div>

        <div style="margin-top: 1.5rem;">
          <button type="submit" class="btn btn-primary">Simpan</button>
        </div>
      </form>
    </div>
  `;

  return renderLayout({ title: "DLP", activeTab: "dlp", content, port });
}

export async function handleSaveDlp(c) {
  const body = await c.req.parseBody();
  const rawMode = String(body.dlp_mode || "").toLowerCase().trim();
  if (rawMode === "off" || rawMode === "redact" || rawMode === "block") {
    setSetting("dlp_mode", rawMode);
  }
  return c.redirect("/dashboard/dlp?saved=1");
}
