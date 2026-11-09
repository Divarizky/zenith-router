import { getAllSettings, setSetting } from "../../services/settings.js";
import { renderLayout } from "../layout.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

export function renderTokenSaverPage(port = 20120, query = {}, lang = DEFAULT_LANGUAGE) {
  const currentLang = lang || DEFAULT_LANGUAGE;
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
      <h3>${escapeHtml(t("token_saver.title", {}, currentLang))}</h3>
      <p class="hint" style="margin-bottom: 1.25rem;">${escapeHtml(t("token_saver.subtitle", {}, currentLang))}</p>

      <form action="/dashboard/token-saver" method="POST">
        <div class="setting-row">
          <div class="setting-info">
            <strong>${escapeHtml(t("token_saver.rtk_label", {}, currentLang))}</strong>
            <p class="hint">${escapeHtml(t("token_saver.rtk_hint", {}, currentLang))}</p>
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
            <strong>${escapeHtml(t("token_saver.caveman_label", {}, currentLang))}</strong>
            <p class="hint">${escapeHtml(t("token_saver.caveman_hint", {}, currentLang))}</p>
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

  return renderLayout({ title: "Token Saver", activeTab: "tokensaver", content, port, lang: currentLang });
}

export async function handleSaveTokenSaver(c) {
  const body = await c.req.parseBody();
  const rtk = body.token_saver_rtk === "true" || body.token_saver_rtk === "on" ? "true" : "false";
  const caveman = body.token_saver_caveman === "true" || body.token_saver_caveman === "on" ? "true" : "false";
  setSetting("token_saver_rtk", rtk);
  setSetting("token_saver_caveman", caveman);
  return c.redirect("/dashboard/settings?saved=1#tokensaver");
}
