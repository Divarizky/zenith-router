import { getAllSettings, setSetting } from "../../services/settings.js";
import { renderLayout } from "../layout.js";

export function renderTokenSaverPage(port = 20120, query = {}) {
  const settings = getAllSettings();
  const isRtkEnabled = settings.token_saver_rtk !== "false";
  const isCavemanEnabled = settings.token_saver_caveman === "true";
  const isSaved = query.saved === "1" || query.saved === "true";

  const content = `
    ${
      isSaved
        ? `<div class="notice notice-ok"><span>Pengaturan Token Saver berhasil disimpan.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : ""
    }
    <div class="card">
      <h3>Token Saver</h3>
      <p class="hint" style="margin-bottom: 1.25rem;">Kurangi pemakaian token tanpa mengubah struktur tool. Tool result dan pesan asisten tidak disentuh.</p>

      <form action="/dashboard/token-saver" method="POST">
        <div class="setting-row">
          <div class="setting-info">
            <strong>RTK (Reduced Token Kit)</strong>
            <p class="hint">Memadatkan baris berulang pada teks yang kamu ketik. Output tool dan turn asisten dibiarkan utuh.</p>
          </div>
          <div class="setting-action">
            <label class="switch" aria-label="RTK">
              <input type="checkbox" name="token_saver_rtk" value="true" ${isRtkEnabled ? "checked" : ""} />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <strong>Caveman Conciseness Compactor</strong>
            <p class="hint">Menambahkan aturan ringkas ke system prompt. Default mati karena mengubah perilaku agent.</p>
          </div>
          <div class="setting-action">
            <label class="switch" aria-label="Caveman">
              <input type="checkbox" name="token_saver_caveman" value="true" ${isCavemanEnabled ? "checked" : ""} />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div style="margin-top: 1.5rem;">
          <button type="submit" class="btn btn-primary">Simpan</button>
        </div>
      </form>
    </div>
  `;

  return renderLayout({ title: "Token Saver", activeTab: "tokensaver", content, port });
}

export async function handleSaveTokenSaver(c) {
  const body = await c.req.parseBody();
  const rtk = body.token_saver_rtk === "true" || body.token_saver_rtk === "on" ? "true" : "false";
  const caveman = body.token_saver_caveman === "true" || body.token_saver_caveman === "on" ? "true" : "false";
  setSetting("token_saver_rtk", rtk);
  setSetting("token_saver_caveman", caveman);
  return c.redirect("/dashboard/token-saver?saved=1");
}
