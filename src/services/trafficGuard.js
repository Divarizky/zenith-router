import { randomInt } from "node:crypto";
import { getSetting } from "./settings.js";
import { getProvider } from "../providers/index.js";
import { getConnectionById, getConnections } from "../db/index.js";

// The queue holds a request for a whole turn of the agent loop. Main requests
// get that long; auxiliary calls (session titles, memory jobs) give up early so
// they can never occupy a slot a conversation is waiting for.
const QUEUE_TIMEOUT_MS = 30000;
const AUX_QUEUE_TIMEOUT_MS = 2000;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;

// In-memory state tracking per connection ID
const connectionState = new Map();
// In-flight count per provider. Virtual (no-auth) connections carry no id, so they
// never occupy a connection slot, but the topology still has to see their traffic.
const providerState = new Map();

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_CONCURRENCY) return null;
  return Math.min(n, MAX_CONCURRENCY);
}

/**
 * Parallel cap for one account of a provider. Resolution order: the per-provider
 * setting, the registry field, then the global cap. A provider without either
 * keeps the old global behavior.
 */
export function resolveProviderConcurrency(providerId) {
  const key = String(providerId || "").toLowerCase();
  if (!key) return null;

  const configured = clampConcurrency(getSetting(`provider_concurrency:${key}`, ""));
  if (configured !== null) return configured;

  const declared = clampConcurrency(getProvider(key)?.concurrency);
  if (declared !== null) return declared;

  return null;
}

/**
 * Minimum cool-off in ms between requests on one account of a provider.
 */
export function resolveProviderThrottle(providerId) {
  const key = String(providerId || "").toLowerCase();
  if (!key) return null;

  const raw = getSetting(`provider_throttle_ms:${key}`, "");
  if (raw !== "") {
    const configured = Number(raw);
    if (Number.isFinite(configured) && configured >= 0) return configured;
  }

  const declared = Number(getProvider(key)?.throttleMs);
  if (Number.isFinite(declared) && declared >= 0) return declared;

  return null;
}

/**
 * Throttle interval in ms for one account before it can dispatch its next turn.
 */
export function effectiveAccountThrottle(connection) {
  const providerThrottle = resolveProviderThrottle(connection?.provider);
  if (providerThrottle !== null) return providerThrottle;
  return 0;
}

/**
 * Cap for one account, resolved once so the limiter and the dashboard agree.
 * The registry/global value is clamped the same way acquireAccountSlot does it.
 */
export function effectiveAccountConcurrency(connection) {
  const providerConcurrency = resolveProviderConcurrency(connection?.provider);
  return Math.max(
    MIN_CONCURRENCY,
    providerConcurrency ?? (Number(getSetting("max_account_concurrency", connection?.auth_type === "oauth" ? "2" : "8")) || 2)
  );
}

function enterProviderSlot(providerId) {
  const key = String(providerId || "").toLowerCase();
  if (!key) return () => {};
  providerState.set(key, (providerState.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (providerState.get(key) || 0) - 1;
    if (next > 0) providerState.set(key, next);
    else providerState.delete(key);
  };
}

function getState(connId) {
  if (!connectionState.has(connId)) {
    connectionState.set(connId, {
      inFlight: 0,
      queue: [],
      lastDispatchedAt: 0,
    });
  }
  return connectionState.get(connId);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Request aborted during traffic guard delay"));
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Request aborted during traffic guard delay"));
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Acquire an execution slot for the given connection.
 * Respects max concurrency cap and applies human-like jitter pacing when needed.
 * Returns a release callback to be called when the request finishes.
 */
export async function acquireAccountSlot(connection, signal = null, { purpose = "main" } = {}) {
  if (!connection) {
    return () => {};
  }

  const isGuardEnabled = getSetting("traffic_guard_enabled", "true") === "true";
  // Virtual (no-auth) connections have no id and skip the concurrency guard, but they
  // still report as in-flight so the router topology shows the provider actually serving.
  if (!connection.id || !isGuardEnabled) {
    return enterProviderSlot(connection.provider);
  }

  // API key connections typically have higher limits; traffic guard focuses primarily on OAuth connections.
  // A provider that declares its own cap (DeepSeek web sessions, for example) overrides that global value.
  const maxConcurrency = effectiveAccountConcurrency(connection);
  const minThrottleMs = effectiveAccountThrottle(connection);
  const isJitterEnabled = getSetting("request_jitter_enabled", "true") === "true";
  const isAux = purpose === "aux";
  const queueTimeoutMs = isAux ? Math.max(AUX_QUEUE_TIMEOUT_MS, minThrottleMs + 2000) : QUEUE_TIMEOUT_MS;

  const state = getState(connection.id);

  // At the cap, wait in the queue. A waiter is woken by releaseAccountSlot,
  // which hands over its slot without decrementing inFlight, so a request
  // arriving in between cannot take the slot as well and exceed the cap.
  if (state.inFlight >= maxConcurrency) {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new Error("Request aborted while waiting in account queue"));
      }

      let timeoutTimer = null;
      let onAbort = null;

      const item = {
        purpose,
        resolve: () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (err) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      };

      onAbort = () => {
        const idx = state.queue.indexOf(item);
        if (idx !== -1) state.queue.splice(idx, 1);
        item.reject(new Error("Request aborted while waiting in account queue"));
      };

      // Aux waiters are dropped early instead of holding a conversation's place
      // in line for the full turn of the agent loop.
      timeoutTimer = setTimeout(() => {
        const idx = state.queue.indexOf(item);
        if (idx !== -1) state.queue.splice(idx, 1);
        item.reject(
          new Error(
            isAux
              ? `Auxiliary request gave up waiting for a free slot (${queueTimeoutMs / 1000}s) on connection ${connection.id}`
              : `Account concurrency queue timeout (${queueTimeoutMs / 1000}s) for connection ${connection.id}`
          )
        );
      }, queueTimeoutMs);

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (isAux) {
        state.queue.push(item);
      } else {
        // Main requests take the place of the first aux waiter, never the other way around.
        const firstAux = state.queue.findIndex((waiter) => waiter.purpose === "aux");
        if (firstAux === -1) state.queue.push(item);
        else state.queue.splice(firstAux, 0, item);
      }
    });
  } else {
    state.inFlight++;
  }

  const releaseProviderSlot = enterProviderSlot(connection.provider);

  // Apply provider-level throttle minimum (e.g. 3s for web session chats)
  // or human-like proactive jitter pacing if previous request just finished (< 250ms ago).
  if (minThrottleMs > 0 && state.lastDispatchedAt > 0) {
    const elapsed = Date.now() - state.lastDispatchedAt;
    if (elapsed < minThrottleMs) {
      try {
        await delay(minThrottleMs - elapsed, signal);
      } catch (err) {
        releaseAccountSlot(connection.id);
        releaseProviderSlot();
        throw err;
      }
    }
  } else if (isJitterEnabled && state.lastDispatchedAt > 0) {
    const elapsedSinceLast = Date.now() - state.lastDispatchedAt;
    if (elapsedSinceLast < 250) {
      const jitterMs = randomInt(100, 300);
      try {
        await delay(jitterMs, signal);
      } catch (err) {
        releaseAccountSlot(connection.id);
        releaseProviderSlot();
        throw err;
      }
    }
  }

  state.lastDispatchedAt = Date.now();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseProviderSlot();
    releaseAccountSlot(connection.id);
  };
}

/**
 * Release an in-flight slot for the given connection ID. With a request
 * waiting, the slot passes straight to it and inFlight stays the same.
 */
export function releaseAccountSlot(connId) {
  if (!connId) return;
  const state = getState(connId);
  state.lastDispatchedAt = Date.now();

  const nextItem = state.queue.shift();
  if (nextItem) {
    nextItem.resolve();
  } else {
    state.inFlight = Math.max(0, state.inFlight - 1);
  }
}

/**
 * Apply short reactive jitter during failover/retry
 */
export async function applyReactiveJitter(signal = null) {
  const isJitterEnabled = getSetting("request_jitter_enabled", "true") === "true";
  if (!isJitterEnabled) return;
  const jitterMs = randomInt(50, 150);
  await delay(jitterMs, signal);
}

/**
 * Reset traffic guard in-memory state (useful in unit tests)
 */
export function resetTrafficGuardState() {
  connectionState.clear();
  providerState.clear();
}

/**
 * Providers with at least one request currently in flight.
 */
export function getActiveProviders() {
  const active = new Set();
  for (const [connId, state] of connectionState) {
    if (state.inFlight > 0) {
      try {
        const conn = getConnectionById(connId);
        if (conn?.provider) active.add(String(conn.provider).toLowerCase());
      } catch {}
    }
  }
  // Virtual connections never show up above, so count providers directly too.
  for (const providerId of providerState.keys()) active.add(providerId);
  return active;
}

/**
 * Live traffic for one account. Reads the existing state without creating it, so
 * a dashboard refresh cannot inflate the maps.
 */
export function getConnectionTraffic(connId) {
  const state = connectionState.get(connId);
  return { inFlight: state?.inFlight || 0, queue: state?.queue.length || 0 };
}

/**
 * Live traffic for one provider: per-account slot usage, the aggregate, and the
 * queue. `cap` is the provider-wide ceiling (per-account cap times the number of
 * accounts); `perAccountCap` is what one conversation competes for.
 */
export function getProviderTraffic(providerId) {
  const key = String(providerId || "").toLowerCase();
  if (!key) return { provider: "", inFlight: 0, queue: 0, cap: 0, perAccountCap: 0, accounts: [] };

  const accounts = getConnections(key).map((connection) => ({
    id: connection.id,
    name: connection.name,
    ...getConnectionTraffic(connection.id),
    cap: effectiveAccountConcurrency(connection),
  }));

  const inFlight = accounts.reduce((total, account) => total + account.inFlight, 0);
  const queue = accounts.reduce((total, account) => total + account.queue, 0);
  // Virtual (no-auth) connections have no account row; their traffic still counts.
  const virtual = accounts.length === 0 ? providerState.get(key) || 0 : 0;
  const perAccountCap = accounts.length > 0 ? accounts[0].cap : 0;

  return {
    provider: key,
    inFlight: inFlight + virtual,
    queue,
    cap: perAccountCap * accounts.length,
    perAccountCap,
    accounts,
  };
}
