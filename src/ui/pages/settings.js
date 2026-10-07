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
  const fallbackModel = settings.default_fallback_model || "glm/glm-4-flash";
  const forcedByBind = !isLoopbackHost(getBindHost());
  const activeKeys = countActiveApiKeys();
  const isSaved = query.saved === "1" || query.saved === "true";

  let authNote = "";
  if (forcedByBind) {
    authNote = `<p style="font-size: 0.8rem; color: var(--warning); margin-top: 0.25rem;">Always enforced: zenroute is bound to ${escapeHtml(getBindHost())}.</p>`;
  } else if (isRequireAuth && activeKeys === 0) {
    authNote = `<p style="font-size: 0.8rem; color: var(--danger); margin-top: 0.25rem;">No active API key: every /v1 request is rejected. Create one in API Keys.</p>`;
  }

  const content = `
    ${
      isSaved
        ? `<div class="notice notice-ok"><span>Pengaturan Gateway berhasil disimpan.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : ""
    }
    <div class="card" style="max-width: 640px;">
      <h3 style="margin-bottom: 1.25rem;">Global Gateway Settings</h3>
      <form action="/dashboard/settings" method="POST">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border-subtle); margin-bottom: 1.25rem;">
          <div>
            <strong>Require API Key for Gateway Access</strong>
            <p class="hint">Clients must send a zenroute key from the API Keys page (Authorization: Bearer or x-api-key) to use /v1.</p>
            ${authNote}
          </div>
          <label class="switch">
            <input type="checkbox" name="require_api_key" value="true" ${isRequireAuth ? "checked" : ""} />
            <span class="slider"></span>
          </label>
        </div>

        <div class="field">
          <label for="default_fallback_model">Default Routing Fallback Model</label>
          <p class="hint" style="margin-bottom: 0.4rem;">Not used by the gateway yet (reserved for failover).</p>
          <input type="text" id="default_fallback_model" name="default_fallback_model" value="${escapeHtml(fallbackModel)}" placeholder="glm/glm-4-flash" required />
        </div>

        <div style="margin-top: 1.25rem;">
          <button type="submit" class="btn btn-primary">Save Settings</button>
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
  const fallbackModel = String(body.default_fallback_model || "glm/glm-4-flash").trim();

  setSetting("require_api_key", requireKey);
  setSetting("default_fallback_model", fallbackModel);

  return c.redirect("/dashboard/settings?saved=1");
}
