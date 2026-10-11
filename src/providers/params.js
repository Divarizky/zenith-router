import { createHash } from "node:crypto";

/**
 * 403 bodies where the upstream refuses the model for this account, not the
 * account itself: Mistral tier_not_allowed (model outside the plan) and
 * labs_not_enabled (Labs models need an org admin to opt in).
 */
export const MODEL_ACCESS_DENIED_403 = /tier_not_allowed|labs_not_enabled|not available in your subscription tier/i;

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM9 = /^[a-zA-Z0-9]{9}$/;

/**
 * Map a tool call id to 9 alphanumeric characters. Ids already in that shape are
 * kept; others are hashed, so the same id maps the same way on every request
 * (clients resend the whole history each turn).
 */
export function toAlnum9Id(id) {
  const s = String(id ?? "");
  if (ALNUM9.test(s)) return s;
  const bytes = createHash("sha256").update(s).digest();
  let out = "";
  for (let i = 0; i < 9; i++) out += BASE62[bytes[i] % 62];
  return out;
}

/** Rewrite tool call ids in OpenAI chat messages; tool results follow their call. */
function mapToolCallIds(messages, mapId) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    if (Array.isArray(m.tool_calls)) {
      return { ...m, tool_calls: m.tool_calls.map((tc) => (tc && tc.id != null ? { ...tc, id: mapId(tc.id) } : tc)) };
    }
    if (m.tool_call_id != null) return { ...m, tool_call_id: mapId(m.tool_call_id) };
    return m;
  });
}

/**
 * Adjust an upstream payload to the fields a provider accepts, using
 * `transport.paramRenames`, `transport.dropParams` and `transport.toolCallIds`
 * from its registry entry. Renames never overwrite a field the client already
 * set under the new name. Returns the input unchanged when the provider declares none.
 */
export function adaptPayloadForProvider(provider, payload) {
  const renames = provider?.transport?.paramRenames;
  const drops = provider?.transport?.dropParams;
  const toolCallIds = provider?.transport?.toolCallIds;
  if (!payload || typeof payload !== "object" || (!renames && !drops && !toolCallIds)) return payload;

  const out = { ...payload };
  if (toolCallIds === "alnum9") out.messages = mapToolCallIds(out.messages, toAlnum9Id);
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
