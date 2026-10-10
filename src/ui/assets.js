import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.resolve(__dirname, "../../public/logo.png");
const PROVIDERS_DIR = path.resolve(__dirname, "../../public/providers");

let cachedDataUri = null;

/**
 * Get public URL for a provider icon if available (e.g. /providers/claude.png)
 */
export function getProviderIconPath(providerId) {
  if (!providerId) return null;
  const id = String(providerId).toLowerCase().trim();
  try {
    const file = path.join(PROVIDERS_DIR, `${id}.png`);
    if (fs.existsSync(file)) return `/providers/${id}.png`;
  } catch {}
  return null;
}

/**
 * Get inlined Data URI for the zenith-router logo so it renders reliably everywhere
 */
export function getLogoDataUri() {
  if (cachedDataUri) return cachedDataUri;
  try {
    if (fs.existsSync(LOGO_PATH)) {
      const buf = fs.readFileSync(LOGO_PATH);
      cachedDataUri = `data:image/png;base64,${buf.toString("base64")}`;
      return cachedDataUri;
    }
  } catch {}
  return "/logo.png";
}
