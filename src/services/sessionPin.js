/**
 * Session account pin: keeps one client conversation on the account that served
 * its last successful request, so the upstream prompt cache stays warm across
 * turns. Rotating accounts between turns forces a cache miss on every turn.
 *
 * In-memory only and bounded: entries expire after the TTL of inactivity and the
 * map is capped at `maxSessions` with least-recently-used eviction. A restart
 * clears every pin, which is intended.
 *
 * The TTL is read at call time, so a runtime setting takes effect without a
 * restart. Keys are hashed before they enter the map, so raw session identifiers
 * are not held here.
 *
 * Namespaces: a pin key is scoped by `scope` ("client" for a real client session,
 * "apikey" for a local gateway-key identity). Both are opaque local labels that
 * are hashed in with the provider and session key; they are never sent upstream.
 */
import { createHash } from "node:crypto";
import { getSetting } from "./settings.js";

export const SESSION_PIN_TTL_MS = 15 * 60 * 1000;
export const SESSION_PIN_MAX_SESSIONS = 256;
export const SESSION_PIN_TTL_SETTING = "session_pin_ttl_minutes";

export const PIN_SCOPE_CLIENT = "client";
export const PIN_SCOPE_APIKEY = "apikey";

function pinKey(scope, providerId, sessionKey) {
  return createHash("sha256")
    .update(`${scope}\u0000${providerId}\u0000${sessionKey}`)
    .digest("hex");
}

/**
 * TTL in ms from the `session_pin_ttl_minutes` setting. Missing, empty, or
 * non-positive values fall back to the default; the value is clamped to 1..1440 minutes.
 */
export function sessionPinTtlFromSettings() {
  const raw = Number(getSetting(SESSION_PIN_TTL_SETTING, ""));
  if (!Number.isFinite(raw) || raw <= 0) return SESSION_PIN_TTL_MS;
  return Math.min(Math.max(raw, 1), 1440) * 60 * 1000;
}

/**
 * Creates a pin store. `ttlMs` may be a number or a function returning the TTL,
 * so it can follow runtime configuration. `now` is injectable for tests.
 */
export function createSessionPinStore({
  ttlMs = SESSION_PIN_TTL_MS,
  maxSessions = SESSION_PIN_MAX_SESSIONS,
  now = () => Date.now(),
} = {}) {
  const pins = new Map();
  const ttl = () => (typeof ttlMs === "function" ? ttlMs() : ttlMs);

  function prune() {
    const t = now();
    const limit = ttl();
    for (const [key, entry] of pins) {
      if (t - entry.lastUsed > limit) pins.delete(key);
    }
  }

  return {
    /**
     * Connection id pinned for this session, or null when there is no live pin.
     * An expired entry is removed here (lazy expiry).
     */
    get(providerId, sessionKey, model = null, scope = PIN_SCOPE_CLIENT) {
      if (!sessionKey) return null;
      const key = pinKey(scope, providerId, sessionKey);
      const entry = pins.get(key);
      if (!entry) return null;
      if (now() - entry.lastUsed > ttl()) {
        pins.delete(key);
        return null;
      }
      if (model && entry.model !== model) return null;
      return entry.connectionId;
    },

    /** Record the account that just served this session. Refreshes the TTL and recency. */
    set(providerId, sessionKey, connectionId, model = null, scope = PIN_SCOPE_CLIENT) {
      if (!sessionKey || connectionId === null || connectionId === undefined) return;
      const key = pinKey(scope, providerId, sessionKey);
      pins.delete(key);
      pins.set(key, { connectionId, model, lastUsed: now() });
      prune();
      while (pins.size > maxSessions) pins.delete(pins.keys().next().value);
    },

    /** Drop a pin, e.g. after its account failed or was removed. */
    drop(providerId, sessionKey, scope = PIN_SCOPE_CLIENT) {
      if (!sessionKey) return;
      pins.delete(pinKey(scope, providerId, sessionKey));
    },

    /** Drop every pin that points at a connection (used when the account is deleted). */
    dropConnection(connectionId) {
      for (const [key, entry] of pins) {
        if (entry.connectionId === connectionId) pins.delete(key);
      }
    },

    size() {
      return pins.size;
    },

    clear() {
      pins.clear();
    },
  };
}

/** Process-wide store used by the fallback router. TTL follows the runtime setting. */
export const sessionPins = createSessionPinStore({ ttlMs: sessionPinTtlFromSettings });
