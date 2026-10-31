/**
 * Pure DLP (Data Loss Prevention) module for Zenith Router.
 *
 * Scans and redacts credentials and API keys in outgoing request payloads.
 * Zero external dependencies, zero database/network/logger access.
 */

const CREDENTIAL_KEY_NAMES = new Set([
  "password",
  "passwd",
  "pwd",
  "token",
  "accesstoken",
  "authtoken",
  "refreshtoken",
  "apikey",
  "secret",
  "clientsecret",
  "signingsecret",
  // F-04: nama key yang biasa dipakai untuk kredensial cloud/DB.
  "awssecretaccesskey",
  "awssecretkey",
  "privatekey",
  "authorization",
  "databaseurl",
  "connectionstring",
]);

const PLACEHOLDER_WORDS = new Set([
  "example",
  "sample",
  "test",
  "dummy",
  "placeholder",
  "redacted",
  "masked",
  "changeme",
  "password",
  "secret",
  "token",
  "api_key",
  "api-key",
  "none",
  "null",
  "undefined",
]);

// Token pattern regexes (ReDoS safe: linear matching, no nested quantifiers)
const ANTHROPIC_KEY_RE = /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{16,}/g;
const OPENAI_KEY_RE = /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g;
const GITHUB_TOKEN_RE = /\b(?:gh[posur]_[A-Za-z0-9]{20,}|github_pat_\w{20,})\b/g;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g;
// F-04: AWS secret access key selalu mengikuti assignment bernama key.
const AWS_SECRET_KEY_RE = /(?:aws_secret_access_key|awssecretkey)[\"']?\s*[:=]\s*[\"']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi;
// F-04: Google API key dan token Slack.
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const SLACK_TOKEN_RE = /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g;
// F-04: URL berkredensial (postgres://user:pass@host/db, mongodb+srv://, redis://, ...).
const CREDENTIAL_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi;
// F-04: pola kalimat nalar manusia ("the password is ..."), bukan assignment.
const FREE_TEXT_PHRASE_RE =
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s+is\s+([\"']?)([^\s\"',;]{8,})\1/gi;
// F-04: header Authorization dengan skema Bearer/Basic/Token pada teks bebas.
// Nilai assignment biasa berhenti di spasi, sehingga token JWT ikut terlewat.
const AUTH_HEADER_RE = /\bAuthorization\s*[:=]\s*(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/-]{8,}={0,2})/gi;

// Private key blocks: complete and truncated (bounded header to avoid quadratic backtracking)
const PRIVATE_KEY_COMPLETE_RE =
  /-----BEGIN [A-Z0-9 _-]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 _-]{0,40}PRIVATE KEY-----/g;
const PRIVATE_KEY_TRUNCATED_RE = /-----BEGIN [A-Z0-9 _-]{0,40}PRIVATE KEY-----[\s\S]*/g;

// Free text credential assignments: key = value or key: value
const FREE_TEXT_ASSIGN_RE =
  /((?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+))\s*[:=]\s*)(?:(")([^"\r\n]*)(")|(')([^'\r\n]*)(')|(\$\{[^}]*\}|<[^>]*>|\[REDACTED:[^\]]+\]|[^\s,;'"}\]\)\r\n]+))/g;

const MAX_FIELD_LENGTH_FOR_LINE_SCAN = 1024 * 1024; // 1 MB

/**
 * Normalize an object key or identifier name to lowercase alphanumeric.
 */
function normalizeKey(key) {
  if (typeof key !== "string") return "";
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Check if a string value is a credential and NOT a placeholder.
 */
function isCredentialValue(rawVal, isQuoted = false) {
  if (typeof rawVal !== "string") return false;
  const val = rawVal.trim();
  if (val.length < 8) return false;

  // Quoted values containing spaces and length < 16 are not credentials
  if (isQuoted && val.includes(" ") && val.length < 16) {
    return false;
  }

  const valLower = val.toLowerCase();
  if (PLACEHOLDER_WORDS.has(valLower)) return false;
  if (valLower.startsWith("your-") || valLower.startsWith("your_") || valLower.startsWith("your ")) return false;
  if (/^[xX*]+$/.test(val)) return false;
  if (/^\[REDACTED:[^\]]+\]$/.test(val)) return false;
  if (val.startsWith("<") && val.endsWith(">")) return false;
  if (val.startsWith("${") && val.endsWith("}")) return false;
  if (/^process\.env\.[A-Za-z0-9_]+$/.test(val)) return false;

  return true;
}

/**
 * Media type biner: benar-benar bukan teks, aman dilewati.
 * F-04 dulu melewati SEMUA data:*;base64 sehingga rahasia yang dibungkus
 * data:text/plain;base64 lolos tanpa dipindai.
 */
const BINARY_MEDIA_RE = /^data:(?:image|audio|video|font)\/(?:x-)?[a-z0-9.+-]+/;
const DATA_URI_TEXT_RE =
  /^data:(text\/[a-z0-9.+-]+|application\/(?:json|xml|javascript|x-www-form-urlencoded));base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * Decode payload teks dari data URI (mis. data:text/plain;base64,...).
 * Mengembalikan null bila bukan data URI teks atau gagal decode.
 */
function decodeDataUriText(val) {
  if (typeof val !== "string") return null;
  const match = DATA_URI_TEXT_RE.exec(val.trim());
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[2].replace(/\s+/g, ""), "base64").toString("utf8");
    return { mime: match[1], text: decoded };
  } catch {
    return null;
  }
}

/**
 * Check if a value is binary or base64 data that should never be inspected.
 */
function isSafeNonText(val, key, parent) {
  if (!val) return false;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) return true;
  if (val instanceof Uint8Array || (typeof ArrayBuffer !== "undefined" && val instanceof ArrayBuffer)) return true;

  if (typeof val === "string") {
    if (BINARY_MEDIA_RE.test(val)) return true;
    if (parent && (parent.type === "base64" || parent.media_type) && key === "data") return true;
  }

  return false;
}

/**
 * Pola token spesifik F-04 yang bukan assignment biasa (key: value).
 * Dipakai bersama oleh deteksi, redaksi, dan hasSpecificToken.
 */
function detectSpecificTokens(str, foundTypes) {
  if (typeof str !== "string" || str.length === 0) return;

  if (/authorization\s*[:=]\s*(?:bearer|basic|token)\s/i.test(str)) {
    AUTH_HEADER_RE.lastIndex = 0;
    if (AUTH_HEADER_RE.test(str)) foundTypes.add("authorization_header");
  }
  if (str.includes("AIza")) {
    GOOGLE_API_KEY_RE.lastIndex = 0;
    if (GOOGLE_API_KEY_RE.test(str)) foundTypes.add("google_api_key");
  }
  if (/xox[abprs]-/i.test(str)) {
    SLACK_TOKEN_RE.lastIndex = 0;
    if (SLACK_TOKEN_RE.test(str)) foundTypes.add("slack_token");
  }
  if (/aws[_ ]?secret/i.test(str)) {
    AWS_SECRET_KEY_RE.lastIndex = 0;
    if (AWS_SECRET_KEY_RE.test(str)) foundTypes.add("aws_secret_key");
  }
  if (str.includes("://")) {
    CREDENTIAL_URL_RE.lastIndex = 0;
    const r = CREDENTIAL_URL_RE.test(str);
    if (r) foundTypes.add("credential_url");
  }
}

/**
 * Quick check if a string contains any specific token (non-credential-assignment) pattern.
 */
function hasSpecificToken(str) {
  if (typeof str !== "string" || str.length === 0) return false;
  if (str.includes("-----BEGIN")) {
    if (str.includes("-----END")) {
      PRIVATE_KEY_COMPLETE_RE.lastIndex = 0;
      if (PRIVATE_KEY_COMPLETE_RE.test(str)) return true;
    }
    PRIVATE_KEY_TRUNCATED_RE.lastIndex = 0;
    if (PRIVATE_KEY_TRUNCATED_RE.test(str)) return true;
  }
  if (str.includes("sk-ant-")) {
    ANTHROPIC_KEY_RE.lastIndex = 0;
    if (ANTHROPIC_KEY_RE.test(str)) return true;
  }
  if (str.includes("sk-")) {
    OPENAI_KEY_RE.lastIndex = 0;
    if (OPENAI_KEY_RE.test(str)) return true;
  }
  if (str.includes("gh") || str.includes("github_pat_")) {
    GITHUB_TOKEN_RE.lastIndex = 0;
    if (GITHUB_TOKEN_RE.test(str)) return true;
  }
  if (/(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)/.test(str)) {
    AWS_ACCESS_KEY_RE.lastIndex = 0;
    if (AWS_ACCESS_KEY_RE.test(str)) return true;
  }
  const extra = new Set();
  detectSpecificTokens(str, extra);
  return extra.size > 0;
}

/** Pola kalimat nalar manusia ("the password is ..."), bukan assignment key: value. */
function detectCredentialPhrase(str, foundTypes) {
  if (typeof str !== "string" || str.length === 0) return;
  FREE_TEXT_PHRASE_RE.lastIndex = 0;
  let match;
  while ((match = FREE_TEXT_PHRASE_RE.exec(str)) !== null) {
    const candidate = match[2];
    if (isCredentialValue(candidate, Boolean(match[1])) && !hasSpecificToken(candidate)) {
      foundTypes.add("credential_assignment");
    }
  }
}

/**
 * Scan a single string for secrets and collect detected types.
 */
function scanString(str, foundTypes) {
  if (typeof str !== "string" || str.length === 0) return;

  // F-04: payload teks dalam data:*;base64 dipindai setelah decode.
  const dataUri = decodeDataUriText(str);
  if (dataUri) {
    scanString(dataUri.text, foundTypes);
    return;
  }

  // 1. Private keys
  if (str.includes("-----BEGIN")) {
    if (str.includes("-----END")) {
      PRIVATE_KEY_COMPLETE_RE.lastIndex = 0;
      if (PRIVATE_KEY_COMPLETE_RE.test(str)) {
        foundTypes.add("private_key");
      }
    }
    if (!foundTypes.has("private_key")) {
      PRIVATE_KEY_TRUNCATED_RE.lastIndex = 0;
      if (PRIVATE_KEY_TRUNCATED_RE.test(str)) {
        foundTypes.add("private_key");
      }
    }
  }

  // 2. Anthropic API keys
  if (str.includes("sk-ant-")) {
    ANTHROPIC_KEY_RE.lastIndex = 0;
    if (ANTHROPIC_KEY_RE.test(str)) {
      foundTypes.add("anthropic_api_key");
    }
  }

  // 3. OpenAI API keys
  if (str.includes("sk-")) {
    OPENAI_KEY_RE.lastIndex = 0;
    if (OPENAI_KEY_RE.test(str)) {
      foundTypes.add("openai_api_key");
    }
  }

  // 4. GitHub tokens
  if (str.includes("gh") || str.includes("github_pat_")) {
    GITHUB_TOKEN_RE.lastIndex = 0;
    if (GITHUB_TOKEN_RE.test(str)) {
      foundTypes.add("github_token");
    }
  }

  // 5. AWS access keys
  if (/(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)/.test(str)) {
    AWS_ACCESS_KEY_RE.lastIndex = 0;
    if (AWS_ACCESS_KEY_RE.test(str)) {
      foundTypes.add("aws_access_key");
    }
  }

  // 6. Free text credential assignments (skip line scan on strings >= 1 MB)
  if (str.length < MAX_FIELD_LENGTH_FOR_LINE_SCAN) {
    if (/password|passwd|pwd|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|api[_-]?key|secret|client[_-]?secret|signing[_-]?secret/i.test(str)) {
      FREE_TEXT_ASSIGN_RE.lastIndex = 0;
      let match;
      while ((match = FREE_TEXT_ASSIGN_RE.exec(str)) !== null) {
        const rawKey = match[2] || match[3] || match[4];
        const normKey = normalizeKey(rawKey);
        if (CREDENTIAL_KEY_NAMES.has(normKey)) {
          let val = match[5] ? match[6] : match[8] ? match[9] : match[11];
          const isQuoted = Boolean(match[5] || match[8]);
          if (!isQuoted && val && val.endsWith(".") && !val.endsWith("..")) {
            val = val.slice(0, -1);
          }
          if (isCredentialValue(val, isQuoted) && !hasSpecificToken(val)) {
            foundTypes.add("credential_assignment");
          }
        }
      }
    }
  }

  // 7. F-04: token spesifik pada teks bebas (Google, Slack, AWS secret, URL berkredensial).
  detectSpecificTokens(str, foundTypes);

  // 8. F-04: pola kalimat nalar manusia seperti "the password is ...".
  detectCredentialPhrase(str, foundTypes);
}

/**
 * Redact secrets in a single string.
 * Returns { text, count }
 */
function redactString(str, foundTypes) {
  if (typeof str !== "string" || str.length === 0) {
    return { text: str, count: 0 };
  }

  // F-04: data URI teks di-decode, di-redaksi isinya, lalu di-encode ulang
  // agar rahasia yang dibungkus base64 juga tersapu.
  const dataUri = decodeDataUriText(str);
  if (dataUri) {
    const inner = redactString(dataUri.text, foundTypes);
    if (inner.count === 0) return { text: str, count: 0 };
    return {
      text: `data:${dataUri.mime};base64,${Buffer.from(inner.text, "utf8").toString("base64")}`,
      count: inner.count,
    };
  }

  let text = str;
  let count = 0;

  // 1. Private keys
  if (text.includes("-----BEGIN")) {
    if (text.includes("-----END")) {
      PRIVATE_KEY_COMPLETE_RE.lastIndex = 0;
      text = text.replace(PRIVATE_KEY_COMPLETE_RE, () => {
        count++;
        foundTypes.add("private_key");
        return "[REDACTED:private_key]";
      });
    }

    if (text.includes("-----BEGIN")) {
      PRIVATE_KEY_TRUNCATED_RE.lastIndex = 0;
      text = text.replace(PRIVATE_KEY_TRUNCATED_RE, () => {
        count++;
        foundTypes.add("private_key");
        return "[REDACTED:private_key]";
      });
    }
  }

  // 2. Anthropic API keys (must be processed before OpenAI keys)
  if (text.includes("sk-ant-")) {
    ANTHROPIC_KEY_RE.lastIndex = 0;
    text = text.replace(ANTHROPIC_KEY_RE, () => {
      count++;
      foundTypes.add("anthropic_api_key");
      return "[REDACTED:anthropic_api_key]";
    });
  }

  // 3. OpenAI API keys
  if (text.includes("sk-")) {
    OPENAI_KEY_RE.lastIndex = 0;
    text = text.replace(OPENAI_KEY_RE, () => {
      count++;
      foundTypes.add("openai_api_key");
      return "[REDACTED:openai_api_key]";
    });
  }

  // 4. GitHub tokens
  if (text.includes("gh") || text.includes("github_pat_")) {
    GITHUB_TOKEN_RE.lastIndex = 0;
    text = text.replace(GITHUB_TOKEN_RE, () => {
      count++;
      foundTypes.add("github_token");
      return "[REDACTED:github_token]";
    });
  }

  // 5. AWS access keys
  if (/(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)/.test(text)) {
    AWS_ACCESS_KEY_RE.lastIndex = 0;
    text = text.replace(AWS_ACCESS_KEY_RE, () => {
      count++;
      foundTypes.add("aws_access_key");
      return "[REDACTED:aws_access_key]";
    });
  }

  // 6. Free text credential assignments (skip line scan on strings >= 1 MB)
  if (text.length < MAX_FIELD_LENGTH_FOR_LINE_SCAN) {
    if (/password|passwd|pwd|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|api[_-]?key|secret|client[_-]?secret|signing[_-]?secret/i.test(text)) {
      FREE_TEXT_ASSIGN_RE.lastIndex = 0;
      text = text.replace(
        FREE_TEXT_ASSIGN_RE,
        (fullMatch, prefix, kDouble, kSingle, kPlain, qDoubleOpen, vDouble, qDoubleClose, qSingleOpen, vSingle, qSingleClose, vPlain) => {
          const rawKey = kDouble || kSingle || kPlain;
          const normKey = normalizeKey(rawKey);
          if (!CREDENTIAL_KEY_NAMES.has(normKey)) {
            return fullMatch;
          }

          const isQuoted = Boolean(qDoubleOpen || qSingleOpen);
          let val = qDoubleOpen ? vDouble : qSingleOpen ? vSingle : vPlain;
          let trailing = "";

          if (!isQuoted && val && val.endsWith(".") && !val.endsWith("..")) {
            val = val.slice(0, -1);
            trailing = ".";
          }

          if (!isCredentialValue(val, isQuoted)) {
            return fullMatch;
          }

          count++;
          foundTypes.add("credential_assignment");

          if (qDoubleOpen) {
            return `${prefix}"[REDACTED:credential_assignment]"`;
          }
          if (qSingleOpen) {
            return `${prefix}'[REDACTED:credential_assignment]'`;
          }
          return `${prefix}[REDACTED:credential_assignment]${trailing}`;
        }
      );
    }
  }

  // 7. F-04: token spesifik pada teks bebas (Google, Slack, AWS secret, URL berkredensial).
  if (/authorization\s*[:=]\s*(?:bearer|basic|token)\s/i.test(text)) {
    AUTH_HEADER_RE.lastIndex = 0;
    text = text.replace(AUTH_HEADER_RE, (full, secret) => {
      count++;
      foundTypes.add("authorization_header");
      return full.replace(secret, "[REDACTED:authorization_header]");
    });
  }
  if (text.includes("AIza")) {
    GOOGLE_API_KEY_RE.lastIndex = 0;
    text = text.replace(GOOGLE_API_KEY_RE, () => {
      count++;
      foundTypes.add("google_api_key");
      return "[REDACTED:google_api_key]";
    });
  }
  if (/xox[abprs]-/i.test(text)) {
    SLACK_TOKEN_RE.lastIndex = 0;
    text = text.replace(SLACK_TOKEN_RE, () => {
      count++;
      foundTypes.add("slack_token");
      return "[REDACTED:slack_token]";
    });
  }
  if (/aws[_ ]?secret/i.test(text)) {
    AWS_SECRET_KEY_RE.lastIndex = 0;
    text = text.replace(AWS_SECRET_KEY_RE, (full, secret) => {
      count++;
      foundTypes.add("aws_secret_key");
      return full.replace(secret, "[REDACTED:aws_secret_key]");
    });
  }
  if (text.includes("://")) {
    CREDENTIAL_URL_RE.lastIndex = 0;
    text = text.replace(CREDENTIAL_URL_RE, () => {
      count++;
      foundTypes.add("credential_url");
      return "[REDACTED:credential_url]";
    });
  }
  FREE_TEXT_PHRASE_RE.lastIndex = 0;
  text = text.replace(FREE_TEXT_PHRASE_RE, (full, quote, candidate) => {
    if (!isCredentialValue(candidate, Boolean(quote)) || hasSpecificToken(candidate)) {
      return full;
    }
    count++;
    foundTypes.add("credential_assignment");
    return full.replace(candidate, "[REDACTED:credential_assignment]");
  });

  return { text, count };
}

/**
 * Scan an arbitrary value recursively for secrets.
 *
 * @param {any} value
 * @returns {{ found: boolean, types: string[] }}
 */
export function scanForSecrets(value) {
  const foundTypes = new Set();
  const seen = new WeakSet();

  function traverse(val, key = null, parent = null) {
    if (val === null || val === undefined) return;

    if (isSafeNonText(val, key, parent)) return;

    if (typeof val === "string") {
      const trimmed = val.trim();
      // Check if string contains a JSON object or array
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === "object" && parsed !== null) {
            traverse(parsed);
            return;
          }
        } catch {}
      }
      scanString(val, foundTypes);
      return;
    }

    if (typeof val === "object") {
      if (seen.has(val)) return;
      seen.add(val);

      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          traverse(val[i], i, val);
        }
        return;
      }

      for (const prop of Object.keys(val)) {
        let propVal;
        try {
          propVal = val[prop];
        } catch {
          continue;
        }

        const normKey = normalizeKey(prop);

        // Check if object property itself is a credential key with a secret value
        if (CREDENTIAL_KEY_NAMES.has(normKey) && typeof propVal === "string" && !isSafeNonText(propVal, prop, val)) {
          if (isCredentialValue(propVal, true) && !hasSpecificToken(propVal)) {
            foundTypes.add("credential_assignment");
          }
        }

        traverse(propVal, prop, val);
      }
    }
  }

  traverse(value);

  const types = Array.from(foundTypes).sort();
  return {
    found: types.length > 0,
    types,
  };
}

/**
 * Redact secrets from an arbitrary value, returning a sanitized copy.
 * The input is NEVER mutated.
 *
 * If secrets still remain after redaction (e.g. adversarial nesting or
 * unredactable properties), returns { value: null, types, count } (fail-closed).
 *
 * @param {any} value
 * @returns {{ value: any, types: string[], count: number }}
 */
export function redactSecrets(value) {
  const foundTypes = new Set();
  const seen = new WeakMap();
  let totalCount = 0;

  function redact(val, key = null, parent = null) {
    if (val === null || val === undefined) return val;

    if (isSafeNonText(val, key, parent)) return val;

    if (typeof val === "string") {
      const trimmed = val.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === "object" && parsed !== null) {
            const beforeCount = totalCount;
            const innerRedacted = redact(parsed);
            if (totalCount > beforeCount) {
              // Secrets were redacted inside the parsed JSON; stringify result
              return JSON.stringify(innerRedacted);
            }
            // Nothing redacted; return original string verbatim
            return val;
          }
        } catch {}
      }

      const res = redactString(val, foundTypes);
      totalCount += res.count;
      return res.text;
    }

    if (typeof val === "object") {
      if (seen.has(val)) return seen.get(val);

      if (Array.isArray(val)) {
        const copy = [];
        seen.set(val, copy);
        for (let i = 0; i < val.length; i++) {
          copy.push(redact(val[i], i, val));
        }
        return copy;
      }

      const copy = {};
      seen.set(val, copy);

      // Check all own properties
      const props = Object.keys(val);
      for (const prop of props) {
        const desc = Object.getOwnPropertyDescriptor(val, prop);
        if (desc && desc.writable === false && typeof desc.value === "string") {
          // Non-writable property containing a secret cannot be safely modified
          Object.defineProperty(copy, prop, desc);
          totalCount++;
          continue;
        }

        let propVal;
        try {
          propVal = val[prop];
        } catch {
          continue;
        }

        const normKey = normalizeKey(prop);
        if (CREDENTIAL_KEY_NAMES.has(normKey) && typeof propVal === "string" && !isSafeNonText(propVal, prop, val)) {
          // Check if token patterns match first
          const tokenRes = redactString(propVal, foundTypes);
          if (tokenRes.count > 0) {
            totalCount += tokenRes.count;
            copy[prop] = tokenRes.text;
            continue;
          }

          if (isCredentialValue(propVal, true)) {
            totalCount++;
            foundTypes.add("credential_assignment");
            copy[prop] = "[REDACTED:credential_assignment]";
            continue;
          }
        }

        copy[prop] = redact(propVal, prop, val);
      }

      return copy;
    }

    return val;
  }

  const redactedValue = redact(value);
  const types = Array.from(foundTypes).sort();

  // Fail-closed verification: re-scan the redacted output
  if (totalCount > 0) {
    const postScan = scanForSecrets(redactedValue);
    if (postScan.found) {
      return {
        value: null,
        types: Array.from(new Set([...types, ...postScan.types])).sort(),
        count: totalCount,
      };
    }
  }

  return {
    value: redactedValue,
    types,
    count: totalCount,
  };
}

/**
 * Normalize DLP mode from setting value or settings object.
 *
 * @param {string|object} settings
 * @returns {"off" | "redact" | "block"}
 */
export function dlpModeFrom(settings) {
  let mode = "";
  if (typeof settings === "string") {
    mode = settings.toLowerCase().trim();
  } else if (settings && typeof settings === "object") {
    const raw = settings.dlp_mode || settings.dlpMode || "";
    mode = String(raw).toLowerCase().trim();
  }

  if (mode === "redact") return "redact";
  if (mode === "block") return "block";
  return "off";
}
