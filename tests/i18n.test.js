import test from "node:test";
import assert from "node:assert/strict";
import { t, resolveLanguage, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, id, en } from "../src/ui/i18n/index.js";

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

test("i18n: resolveLanguage priority", () => {
  // 1. Query parameter
  const mockContextWithQuery = {
    req: {
      query: (key) => (key === "lang" ? "en" : undefined),
    },
  };
  assert.equal(resolveLanguage(mockContextWithQuery), "en");

  // 2. Fallback to default
  const emptyContext = {
    req: {
      query: () => undefined,
    },
  };
  assert.equal(resolveLanguage(emptyContext), DEFAULT_LANGUAGE);
});
