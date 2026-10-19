import { getAllSettings, setSetting } from "../../services/settings.js";
import { renderLayout, icon } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getBindHost, isLoopbackHost } from "../../security.js";
import { countActiveApiKeys } from "../../services/apiKeys.js";
import { listCombos } from "../../services/combos.js";
import { getAvailableModels, getProvider } from "../../providers/index.js";

/**
 * Options of the default fallback picker: plain models grouped per provider,
 * plus the active combos, which are cross-provider chains in their own right.
 * A value saved earlier stays selectable even when its provider, model, or combo
 * has since gone away, so saving an unrelated setting never drops it silently.
 */
function fallbackOptions(current) {
  const byProvider = new Map();
  for (const model of getAvailableModels()) {
    const providerId = model.owned_by || "lain";
    if (!byProvider.has(providerId)) byProvider.set(providerId, []);
    byProvider.get(providerId).push(model.id);
  }

  const providerName = (providerId) => getProvider(providerId)?.name || providerId;
  const modelGroups = [...byProvider.keys()]
    .sort((a, b) => providerName(a).localeCompare(providerName(b)))
    .map((providerId) => {
      const options = byProvider
        .get(providerId)
        .sort()
        .map(
          (id) =>
            `<option value="${escapeHtml(id)}"${id === current ? " selected" : ""}>${escapeHtml(id)}</option>`
        )
        .join("");
      return `<optgroup label="${escapeHtml(providerName(providerId))}">${options}</optgroup>`;
    })
    .join("");

  const activeCombos = listCombos().filter((combo) => combo.enabled);
  const comboOptions = activeCombos
    .map(
      (combo) =>
        `<option value="${escapeHtml(combo.name)}"${combo.name === current ? " selected" : ""}>${escapeHtml(combo.name)}</option>`
    )
    .join("");
  const comboGroup = comboOptions ? `<optgroup label="Combo">${comboOptions}</optgroup>` : "";

  const known = new Set([...byProvider.values()].flat().concat(activeCombos.map((c) => c.name)));
  const staleOption =
    current && !known.has(current)
      ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (tidak aktif)</option>`
      : "";

  return `<option value=""${current ? "" : " selected"}>Nonaktif</option>${staleOption}${comboGroup}${modelGroups}`;
}

/**
 * One settings section. Every section is its own card so a long page stays
 * scannable, while the single form around them keeps one save action and one
 * POST handler — a per-card form would need partial writes, and a missing
 * checkbox in a partial POST reads as "off".
 */
function sectionCard({ id, iconName, title, hint, rows }) {
  return `
    <section class="card" id="${id}">
      <div class="section-head">
        <h3>${icon(iconName, 16)} ${title}</h3>
        <p class="hint">${hint}</p>
      </div>
      ${rows}
    </section>`;
}

/**
 * Render Settings Control page
 */
export function renderSettingsPage(port = 20120, query = {}) {
  const settings = getAllSettings();

  const isRequireAuth = settings.require_api_key === "true";
  const rotationStrategy = settings.account_rotation || "lru";
  const comboHoldCount = settings.combo_round_robin_count || "1";
  const isTrafficGuard = settings.traffic_guard_enabled !== "false";
  const maxConcurrency = settings.max_account_concurrency || "2";
  const isJitter = settings.request_jitter_enabled !== "false";
  const fallbackModel = settings.default_fallback_model || "";
  const forcedByBind = !isLoopbackHost(getBindHost());
  const activeKeys = countActiveApiKeys();
  const isSaved = query.saved === "1" || query.saved === "true";

  let authNote = "";
  if (forcedByBind) {
    authNote = `<p class="setting-note setting-note-warning">Selalu ditegakkan: Zenith Router terikat ke ${escapeHtml(getBindHost())}.</p>`;
  } else if (isRequireAuth && activeKeys === 0) {
    authNote = `<p class="setting-note setting-note-danger">Tidak ada kunci API aktif: semua request /v1 ditolak. Buat satu di Kunci API.</p>`;
  }

  const content = `
    ${
      isSaved
        ? `<div class="notice notice-ok"><span>Pengaturan Gateway berhasil disimpan.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : ""
    }
    <form action="/dashboard/settings" method="POST">
      ${sectionCard({
        id: "access",
        iconName: "key",
        title: "Access &amp; Security",
        hint: "Siapa yang boleh memakai /v1 dan bagaimana permintaan diverifikasi.",
        rows: `
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
        </div>`,
      })}

      ${sectionCard({
        id: "selection",
        iconName: "list",
        title: "Account Selection",
        hint: "Bagaimana Zenith Router memilih akun dan anggota combo saat ada beberapa pilihan.",
        rows: `
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
            <strong>Batas Giliran Combo</strong>
            <p class="hint">Jumlah request berturut-turut yang memakai anggota yang sama sebelum rotasi maju. Hanya berlaku pada combo berstrategi giliran; default 1.</p>
          </div>
          <div class="setting-action">
            <input type="number" min="1" step="1" name="combo_round_robin_count" class="input-select" value="${escapeHtml(comboHoldCount)}" />
          </div>
        </div>`,
      })}

      ${sectionCard({
        id: "protection",
        iconName: "bolt",
        title: "Account Protection",
        hint: "Penjaga agar pola request tidak terlihat seperti bot dan tidak kena rate limit.",
        rows: `
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
        </div>`,
      })}

      ${sectionCard({
        id: "routing",
        iconName: "brain",
        title: "Routing &amp; Fallback",
        hint: "Ke mana request dialihkan saat model atau combo yang diminta tidak bisa melayani.",
        rows: `
        <div class="setting-row">
          <div class="setting-info">
            <strong>Default Fallback Model</strong>
            <p class="hint">Model atau combo yang dipakai otomatis saat model yang diminta kena rate limit, kuota habis, atau gangguan upstream. Nonaktif berarti tidak ada cadangan.</p>
          </div>
          <div class="setting-action">
            <select name="default_fallback_model" class="input-select">
              ${fallbackOptions(fallbackModel)}
            </select>
          </div>
        </div>`,
      })}

      <div class="settings-actions">
        <span class="hint">Perubahan berlaku setelah disimpan.</span>
        <button type="submit" class="btn btn-primary">Simpan Pengaturan</button>
      </div>
    </form>
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
  const comboHoldCount = String(Math.max(1, Math.trunc(Number(body.combo_round_robin_count) || 1)));
  const fallbackModel = String(body.default_fallback_model || "").trim();

  setSetting("require_api_key", requireKey);
  setSetting("account_rotation", rotation);
  setSetting("traffic_guard_enabled", trafficGuard);
  setSetting("max_account_concurrency", maxConcurrency);
  setSetting("request_jitter_enabled", requestJitter);
  setSetting("combo_round_robin_count", comboHoldCount);
  setSetting("default_fallback_model", fallbackModel);

  return c.redirect("/dashboard/settings?saved=1");
}
