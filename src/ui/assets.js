import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.resolve(__dirname, "../../public/logo.png");

let cachedDataUri = null;

/**
 * Get inlined Data URI for the zenroute logo so it renders reliably everywhere
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
