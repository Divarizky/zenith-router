import { getAllSettings, setSetting } from "../../services/settings.js";
import { renderLayout } from "../layout.js";

export function renderTokenSaverPage(port = 20120) {
  const settings = getAllSettings();
  const isRtkEnabled = settings.token_saver_rtk !== "false";
  const isCavemanEnabled = settings.token_saver_caveman === "true";

  const content = `
    <div class="card">
      <h3>Token Saver</h3>
      <p class="hint" style="margin-bottom: 1.25rem;">Kurangi pemakaian token tanpa mengubah struktur tool. Tool result dan pesan asisten tidak disentuh.</p>

      <form action="/dashboard/token-saver" method="POST">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid var(--border-subtle);">
          <div>
            <strong>RTK (Reduced Token Kit)</strong>
            <p class="hint">Memadatkan baris berulang pada teks yang kamu ketik. Output tool dan turn asisten dibiarkan utuh.</p>
          </div>
          <label class="switch">
            <input type="checkbox" name="token_saver_rtk" value="true" ${isRtkEnabled ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>

        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1rem 0;">
          <div>
            <strong>Caveman Conciseness Compactor</strong>
            <p class="hint">Menambahkan aturan ringkas ke system prompt. Default mati karena mengubah perilaku agent.</p>
          </div>
          <label class="switch">
            <input type="checkbox" name="token_saver_caveman" value="true" ${isCavemanEnabled ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>

        <div style="margin-top: 1.25rem;">
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
  return c.redirect("/dashboard/token-saver");
}
