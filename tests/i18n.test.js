import test from "node:test";
import assert from "node:assert/strict";
import { t, resolveLanguage, sanitizeRedirect, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, id, en } from "../src/ui/i18n/index.js";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { renderSettingsPage } from "../src/ui/pages/settings.js";
import { renderOverviewPage } from "../src/ui/pages/overview.js";
import { renderDlpPage } from "../src/ui/pages/dlp.js";

test("i18n: translation fallback and parameter interpolation", () => {
  // Test basic translation
  assert.equal(t("common.dashboard", {}, "id"), "Dashboard");
  assert.equal(t("common.dashboard", {}, "en"), "Dashboard");

  // Test difference between id and en
  assert.equal(t("common.save", {}, "id"), "Simpan");
  assert.equal(t("common.save", {}, "en"), "Save");

  // Test fallback to id if missing in en
  assert.equal(t("non_existent_key", {}, "en"), "non_existent_key");

  // Test fallback for unsupported language
  assert.equal(t("common.save", {}, "fr"), "Simpan");
});

test("i18n: dictionary structure parity between id and en", () => {
  function getKeys(obj, prefix = "") {
    let keys = [];
    for (const [k, v] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") {
        keys.push(...getKeys(v, fullPath));
      } else {
        keys.push(fullPath);
      }
    }
    return keys;
  }

  const idKeys = getKeys(id).sort();
  const enKeys = getKeys(en).sort();

  // All keys in ID must exist in EN
  for (const k of idKeys) {
    assert.ok(enKeys.includes(k), `Key '${k}' in id.js missing in en.js`);
  }
  // All keys in EN must exist in ID
  for (const k of enKeys) {
    assert.ok(idKeys.includes(k), `Key '${k}' in en.js missing in id.js`);
  }
});

test("i18n: resolveLanguage priority and query persistence", () => {
  // 1. Query parameter + sets cookie
  const responseHeaders = new Map();
  const mockContextWithQuery = {
    req: {
      query: (key) => (key === "lang" ? "en" : undefined),
    },
    header: (name, val, opts) => {
      if (opts?.append) {
        const cur = responseHeaders.get(name) || [];
        responseHeaders.set(name, [...cur, val]);
      } else {
        responseHeaders.set(name, [val]);
      }
    },
  };
  assert.equal(resolveLanguage(mockContextWithQuery), "en");
  const setCookies = responseHeaders.get("Set-Cookie") || [];
  assert.ok(
    setCookies.some((cookie) => cookie.includes("zr_lang=en")),
    "resolveLanguage harus menyetel cookie zr_lang saat query parameter ada"
  );

  // 2. Fallback to default
  const emptyContext = {
    req: {
      query: () => undefined,
    },
  };
  assert.equal(resolveLanguage(emptyContext), DEFAULT_LANGUAGE);
});

test("i18n: sanitizeRedirect prevents open-redirect vulnerabilities", () => {
  const reqUrl = "http://127.0.0.1:20120/dashboard/language";

  // Relative paths valid
  assert.equal(sanitizeRedirect("/dashboard/settings", reqUrl), "/dashboard/settings");
  assert.equal(sanitizeRedirect("/dashboard/providers?tab=combos", reqUrl), "/dashboard/providers?tab=combos");

  // Open redirect attempts: external URLs, protocol-relative, backslashes, javascript:
  assert.equal(sanitizeRedirect("https://evil.example/phish", reqUrl), "/dashboard");
  assert.equal(sanitizeRedirect("http://attacker.com", reqUrl), "/dashboard");
  assert.equal(sanitizeRedirect("//evil.example", reqUrl), "/dashboard");
  assert.equal(sanitizeRedirect("/\\evil.example", reqUrl), "/dashboard");
  assert.equal(sanitizeRedirect("javascript:alert(1)", reqUrl), "/dashboard");
  assert.equal(sanitizeRedirect("data:text/html,test", reqUrl), "/dashboard");
  assert.equal(sanitizeRedirect("/dashboard\r\nLocation: evil.com", reqUrl), "/dashboard");

  // Same-origin absolute URL (misal dari Referer valid)
  assert.equal(
    sanitizeRedirect("http://127.0.0.1:20120/dashboard/usage", reqUrl),
    "/dashboard/usage"
  );
  // Cross-origin absolute URL (Referer asing)
  assert.equal(
    sanitizeRedirect("https://foreign-host.com/dashboard/usage", reqUrl),
    "/dashboard"
  );

  // Fallback default
  assert.equal(sanitizeRedirect(null, reqUrl), "/dashboard");
  assert.equal(sanitizeRedirect("", reqUrl, "/custom-fallback"), "/custom-fallback");
});

test("i18n: renderSettingsPage language select matches resolved session language", () => {
  initDb(":memory:");
  // Even if DB has ui_language='id', browsing with lang='en' must select 'en' option
  setSetting("ui_language", "id");

  const htmlEn = renderSettingsPage(20120, {}, "en");
  assert.match(
    htmlEn,
    /<option value="en" selected>English<\/option>/,
    "Option English harus terpilih saat lang='en'"
  );
  assert.doesNotMatch(
    htmlEn,
    /<option value="id" selected>/,
    "Option Indonesian tidak boleh terpilih saat lang='en'"
  );

  const htmlId = renderSettingsPage(20120, {}, "id");
  assert.match(
    htmlId,
    /<option value="id" selected>Bahasa Indonesia<\/option>/,
    "Option Bahasa Indonesia harus terpilih saat lang='id'"
  );
});

test("i18n: renderOverviewPage and renderDlpPage localize placeholders and subtitles", () => {
  initDb(":memory:");

  // Check Overview Page in EN vs ID
  const overviewEn = renderOverviewPage(20120, "en");
  assert.ok(overviewEn.includes('placeholder="Filter logs..."'), "placeholder filter log harus localized ke English");
  assert.ok(overviewEn.includes("Active Connections"), "metrik harus localized ke English");
  assert.ok(overviewEn.includes("Client Integration Endpoints"), "subtitle/header harus localized ke English");

  const overviewId = renderOverviewPage(20120, "id");
  assert.ok(overviewId.includes('placeholder="Saring log..."'), "placeholder filter log harus Bahasa Indonesia");
  assert.ok(overviewId.includes("Koneksi Aktif"), "metrik harus Bahasa Indonesia");

  // Check DLP Page in EN vs ID
  const dlpEn = renderDlpPage(20120, {}, "en");
  assert.ok(dlpEn.includes("Scan outbound request payloads"), "subtitle DLP harus localized ke English");
  assert.ok(dlpEn.includes("Disabled (Off)"), "option mode DLP harus localized ke English");

  const dlpId = renderDlpPage(20120, {}, "id");
  assert.ok(dlpId.includes("Pindai isi request keluar"), "subtitle DLP harus Bahasa Indonesia");
  assert.ok(dlpId.includes("Nonaktif (Off)"), "option mode DLP harus Bahasa Indonesia");
});
