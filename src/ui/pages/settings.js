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

        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border-subtle); margin-bottom: 1.25rem;">
          <div>
            <strong>Account Rotation Strategy</strong>
            <p class="hint">How zenroute chooses between multiple active accounts for the same provider.</p>
          </div>
          <div>
            <select name="account_rotation" class="input-select" style="min-width: 140px; padding: 0.35rem 0.6rem; border-radius: 6px; background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-subtle);">
              <option value="lru" ${rotationStrategy === "lru" ? "selected" : ""}>LRU (Round-Robin)</option>
              <option value="sticky" ${rotationStrategy === "sticky" ? "selected" : ""}>Sticky (Same Account)</option>
            </select>
          </div>
        </div>

        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border-subtle); margin-bottom: 1.25rem;">
          <div>
            <strong>Account Traffic Guard (Concurrency Cap)</strong>
            <p class="hint">Limits concurrent requests per OAuth account to avoid bot detection and rate limits.</p>
          </div>
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <select name="max_account_concurrency" class="input-select" style="padding: 0.35rem 0.6rem; border-radius: 6px; background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-subtle);">
              <option value="1" ${maxConcurrency === "1" ? "selected" : ""}>Max 1 in-flight</option>
              <option value="2" ${maxConcurrency === "2" ? "selected" : ""}>Max 2 in-flight</option>
              <option value="3" ${maxConcurrency === "3" ? "selected" : ""}>Max 3 in-flight</option>
              <option value="5" ${maxConcurrency === "5" ? "selected" : ""}>Max 5 in-flight</option>
            </select>
            <label class="switch">
              <input type="checkbox" name="traffic_guard_enabled" value="true" ${isTrafficGuard ? "checked" : ""} />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border-subtle); margin-bottom: 1.25rem;">
          <div>
            <strong>Human-like Request Pacing & Jitter</strong>
            <p class="hint">Applies a small random delay (100–300ms) between back-to-back requests to break bot burst patterns.</p>
          </div>
          <label class="switch">
            <input type="checkbox" name="request_jitter_enabled" value="true" ${isJitter ? "checked" : ""} />
            <span class="slider"></span>
          </label>
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
