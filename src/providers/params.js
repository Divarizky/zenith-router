/**
 * 403 bodies where the upstream refuses the model for this account, not the
 * account itself: upstream tier_not_allowed (model outside the plan) and
 * labs_not_enabled (Labs models need an org admin to opt in).
 */
export const MODEL_ACCESS_DENIED_403 = /tier_not_allowed|labs_not_enabled|not available in your subscription tier/i;

/**
 * Adjust an upstream payload to the fields a provider accepts, using
 * `transport.paramRenames` and `transport.dropParams` from its registry entry.
 * Renames never overwrite a field the client already set under the new name.
 * Returns the input unchanged when the provider declares none.
 */
export function adaptPayloadForProvider(provider, payload) {
  const renames = provider?.transport?.paramRenames;
  const drops = provider?.transport?.dropParams;
  if (!payload || typeof payload !== "object" || (!renames && !drops)) return payload;

  const out = { ...payload };
  for (const [from, to] of Object.entries(renames || {})) {
    if (!(from in out)) continue;
    if (out[to] === undefined) out[to] = out[from];
    delete out[from];
  }
  for (const key of drops || []) {
    delete out[key];
  }
  return out;
}
