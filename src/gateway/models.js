import { getAvailableModels, getProvider, memberCapabilities } from "../providers/index.js";
import { listCombos } from "../services/combos.js";
import { getProviderIconPath } from "../ui/assets.js";

/**
 * An active combo is a routing target, so it belongs in the catalog beside the
 * provider models a client can pick. The entry carries the rollup of its
 * members: a capability is claimed when any member holds it (the chain can
 * reach that member), and the context window is the smallest one in the chain —
 * the length the whole chain can actually serve. A chain nobody has data for
 * claims nothing, same rule as single models.
 *
 * This lives in the endpoint layer rather than in getAvailableModels so the
 * provider registry keeps no dependency on the combo service.
 */
function comboCatalogEntries(now) {
  return listCombos()
    .filter((combo) => combo.enabled === 1 && combo.models.length > 0)
    .map((combo) => {
      const caps = combo.models.map(memberCapabilities).filter(Boolean);
      const entry = {
        id: combo.name,
        object: "model",
        created: now,
        owned_by: "combo",
        permission: [],
        root: combo.name,
        parent: null,
        combo: true,
      };
      if (caps.length === 0) return entry;
      entry.capabilities = {
        vision: caps.some((c) => c.vision === true),
        reasoning: caps.some((c) => c.reasoning === true),
      };
      const windows = caps.map((c) => c.contextWindow).filter((w) => Number.isFinite(w) && w > 0);
      if (windows.length) entry.context_length = Math.min(...windows);
      return entry;
    });
}

/**
 * Handle GET /v1/models
 */
export function handleListModels(c) {
  const all = c.req.query("all") === "true" || c.req.query("showAll") === "true";
  const now = Math.floor(Date.now() / 1000);
  return c.json({
    object: "list",
    data: [...getAvailableModels({ all }), ...comboCatalogEntries(now)],
  });
}

/**
 * Handle GET /api/models — payload untuk dialog pemilih model di dashboard.
 * Model dikelompokkan per provider mengikuti getAvailableModels(): provider
 * dengan koneksi aktif plus provider tanpa autentikasi, termasuk model hasil
 * Import dan model custom. Entri combo sengaja tidak ikut — picker memilih
 * anggota rantai, dan combo bukan anggota rantai.
 */
export function handleGetModelOptions(c) {
  const groups = new Map();

  for (const entry of getAvailableModels()) {
    let group = groups.get(entry.owned_by);
    if (!group) {
      const def = getProvider(entry.owned_by);
      group = {
        id: entry.owned_by,
        name: def?.name || entry.owned_by,
        icon: getProviderIconPath(entry.owned_by),
        models: [],
      };
      groups.set(entry.owned_by, group);
    }

    const model = { id: entry.id };
    if (entry.custom === true) model.custom = true;
    if (entry.imported === true) model.imported = true;
    if (entry.capabilities) model.capabilities = entry.capabilities;
    if (entry.context_length) model.context_length = entry.context_length;
    group.models.push(model);
  }

  return c.json({ providers: [...groups.values()] });
}
