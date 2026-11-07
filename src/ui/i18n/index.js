import id from "./id.js";
import en from "./en.js";
import { getCookie } from "hono/cookie";
import { getSetting } from "../../services/settings.js";

export const SUPPORTED_LANGUAGES = ["id", "en"];
export const DEFAULT_LANGUAGE = "id";

const DICTIONARIES = {
  id,
  en,
};

/**
 * Mengambil nilai translasi berdasarkan path dot-notation (misal: "nav.overview").
 * Mendukung interpolasi parameter {namaVar}.
 * Jika key tidak ditemukan pada bahasa target, otomatis fallback ke bahasa Indonesia ('id').
 *
 * @param {string} key
 * @param {Record<string, any>} [params]
 * @param {string} [lang]
 * @returns {string}
 */
export function t(key, params = {}, lang = DEFAULT_LANGUAGE) {
  const targetLang = SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  let text = getNestedValue(DICTIONARIES[targetLang], key);

  // Fallback ke default (id) jika tidak ditemukan di targetLang
  if (text === undefined && targetLang !== DEFAULT_LANGUAGE) {
    text = getNestedValue(DICTIONARIES[DEFAULT_LANGUAGE], key);
  }

  // Jika tetap tidak ditemukan, kembalikan key
  if (text === undefined) {
    return key;
  }

  if (typeof text !== "string") {
    return String(text);
  }

  // Interpolasi parameter {key}
  if (params && typeof params === "object") {
    return text.replace(/\{(\w+)\}/g, (match, paramName) => {
      return paramName in params ? String(params[paramName]) : match;
    });
  }

  return text;
}

function getNestedValue(obj, path) {
  if (!obj || typeof obj !== "object" || !path) return undefined;
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Resolves current language with priority:
 * 1. Query parameter (?lang=id | ?lang=en)
 * 2. Cookie 'zr_lang'
 * 3. SQLite settings key 'ui_language'
 * 4. Default: 'id'
 *
 * @param {import("hono").Context} c
 * @returns {string}
 */
export function resolveLanguage(c) {
  try {
    const queryLang = c.req.query("lang");
    if (queryLang && SUPPORTED_LANGUAGES.includes(queryLang.toLowerCase())) {
      return queryLang.toLowerCase();
    }
  } catch {
    // Abaikan error pembacaan query
  }

  try {
    const cookieLang = getCookie(c, "zr_lang");
    if (cookieLang && SUPPORTED_LANGUAGES.includes(cookieLang.toLowerCase())) {
      return cookieLang.toLowerCase();
    }
  } catch {
    // Abaikan error pembacaan cookie
  }

  try {
    const settingLang = getSetting("ui_language", DEFAULT_LANGUAGE);
    if (settingLang && SUPPORTED_LANGUAGES.includes(settingLang.toLowerCase())) {
      return settingLang.toLowerCase();
    }
  } catch {
    // Abaikan error pembacaan setting
  }

  return DEFAULT_LANGUAGE;
}

/**
 * Helper untuk membuat fungsi t terikat pada suatu bahasa tertentu
 * @param {string} lang
 * @returns {(key: string, params?: Record<string, any>) => string}
 */
export function createTranslator(lang = DEFAULT_LANGUAGE) {
  return (key, params) => t(key, params, lang);
}

export { id, en };
