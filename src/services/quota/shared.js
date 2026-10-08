/** Normalize a reset value (unix seconds/ms, numeric string, ISO) to ISO. */
export function parseResetTime(value) {
  if (!value) return null;
  try {
    if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    if (typeof value === "string") {
      if (/^\d+$/.test(value)) {
        const ts = Number(value);
        return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
      }
      return new Date(value).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}
