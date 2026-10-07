import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getAvailableModels, getAllProviders } from "../../providers/index.js";
import {
  listCustomModels,
  deleteCustomModel,
  disableModel,
  enableModel,
  getDisabledModels,
  addCustomModel,
} from "../../services/modelOverrides.js";
import { computeFreeTierTotals } from "../../config/freeTierCatalog.js";

export function renderModelsPage(port) {
  const models = getAvailableModels();
  const custom = listCustomModels();
  const disabled = getDisabledModels();
  const free = computeFreeTierTotals();

  const providers = getAllProviders();
  const options = providers
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`)
    .join("");

  const customRows = custom.length
    ? custom
        .map(
          (m) => `
      <tr>
        <td><code>${escapeHtml(m.provider)}/${escapeHtml(m.model_id)}</code></td>
        <td>${escapeHtml(m.name || "-")}</td>
        <td><form method="POST" action="/dashboard/models/custom/delete"><input type="hidden" name="id" value="${m.id}"><button class="btn" type="submit">Delete</button></form></td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="3" style="color: var(--text-muted); text-align: center;">No custom models.</td></tr>`;

  const disabledRows = Object.entries(disabled)
    .flatMap(([provider, ids]) => ids.map((id) => `${provider}/${id}`))
    .map(
      (full) => `
      <tr>
        <td><code>${escapeHtml(full)}</code></td>
        <td><form method="POST" action="/dashboard/models/enable"><input type="hidden" name="provider" value="${escapeHtml(full.split("/")[0])}"><input type="hidden" name="model_id" value="${escapeHtml(full.slice(full.indexOf("/") + 1))}"><button class="btn" type="submit">Enable</button></form></td>
      </tr>`
    )
    .join("");

  const modelRows = models
    .slice(0, 200)
    .map(
      (m) => `
      <tr>
        <td><code>${escapeHtml(m.id)}</code></td>
        <td><span class="pill">${escapeHtml(m.owned_by)}</span></td>
        <td><form method="POST" action="/dashboard/models/disable"><input type="hidden" name="provider" value="${escapeHtml(m.owned_by)}"><input type="hidden" name="model_id" value="${escapeHtml(m.root)}"><button class="btn" type="submit">Disable</button></form></td>
      </tr>`
    )
    .join("");

  const content = `
    <div class="card">
      <h3>Custom Models (${custom.length})</h3>
      <table>
        <thead><tr><th>Model</th><th>Name</th><th></th></tr></thead>
        <tbody>${customRows}</tbody>
      </table>
      <form method="POST" action="/dashboard/models/custom/add" style="margin-top: 0.75rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <select class="field" name="provider">${options}</select>
        <input class="field" name="model_id" placeholder="model id, e.g. gpt-4.1-mini" required>
        <input class="field" name="name" placeholder="display name (optional)">
        <button class="btn btn-primary" type="submit">Add</button>
      </form>
    </div>

    <div class="card">
      <h3>Disabled Models (${Object.values(disabled).flat().length})</h3>
      <table>
        <thead><tr><th>Model</th><th></th></tr></thead>
        <tbody>${disabledRows || `<tr><td colspan="2" style="color: var(--text-muted); text-align: center;">None disabled.</td></tr>`}</tbody>
      </table>
    </div>

    <div class="card">
      <h3>Free Tier Catalog</h3>
      <p style="color: var(--text-muted); font-size: 0.85rem;">Providers with documented recurring free token caps: ${free.providers}. Total monthly free tokens (upper bound): ${free.monthlyTokens.toLocaleString()}. Providers flagged avoid-ToS: ${free.tosAvoid}.</p>
    </div>

    <div class="card">
      <h3>Routed Models (${models.length})</h3>
      <table>
        <thead><tr><th>Model ID</th><th>Provider</th><th></th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
    </div>
  `;

  return renderLayout({ title: "Models", activeTab: "models", content, port });
}

export async function handleAddCustomModel(c) {
  const body = await c.req.parseBody();
  if (body.provider && body.model_id) {
    addCustomModel({ provider: body.provider, model_id: body.model_id, name: body.name || null });
  }
  return c.redirect("/dashboard/models");
}

export async function handleDeleteCustomModel(c) {
  const body = await c.req.parseBody();
  if (body.id) deleteCustomModel(Number(body.id));
  return c.redirect("/dashboard/models");
}

export async function handleDisableModel(c) {
  const body = await c.req.parseBody();
  if (body.provider && body.model_id) disableModel(body.provider, body.model_id);
  return c.redirect("/dashboard/models");
}

export async function handleEnableModel(c) {
  const body = await c.req.parseBody();
  if (body.provider && body.model_id) enableModel(body.provider, body.model_id);
  return c.redirect("/dashboard/models");
}
