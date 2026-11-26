// Port of Troupe's antigravity_quota_message: the agent reports an exhausted quota as plain text.
const QUOTA_TITLE = "Usage Limit Reached";
const QUOTA_BODY = "You have reached your current quota for this period.";
export const DEFAULT_LIMIT_MS = 5 * 3_600_000;
const UNIT_MS = { day: 86_400_000, hour: 3_600_000, hr: 3_600_000, minute: 60_000, min: 60_000, second: 1000, sec: 1000 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function sentence(text) {
  const t = text.trim();
  const m = t.match(/\.(\s|$)/);
  return (m ? t.slice(0, m.index) : t).trim();
}

function relativeReset(text) {
  let total = 0;
  let parts = 0;
  for (const part of text.split(",").flatMap((p) => p.split(" and ")).map((p) => p.trim()).filter(Boolean)) {
    const words = part.split(/\s+/);
    if (words.length !== 2 || !/^\d+$/.test(words[0])) return null;
    const unit = UNIT_MS[words[1].toLowerCase().replace(/s$/, "")];
    if (!unit) return null;
    total += Number(words[0]) * unit;
    parts += 1;
  }
  return parts > 0 && Number.isSafeInteger(total) ? total : null;
}

function absoluteReset(text) {
  const m = text.trim().match(/^(\w{3})\w*\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*UTC$/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const at = Date.UTC(Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5]));
  return Number.isFinite(at) ? at : null;
}

/** Returns `{ resetAt }` (epoch ms or null when not reported) for a quota message, else null. */
export function parseAntigravityQuotaMessage(text, nowMs = Date.now()) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t.startsWith(QUOTA_TITLE) || !t.includes(QUOTA_BODY)) return null;
  let resetAt = null;
  const rel = t.indexOf("reset in ");
  const abs = t.indexOf("reset on ");
  if (rel >= 0) {
    const ms = relativeReset(sentence(t.slice(rel + 9)));
    resetAt = ms === null ? null : nowMs + ms;
  } else if (abs >= 0) {
    resetAt = absoluteReset(sentence(t.slice(abs + 9)));
  }
  return { resetAt };
}
