import { createHash } from "node:crypto";
import { getConnectionById, mergeConnectionCredentials } from "../db/index.js";
import { requireResolvedProxy } from "./proxyPools.js";
import { discoverKiroProfiles } from "./oauth/providers.js";

const discoveryInFlight = new Map();

function profileArnFrom(connection) {
  const value = connection?.credentials?.profile_arn || connection?.credentials?.profileArn;
  const arn = typeof value === "string" ? value.trim() : "";
  return /^arn:\S+$/.test(arn) ? arn : null;
}

function accessTokenFrom(connection) {
  const credentials = connection?.credentials || {};
  const token = credentials.access_token || credentials.api_key;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

function identityOf(token) {
  return createHash("sha256").update(token).digest("hex");
}

function discoveryKey(connection, token, proxyUrl) {
  const proxyPart = proxyUrl || "";
  return `${connection.id}:${identityOf(token)}:${proxyPart}`;
}

function failure(reason) {
  return { ok: false, reason };
}

async function discoverOnce(connection, token, proxyUrl) {
  const result = await discoverKiroProfiles(token, {
    proxyUrl,
    connectionId: connection.id,
  });
  if (!result.ok) return failure(result.reason || "failed");
  if (result.arns.length === 0) return failure("empty");
  if (result.arns.length !== 1) return failure("ambiguous");
  return { ok: true, profileArn: result.arns[0] };
}

function sharedDiscovery(connection, token, proxyUrl) {
  const key = discoveryKey(connection, token, proxyUrl);
  const existing = discoveryInFlight.get(key);
  if (existing) return existing;

  const promise = discoverOnce(connection, token, proxyUrl).finally(() => {
    if (discoveryInFlight.get(key) === promise) discoveryInFlight.delete(key);
  });
  discoveryInFlight.set(key, promise);
  return promise;
}

/**
 * Ensure one selected Kiro connection has an account-owned profile ARN.
 *
 * The network lookup is keyed by connection and credential identity. Its result
 * is merged into the current row only after the credential is re-read, so a
 * refresh, reconnect, or deletion that happens while the lookup is in flight
 * cannot receive the old account's profile.
 */
export async function ensureKiroProfileArn(connection, { proxyUrl } = {}) {
  if (!connection || connection.provider !== "kiro") return failure("unsupported");

  let current = connection.id ? getConnectionById(connection.id) : connection;
  if (!current) return failure("removed");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cached = profileArnFrom(current);
    if (cached) return { ok: true, connection: current, profileArn: cached, cached: true };

    const token = accessTokenFrom(current);
    if (!current.id || !token || current.auth_type === "noauth") return failure("unsupported");

    let resolvedProxy;
    try {
      resolvedProxy = proxyUrl === undefined ? requireResolvedProxy(current) : proxyUrl;
    } catch {
      return failure("proxy_invalid");
    }
    const tokenIdentity = identityOf(token);
    const result = await sharedDiscovery(current, token, resolvedProxy);
    const latest = getConnectionById(current.id);
    if (!latest) return failure("removed");

    const latestToken = accessTokenFrom(latest);
    if (!latestToken || identityOf(latestToken) !== tokenIdentity) {
      // The credential changed during discovery. Never use or persist the old
      // result; retry once against the current identity instead.
      current = latest;
      continue;
    }

    const latestCached = profileArnFrom(latest);
    if (latestCached) return { ok: true, connection: latest, profileArn: latestCached, cached: true };
    if (!result.ok) return result;

    const updated = mergeConnectionCredentials(latest.id, { profile_arn: result.profileArn });
    if (!updated) return failure("removed");
    return { ok: true, connection: updated, profileArn: result.profileArn, cached: false };
  }

  return failure("race");
}

export function resetKiroProfileDiscoveryForTests() {
  discoveryInFlight.clear();
}
