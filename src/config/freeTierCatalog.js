/**
 * Free-tier monthly token budget catalog, mirrored from OmniRoute's
 * open-sse/config/freeTierCatalog.ts (2026-06-05 research snapshot).
 *
 * Only values applicable to zenroute's current providers are carried over.
 * Providers not listed have no documented recurring free token cap.
 */

export const FREE_TIER_BUDGETS = {
  kiro: 25_000,
};

export const FREE_TIER_TOS = {
  antigravity: "avoid",
  opencode: "avoid",
  kiro: "avoid",
};

export function computeFreeTierTotals({ excludeTosAvoid = false } = {}) {
  let monthlyTokens = 0;
  let providers = 0;
  let tosAvoid = 0;

  for (const [provider, budget] of Object.entries(FREE_TIER_BUDGETS)) {
    const verdict = FREE_TIER_TOS[provider] || "unknown";
    if (verdict === "avoid") tosAvoid += 1;
    if (excludeTosAvoid && verdict === "avoid") continue;
    monthlyTokens += budget;
    providers += 1;
  }

  return { providers, monthlyTokens, tosAvoid };
}
