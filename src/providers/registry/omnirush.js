import "../../executors/omnirush.js";
import { DEFAULT_OMNIRUSH_CLIENT_VERSION } from "../../executors/omnirush.js";

/**
 * Provider Omnirush (https://omnirush.ai).
 *
 * PERINGATAN RISIKO:
 * 1. Terms Omnirush (bagian Fair use) melarang akses model di luar produk resmi
 *    (desktop app / CLI), klien kustom, wrapper, atau integrasi pihak ketiga.
 *    Sistem mereka berhak menutup akun otomatis jika mendeteksi klien tidak resmi.
 * 2. Integrasi ini memakai identitas klien CLI resmi untuk dapat terhubung (User-Agent
 *    dan X-OmniRush-Client diemulasikan). Ini melanggar ketentuan layanan mereka.
 * 3. Seluruh data sesi diunggah dan dipakai untuk training model sesuai data agreement Omnirush.
 * 4. Model "GPT 6 Astra", "GPT 6.1 Sol", dan "GPT 6 Sol" adalah penamaan internal Omnirush;
 *    keaslian model di balik nama tersebut belum terverifikasi publik.
 *
 * Provider ini secara default nonaktif sampai pengguna mengaktifkannya secara manual.
 */

export const OMNIRUSH_BASE_URL = "https://omnirush.ai/omnirush/v1/responses";
export const OMNIRUSH_AUTH_ORIGIN = "https://omnirush.ai/omnirush";

export default {
  id: "omnirush",
  name: "Omnirush",
  alias: ["omnirush", "or-rush"],
  category: "oauth",
  format: "openai-responses",
  executor: "omnirush",
  // Provider ini sengaja dibatasi satu akun per instalasi untuk mematuhi larangan multi-akun
  // dan menghindari deteksi pooling akun bersama.
  singleAccount: true,
  // Dilarang melakukan polling background otomatis (kuota/keepalive/model-sync) ke omnirush.ai
  noBackgroundSync: true,
  warning:
    "PERINGATAN: Omnirush melarang klien pihak ketiga dan data percakapan dipakai untuk training. " +
    "Akun berisiko ditutup otomatis jika terdeteksi. Gunakan dengan akun pribadi yang disiapkan secara sadar.",
  transport: {
    baseUrl: OMNIRUSH_BASE_URL,
    format: "openai-responses",
    forceStream: true,
    cliVersion: DEFAULT_OMNIRUSH_CLIENT_VERSION,
    headers: {
      "User-Agent": "omnirush",
      "X-OmniRush-Client": `cli/${DEFAULT_OMNIRUSH_CLIENT_VERSION}`,
    },
  },
  models: [
    {
      id: "gpt-6-astra",
      name: "GPT 6 Astra",
      // Terverifikasi dari katalog paket npm resmi `omnirush@2.7.2` (assets/models.json)
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400000,
      description: "Model default Omnirush dengan reasoning dan input teks/gambar (terverifikasi di katalog CLI).",
    },
    {
      id: "gpt-6.1-sol",
      name: "GPT 6.1 Sol",
      // Belum terverifikasi di katalog resmi publik; dirujuk di CLI flag (-m gpt-6-sol:high)
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400000,
      description: "Model varian Sol (belum terverifikasi independen sebagai model OpenAI asli).",
    },
    {
      id: "gpt-6-sol",
      name: "GPT 6 Sol",
      // Belum terverifikasi di katalog resmi publik; dirujuk di CLI flag (-m gpt-6-sol)
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400000,
      description: "Model varian Sol standar (belum terverifikasi independen sebagai model OpenAI asli).",
    },
  ],
  oauth: {
    origin: OMNIRUSH_AUTH_ORIGIN,
    authorizeUrl: `${OMNIRUSH_AUTH_ORIGIN}/device/authorize`,
    tokenUrl: `${OMNIRUSH_AUTH_ORIGIN}/device/token`,
    refreshUrl: `${OMNIRUSH_AUTH_ORIGIN}/device/refresh`,
  },
};
