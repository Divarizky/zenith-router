import { getAllSettings, setSetting } from "../../services/settings.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getBindHost, isLoopbackHost } from "../../security.js";
import { countActiveApiKeys } from "../../services/apiKeys.js";

/**
 * Render Settings Control page
 */
export function renderSettingsPage(port = 20120) {
  const settings = getAllSettings();

  const isRequireAuth = settings.require_api_key === "true";
  const isRtkEnabled = settings.token_saver_rtk !== "false";
  const isCavemanEnabled = settings.token_saver_caveman === "true";
  const fallbackModel = settings.default_fallback_model || "glm/glm-4-flash";
  const forcedByBind = !isLoopbackHost(getBindHost());
  const activeKeys = countActiveApiKeys();

  let authNote = "";
  if (forcedByBind) {
    authNote = `<p style="font-size: 0.8rem; color: var(--warning); margin-top: 0.25rem;">Always enforced: zenroute is bound to ${escapeHtml(getBindHost())}.</p>`;
  } else if (isRequireAuth && activeKeys === 0) {
    authNote = `<p style="font-size: 0.8rem; color: var(--danger); margin-top: 0.25rem;">No active API key: every /v1 request is rejected. Create one in API Keys.</p>`;
  }

  const content = `
    <div class="card" style="max-width: 600px;">
      <h3 style="margin-bottom: 1.25rem;">Global Gateway Settings</h3>
      <form action="/dashboard/settings" method="POST">
        <div style="margin-bottom: 1.25rem;">
          <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
            <input type="checkbox" name="require_api_key" value="true" ${
              isRequireAuth ? "checked" : ""
            } style="width: auto; margin: 0;" />
            <div>
              <strong>Require API Key for Gateway Access</strong>
              <p style="font-size: 0.8rem; color: var(--text-muted);">Clients must send a zenroute key from the API Keys page (Authorization: Bearer or x-api-key) to use /v1.</p>
              ${authNote}
            </div>
          </label>
        </div>

        <div style="margin-bottom: 1.25rem;">
          <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
            <input type="checkbox" name="token_saver_rtk" value="true" ${
              isRtkEnabled ? "checked" : ""
            } style="width: auto; margin: 0;" />
            <div>
              <strong>Enable RTK (Reduced Token Kit)</strong>
              <p style="font-size: 0.8rem; color: var(--text-muted);">Condenses repeated lines in text you type. Tool results and assistant turns are left untouched.</p>
            </div>
          </label>
        </div>

        <div style="margin-bottom: 1.25rem;">
          <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
            <input type="checkbox" name="token_saver_caveman" value="true" ${
              isCavemanEnabled ? "checked" : ""
            } style="width: auto; margin: 0;" />
            <div>
              <strong>Enable Caveman Conciseness Compactor</strong>
              <p style="font-size: 0.8rem; color: var(--text-muted);">Appends a conciseness rule to the system prompt. Off by default because it changes how your agent behaves.</p>
            </div>
          </label>
        </div>

        <div class="form-group" style="margin-bottom: 1.5rem;">
          <label for="default_fallback_model">Default Routing Fallback Model</label>
          <p style="font-size: 0.8rem; color: var(--text-muted);">Not used by the gateway yet (reserved for failover).</p>
          <input type="text" id="default_fallback_model" name="default_fallback_model" value="${escapeHtml(fallbackModel)}" placeholder="glm/glm-4-flash" required />
        </div>

        <div>
          <button type="submit" class="btn">Save Settings</button>
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
  const rtk = body.token_saver_rtk === "true" || body.token_saver_rtk === "on" ? "true" : "false";
  const caveman = body.token_saver_caveman === "true" || body.token_saver_caveman === "on" ? "true" : "false";
  const fallbackModel = String(body.default_fallback_model || "glm/glm-4-flash").trim();

  setSetting("require_api_key", requireKey);
  setSetting("token_saver_rtk", rtk);
  setSetting("token_saver_caveman", caveman);
  setSetting("default_fallback_model", fallbackModel);

  return c.redirect("/dashboard/settings");
}
