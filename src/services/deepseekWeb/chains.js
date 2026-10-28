/**
 * Active upstream chat sessions ("chains") for stateful web providers.
 *
 * A web chat provider keeps one server-side conversation per chain, so the
 * router has to remember which chain maps to which session and bound how many
 * live sessions one account may hold. The bounds follow the parallel cap from
 * trafficGuard: a provider capped at three parallel requests may keep three
 * main conversations plus a small number of auxiliary ones (session titles,
 * memory jobs).
 *
 * Eviction favours auxiliary chains: they are cheap to rebuild, while dropping
 * a main chain resets a conversation and forces a full prompt render on its
 * next turn. A chain that is mid-request is never evicted; if every chain is
 * busy the pool is allowed to overflow until one goes idle.
 */
import { createHash } from "node:crypto";
import { getSetting } from "../settings.js";
import { resolveProviderConcurrency } from "../trafficGuard.js";

export const CHAIN_TTL_MS = 6 * 60 * 60 * 1000;
export const CHAIN_MAIN_IDLE_MS = 30 * 60 * 1000;
export const MAX_AUX_CHAINS = 2;

/**
 * Chain identity: one account, one purpose, one client session, one
 * conversation. Two clients never share a chain, and neither do a conversation
 * and its session title. `conversation` keeps apart conversations that arrive
 * under the same session key: subagents inherit the parent's Claude Code
 * session id, and clients without a session header all fall back to the API
 * key. Sharing one chain would serialise them and reset the chat on every
 * switch.
 */
export function buildChainKey({ connectionId, purpose = "main", sessionKey = null, conversation = null }) {
  const account = connectionId === null || connectionId === undefined ? "-" : String(connectionId);
  const kind = purpose === "aux" ? `aux:${sessionKey || "-"}` : `main:${sessionKey || "-"}`;
  return conversation ? `${account}|${kind}|${conversation}` : `${account}|${kind}`;
}

/**
 * Session bounds for one account: how many server-side conversations may stay
 * warm, not how many turns may run at once. The traffic guard owns the latter
 * and may pin it to one (serialTurns), while this pool stays at the declared
 * concurrency; collapsing the two would evict a conversation every time two
 * sessions alternate and force a full prompt re-render.
 */
export function resolveChainLimits(connection) {
  const providerCap = resolveProviderConcurrency(connection?.provider);
  const globalCap =
    Number(getSetting("max_account_concurrency", connection?.auth_type === "oauth" ? "2" : "8")) || 2;
  return {
    main: Math.max(1, providerCap ?? globalCap),
    aux: MAX_AUX_CHAINS,
  };
}

function isOverTtl(chain, now) {
  return now - chain.lastUsedAt > CHAIN_TTL_MS;
}

/**
 * The part of a message that identifies it. Volatile fields added by the
 * translator (cache markers, provider hints) are ignored so a request that is
 * semantically the same never looks like an edited history.
 */
function canonicalMessage(message) {
  const content = message?.content;
  let normalizedContent = content ?? "";
  if (Array.isArray(content)) {
    normalizedContent = content.map((part) => {
      if (typeof part === "string") return { type: "text", text: part };
      return { type: part?.type ?? "text", text: part?.text ?? null };
    });
  }
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((call) => ({
        id: call?.id ?? null,
        name: call?.function?.name ?? call?.name ?? null,
        arguments: call?.function?.arguments ?? call?.arguments ?? null,
      }))
    : null;
  return {
    role: message?.role ?? "",
    content: normalizedContent,
    name: message?.name ?? null,
    tool_call_id: message?.tool_call_id ?? null,
    tool_calls: toolCalls,
  };
}

/** Stable short hash of one message, used as the conversation watermark. */
export function messageFingerprint(message) {
  if (!message) return "";
  return createHash("sha256").update(JSON.stringify(canonicalMessage(message))).digest("hex").slice(0, 16);
}

/**
 * Stable hash of the tool catalog. The web chat keeps the catalog it was first
 * shown, so a changed catalog needs a fresh chat. Order is ignored, since clients
 * may list the same tools in a different order.
 */
export function toolsFingerprint(tools) {
  const list = Array.isArray(tools) ? tools : [];
  if (list.length === 0) return "";
  const entries = list.map((tool) => {
    const fn = tool?.function || tool || {};
    return JSON.stringify({ name: fn.name ?? "", description: fn.description ?? "", parameters: fn.parameters ?? null });
  });
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Which conversation a request belongs to: the first message after the system
 * prompt. It stays fixed for the life of a conversation, while the system
 * prompt may carry per-turn details (dates, git status) in some harnesses.
 */
export function conversationId(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list.find((message) => message?.role !== "system" && message?.role !== "developer");
  return first ? messageFingerprint(first).slice(0, 12) : null;
}

/**
 * Decide what to send upstream for this turn. The watermark is the number of
 * messages forwarded on the previous turn plus the fingerprint of the last one:
 * if the harness edited, rolled back, or replaced the conversation, the anchor
 * no longer matches and the chain starts a fresh chat session.
 */
export function evaluateChain(chain, messages, tools = null) {
  const list = Array.isArray(messages) ? messages : [];
  const catalog = toolsFingerprint(tools);
  const full = {
    action: "reset",
    delta: list,
    count: list.length,
    fingerprint: messageFingerprint(list[list.length - 1]),
    toolsFingerprint: catalog,
  };

  if (!chain) return { ...full, reason: "new_chain" };
  if (chain.dirty) return { ...full, reason: "dirty" };
  if ((chain.toolsFingerprint ?? "") !== catalog) return { ...full, reason: "tools_changed" };
  if (list.length < chain.count) return { ...full, reason: "history_shrank" };

  const anchor = list[chain.count - 1];
  if (!anchor || messageFingerprint(anchor) !== chain.fingerprint) {
    return { ...full, reason: "diverged" };
  }

  // Same history as last time: the previous turn may or may not have reached
  // the upstream, so a full render is the only safe option.
  if (list.length === chain.count) return { ...full, reason: "no_new_messages" };

  return {
    action: "continue",
    reason: null,
    delta: list.slice(chain.count),
    count: list.length,
    fingerprint: messageFingerprint(list[list.length - 1]),
    toolsFingerprint: catalog,
  };
}

function isIdleOver(chain, now, idleMs) {
  return now - chain.lastUsedAt > idleMs;
}

/** Least recently used first, ignoring chains that are mid-request. */
function byAge(candidates) {
  return candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
}

/**
 * A store instance exists so tests can control the clock. Production uses the
 * module-level singleton exported at the bottom of this file.
 */
export function createChainStore({ now = () => Date.now() } = {}) {
  const chains = new Map();
  // One promise tail per chain: turns on the same chain run one at a time so
  // two requests cannot both advance parent_message_id from the same state.
  const locks = new Map();

  const forConnection = (connectionId) => {
    const account = String(connectionId);
    const result = [];
    for (const chain of chains.values()) {
      if (String(chain.connectionId) === account) result.push(chain);
    }
    return result;
  };

  const drop = (keys, evicted) => {
    for (const key of keys) {
      const chain = chains.get(key);
      if (!chain) continue;
      chains.delete(key);
      evicted.push(chain);
    }
  };

  function sweep() {
    const moment = now();
    const evicted = [];
    const expired = [];
    for (const chain of chains.values()) {
      if (!chain.busy && isOverTtl(chain, moment)) expired.push(chain.key);
    }
    drop(expired, evicted);
    return evicted;
  }

  function get(key) {
    return chains.get(key) || null;
  }

  function list(connectionId) {
    return connectionId === undefined ? [...chains.values()] : forConnection(connectionId);
  }

  function stats(connectionId) {
    const scoped = connectionId === undefined ? [...chains.values()] : forConnection(connectionId);
    let main = 0;
    let aux = 0;
    let busy = 0;
    for (const chain of scoped) {
      if (chain.purpose === "aux") aux++;
      else main++;
      if (chain.busy) busy++;
    }
    return { main, aux, busy, total: scoped.length };
  }

  /**
   * Register a chain and enforce the account's session bounds. Returns the
   * evicted chains so the caller can log them; `overflow` means every candidate
   * was mid-request, so the bounds could not be honoured this time.
   */
  function register({
    connection = null,
    purpose = "main",
    sessionKey = null,
    conversation = null,
    chatSessionId = null,
    parentMessageId = null,
    count = 0,
    fingerprint = null,
    limits = null,
  }) {
    const connectionId = connection?.id ?? null;
    const moment = now();
    const evicted = [];
    const bounds = limits || resolveChainLimits(connection);

    // Expired chains are gone regardless of purpose.
    const scoped = forConnection(connectionId);
    drop(
      scoped.filter((chain) => !chain.busy && isOverTtl(chain, moment)).map((chain) => chain.key),
      evicted
    );

    const key = buildChainKey({ connectionId, purpose, sessionKey, conversation });
    const existing = chains.get(key);
    if (existing?.busy) {
      // The caller is replacing a chain it is still streaming on; leave it be.
      return { key, chain: existing, evicted, overflow: false, replacedBusy: true };
    }

    const remaining = forConnection(connectionId).filter((chain) => chain.key !== key);
    const auxChains = remaining.filter((chain) => chain.purpose === "aux");
    const mainChains = remaining.filter((chain) => chain.purpose !== "aux");
    const evictableAux = byAge(auxChains.filter((chain) => !chain.busy));

    if (purpose === "aux") {
      const overAux = auxChains.length + 1 - bounds.aux;
      if (overAux > 0) {
        drop(evictableAux.slice(0, overAux).map((chain) => chain.key), evicted);
      }
    }

    let overflow = false;
    if (purpose === "main" && mainChains.length + 1 > bounds.main) {
      // Auxiliary chains are cheap to rebuild, so they go first and keep the
      // total number of live sessions down before a conversation is touched.
      drop(evictableAux.map((chain) => chain.key), evicted);

      const mainsLeft = forConnection(connectionId).filter(
        (chain) => chain.key !== key && chain.purpose !== "aux"
      );
      const needed = mainsLeft.length + 1 - bounds.main;
      if (needed > 0) {
        // Prefer a conversation idle long enough to be treated as abandoned,
        // then fall back to the least recently used one.
        const idle = byAge(
          mainsLeft.filter((chain) => !chain.busy && isIdleOver(chain, moment, CHAIN_MAIN_IDLE_MS))
        );
        const victims = idle.length >= needed ? idle : byAge(mainsLeft.filter((chain) => !chain.busy));
        if (victims.length >= needed) {
          drop(victims.slice(0, needed).map((chain) => chain.key), evicted);
        } else {
          // Everything else is streaming; drop what is evictable and let the
          // pool overflow rather than corrupt an in-flight conversation.
          drop(victims.map((chain) => chain.key), evicted);
          overflow = true;
        }
      }
    }

    const chain = {
      key,
      connectionId,
      purpose,
      sessionKey,
      chatSessionId,
      parentMessageId,
      count,
      fingerprint,
      dirty: false,
      busy: false,
      createdAt: existing?.createdAt ?? moment,
      updatedAt: moment,
      lastUsedAt: moment,
    };
    chains.set(key, chain);
    return { key, chain, evicted, overflow, replacedBusy: false };
  }

  function touch(key, patch = {}) {
    const chain = chains.get(key);
    if (!chain) return null;
    const moment = now();
    Object.assign(chain, patch, { updatedAt: moment, lastUsedAt: moment });
    return chain;
  }

  function setBusy(key, busy = true) {
    const chain = chains.get(key);
    if (!chain) return null;
    chain.busy = Boolean(busy);
    chain.updatedAt = now();
    return chain;
  }

  function remove(key) {
    const chain = chains.get(key);
    if (!chain) return false;
    chains.delete(key);
    return true;
  }

  /** Record a completed turn: the watermark and the session parent to advance from. */
  function markTurn(key, patch = {}) {
    const chain = chains.get(key);
    if (!chain) return null;
    Object.assign(chain, patch, { dirty: false, updatedAt: now(), lastUsedAt: now() });
    return chain;
  }

  /** The upstream state is unknown; the next turn must start a fresh session. */
  function markDirty(key) {
    const chain = chains.get(key);
    if (!chain) return null;
    chain.dirty = true;
    chain.updatedAt = now();
    return chain;
  }

  function withLock(key, task) {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => {},
      () => {}
    );
    locks.set(key, tail);
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  const lockCount = () => locks.size;

  function reset() {
    chains.clear();
  }

  return { get, list, stats, register, touch, setBusy, remove, markTurn, markDirty, sweep, reset, withLock, lockCount };
}

const defaultStore = createChainStore();

/** Shared store used by the executor; tests build their own through createChainStore(). */
export const chainStore = defaultStore;

export const getChain = (key) => defaultStore.get(key);
export const listChains = (connectionId) => defaultStore.list(connectionId);
export const chainStats = (connectionId) => defaultStore.stats(connectionId);
export const registerChain = (entry) => defaultStore.register(entry);
export const touchChain = (key, patch) => defaultStore.touch(key, patch);
export const setChainBusy = (key, busy) => defaultStore.setBusy(key, busy);
export const removeChain = (key) => defaultStore.remove(key);
export const markChainTurn = (key, patch) => defaultStore.markTurn(key, patch);
export const markChainDirty = (key) => defaultStore.markDirty(key);
export const withChainLock = (key, task) => defaultStore.withLock(key, task);
export const chainLockCount = () => defaultStore.lockCount();
export const sweepChains = () => defaultStore.sweep();
export const resetChainStore = () => defaultStore.reset();
