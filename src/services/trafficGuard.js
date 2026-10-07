import { randomInt } from "node:crypto";
import { getSetting } from "./settings.js";

// In-memory state tracking per connection ID
const connectionState = new Map();

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
export async function acquireAccountSlot(connection, signal = null) {
  if (!connection || !connection.id) {
    return () => {};
  }

  const isGuardEnabled = getSetting("traffic_guard_enabled", "true") === "true";
  if (!isGuardEnabled) {
    return () => {};
  }

  // API key connections typically have higher limits; traffic guard focuses primarily on OAuth connections
  const maxConcurrency = Math.max(
    1,
    Number(getSetting("max_account_concurrency", connection.auth_type === "oauth" ? "2" : "8")) || 2
  );
  const isJitterEnabled = getSetting("request_jitter_enabled", "true") === "true";

  const state = getState(connection.id);

  // If already at max concurrency, queue the request
  if (state.inFlight >= maxConcurrency) {
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new Error("Request aborted while waiting in account queue"));
      }

      let timeoutTimer = null;
      let onAbort = null;

      const item = {
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

      // 30s timeout waiting in queue
      timeoutTimer = setTimeout(() => {
        const idx = state.queue.indexOf(item);
        if (idx !== -1) state.queue.splice(idx, 1);
        item.reject(new Error(`Account concurrency queue timeout (30s) for connection ${connection.id}`));
      }, 30000);

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      state.queue.push(item);
    });
  }

  state.inFlight++;

  // Apply human-like proactive jitter pacing if previous request just finished (< 250ms ago)
  if (isJitterEnabled && state.lastDispatchedAt > 0) {
    const elapsedSinceLast = Date.now() - state.lastDispatchedAt;
    if (elapsedSinceLast < 250) {
      const jitterMs = randomInt(100, 300);
      try {
        await delay(jitterMs, signal);
      } catch (err) {
        releaseAccountSlot(connection.id);
        throw err;
      }
    }
  }

  state.lastDispatchedAt = Date.now();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseAccountSlot(connection.id);
  };
}

/**
 * Release an in-flight slot for the given connection ID
 */
export function releaseAccountSlot(connId) {
  if (!connId) return;
  const state = getState(connId);
  state.inFlight = Math.max(0, state.inFlight - 1);
  state.lastDispatchedAt = Date.now();

  if (state.queue.length > 0 && state.inFlight < 100) {
    const nextItem = state.queue.shift();
    if (nextItem) {
      nextItem.resolve();
    }
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
}
