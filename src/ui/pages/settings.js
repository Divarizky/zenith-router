import { getAllSettings, setSetting } from "../../services/settings.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getBindHost, isLoopbackHost } from "../../security.js";
import { countActiveApiKeys } from "../../services/apiKeys.js";

/**
 * Render Settings Control page
 */
export function renderSettingsPage(port = 20120, query = {}) {
  const settings = getAllSettings();

  const isRequireAuth = settings.require_api_key === "true";
  const rotationStrategy = settings.account_rotation || "lru";
  const isTrafficGuard = settings.traffic_guard_enabled !== "false";
  const maxConcurrency = settings.max_account_concurrency || "2";
  const isJitter = settings.request_jitter_enabled !== "false";
  const forcedByBind = !isLoopbackHost(getBindHost());
  const activeKeys = countActiveApiKeys();
  const isSaved = query.saved === "1" || query.saved === "true";

  let authNote = "";
  if (forcedByBind) {
    authNote = `<p style="font-size: 0.8rem; color: var(--warning); margin-top: 0.25rem;">Selalu ditegakkan: Zenith Router terikat ke ${escapeHtml(getBindHost())}.</p>`;
  } else if (isRequireAuth && activeKeys === 0) {
    authNote = `<p style="font-size: 0.8rem; color: var(--danger); margin-top: 0.25rem;">Tidak ada kunci API aktif: semua request /v1 ditolak. Buat satu di Kunci API.</p>`;
  }

  const content = `
    ${
      isSaved
        ? `<div class="notice notice-ok"><span>Pengaturan Gateway berhasil disimpan.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : ""
    }
    <div class="card">
      <div class="section-head">
        <h3>General</h3>
        <p class="hint">Pengaturan dasar gateway dan keamanan akses.</p>
      </div>
      <form action="/dashboard/settings" method="POST">
        <div class="setting-row">
          <div class="setting-info">
            <strong>Wajibkan Kunci API untuk Akses Gateway</strong>
            <p class="hint">Klien harus mengirim kunci Zenith Router dari halaman Kunci API (Authorization: Bearer atau x-api-key) untuk memakai /v1.</p>
            ${authNote}
          </div>
          <div class="setting-action">
            <label class="switch" aria-label="Wajibkan Kunci API">
              <input type="checkbox" name="require_api_key" value="true" ${isRequireAuth ? "checked" : ""} />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="section-head" style="margin-top: 1.75rem;">
          <h3>Accounts &amp; Connections</h3>
          <p class="hint">Perilaku pemilihan dan perlindungan akun provider yang tertaut.</p>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <strong>Strategi Rotasi Akun</strong>
            <p class="hint">Cara Zenith Router memilih antar akun aktif untuk penyedia yang sama.</p>
          </div>
          <div class="setting-action">
            <select name="account_rotation" class="input-select">
              <option value="lru" ${rotationStrategy === "lru" ? "selected" : ""}>LRU (Giliran Akun)</option>
              <option value="sticky" ${rotationStrategy === "sticky" ? "selected" : ""}>Sticky (Akun Sama)</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <strong>Penjaga Lalu Lintas Akun (Traffic Guard)</strong>
            <p class="hint">Membatasi request bersamaan per akun OAuth agar tidak terdeteksi bot dan kena rate limit.</p>
          </div>
          <div class="setting-action">
            <label class="switch" aria-label="Penjaga Lalu Lintas Akun">
              <input type="checkbox" name="traffic_guard_enabled" value="true" ${isTrafficGuard ? "checked" : ""} />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <strong>Batas Konkurensi per Akun</strong>
            <p class="hint">Jumlah maksimum request in-flight bersamaan untuk satu akun saat Penjaga Lalu Lintas aktif.</p>
          </div>
          <div class="setting-action">
            <select name="max_account_concurrency" class="input-select">
              <option value="1" ${maxConcurrency === "1" ? "selected" : ""}>Maks 1 bersamaan</option>
              <option value="2" ${maxConcurrency === "2" ? "selected" : ""}>Maks 2 bersamaan</option>
              <option value="3" ${maxConcurrency === "3" ? "selected" : ""}>Maks 3 bersamaan</option>
              <option value="5" ${maxConcurrency === "5" ? "selected" : ""}>Maks 5 bersamaan</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <strong>Jeda & Jitter Seperti Manusia</strong>
            <p class="hint">Memberi jeda acak kecil (100–300ms) antar request berurutan untuk memutus pola burst bot.</p>
          </div>
          <div class="setting-action">
            <label class="switch" aria-label="Jeda & Jitter Seperti Manusia">
              <input type="checkbox" name="request_jitter_enabled" value="true" ${isJitter ? "checked" : ""} />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div style="margin-top: 1.5rem;">
          <button type="submit" class="btn btn-primary">Simpan Pengaturan</button>
        </div>
      </form>
    </div>
  `;

  return renderLayout({
    title: "Settings",
    activeTab: "settings",
    content,
    port,
  });
}

/**
 * Handle form POST /dashboard/settings
 */
export async function handleSaveSettings(c) {
  const body = await c.req.parseBody();

  const requireKey = body.require_api_key === "true" || body.require_api_key === "on" ? "true" : "false";
  const rotation = body.account_rotation === "sticky" ? "sticky" : "lru";
  const trafficGuard = body.traffic_guard_enabled === "true" || body.traffic_guard_enabled === "on" ? "true" : "false";
  const maxConcurrency = String(Number(body.max_account_concurrency) || 2);
  const requestJitter = body.request_jitter_enabled === "true" || body.request_jitter_enabled === "on" ? "true" : "false";

  setSetting("require_api_key", requireKey);
  setSetting("account_rotation", rotation);
  setSetting("traffic_guard_enabled", trafficGuard);
  setSetting("max_account_concurrency", maxConcurrency);
  setSetting("request_jitter_enabled", requestJitter);

  return c.redirect("/dashboard/settings?saved=1");
}
