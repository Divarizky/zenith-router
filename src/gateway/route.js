import { resolveModel, memberCapabilities } from "../providers/index.js";
import { getActiveComboByName } from "../services/combos.js";
import { captureLine } from "../services/logger.js";
import { executeWithFallback } from "../services/fallback.js";
import { getSetting } from "../services/settings.js";
import { prepareUpstreamRequest } from "./prepare.js";
import { FORMATS } from "../translator/formats.js";

/**
 * Rotation start position per combo, held in process memory: the cursor only has
 * to stay consistent within this gateway, and a restart beginning again at the
 * first member costs nothing.
 */
const comboCursors = new Map();

// One id per client request: internal retries, account failover, and combo
// members share it so the cooldown strike counter sees a single attempt.
let routeRequestSeq = 0;

/** Forget every rotation position (test hook and manual reset). */
export function resetComboRotation() {
  comboCursors.clear();
}

/** Requests to keep the same starting member before the rotation moves on. */
function roundRobinCount() {
  const parsed = Number.parseInt(getSetting("combo_round_robin_count", "1"), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Does the request carry an image a vision member would have to read? Looks at
 * the content blocks of the client's own format — an OpenAI image_url part, an
 * Anthropic image block, a Responses input_image — so a text prompt that merely
 * mentions "image_url" does not reorder anything.
 */
function requestCarriesImages(body) {
  const hasImagePart = (part) =>
    Boolean(part) && (part.type === "image_url" || part.type === "image" || part.type === "input_image");
  const scan = (items) =>
    Array.isArray(items) &&
    items.some((item) => hasImagePart(item) || (Array.isArray(item?.content) && item.content.some(hasImagePart)));
  return scan(body?.messages) || scan(body?.input);
}

/** Stable partition: members that read images first, stored order preserved. */
function prioritizeVision(members) {
  const vision = [];
  const rest = [];
  for (const member of members) {
    (memberCapabilities(member)?.vision ? vision : rest).push(member);
  }
  return [...vision, ...rest];
}

/**
 * The order the chain is attempted in. Fallback always starts at the first
 * member; round robin starts at the cursor so consecutive requests spread across
 * the chain. Failures still walk the rest of the chain in order either way.
 * An image request puts every vision-capable member in front, whatever the
 * stored order says — a text member cannot answer it anyway.
 */
function memberOrder(combo, body) {
  const withVision = (members) => (requestCarriesImages(body) ? prioritizeVision(members) : members);
  if (combo.strategy !== "round-robin" || combo.models.length === 0) {
    return { members: withVision(combo.models), start: 0 };
  }
  const cursor = comboCursors.get(combo.name) || { index: 0, used: 0 };
  // Kursor selalu ditulis dalam rentang [0, length); modulo di sini hanya
  // menjaga kasus anggota dihapus dari rantai sehingga index melebihi panjang.
  const start = cursor.index % combo.models.length;
  const members = [...combo.models.slice(start), ...combo.models.slice(0, start)];
  return { members: withVision(members), start };
}

/**
 * One step per request: hold the starting member while the hold count allows,
 * then move on. The count is read per request so a settings change takes effect
 * on the very next one. A failed member does not skip the cursor forward — the
 * rotation advances once per request no matter how many members were tried.
 */
function advanceRotation(combo, start) {
  if (combo.strategy !== "round-robin" || combo.models.length === 0) return;
  const cursor = comboCursors.get(combo.name) || { index: 0, used: 0 };
  cursor.used += 1;
  if (cursor.used >= roundRobinCount()) {
    cursor.index = (start + 1) % combo.models.length;
    cursor.used = 0;
  } else {
    cursor.index = start;
  }
  comboCursors.set(combo.name, cursor);
}

/**
 * Statuses that mean "this member cannot serve the request right now, the next
 * one might". A request the upstream itself rejects (400, 422) is the client's
 * fault and would fail the same way on every member, so the chain stops there.
 *
 * 401/402/403 are billing and credential problems, 404 means the model is gone,
 * 429 is a rate limit, and every 5xx is an upstream fault. The 5xx test is a
 * range rather than a list on purpose: fallback.js treats anything >= 500 as
 * transient, so a bare 500 or a 501 has to keep walking the chain too.
 */
export function shouldTryNextMember(status) {
  const code = Number(status);
  if (code >= 500) return true;
  return code === 401 || code === 402 || code === 403 || code === 404 || code === 429;
}

/**
 * A bare model string is looked up as a combo first: an explicitly created combo
 * must not lose to the provider guess built from a model-name prefix.
 */
export function resolveTarget(model) {
  if (!model || typeof model !== "string") return null;
  if (!model.includes("/") && !model.includes(":")) {
    const combo = getActiveComboByName(model);
    if (combo && combo.models.length > 0) return { combo };
  }
  return resolveModel(model);
}

function prepareMember(provider, targetModel, endpoint) {
  return prepareUpstreamRequest({
    provider,
    targetModel,
    body: endpoint.body,
    sourceFormat: endpoint.sourceFormat,
    defaultFormat: endpoint.defaultFormat,
    tokenSaverHeader: endpoint.tokenSaverHeader,
    withUsageChunk: endpoint.withUsageChunk,
    streamOptions: endpoint.streamOptions,
    extraHeaders: endpoint.extraHeaders,
    baseUrlFor: endpoint.baseUrlFor,
  });
}

async function runPreparedMember(prepared, provider, targetModel, endpoint) {
  const { targetFormat, upstreamStream, upstreamPayload, baseHeaders, executor, startTime, resolveUrl, effort } = prepared;

  const result = await executeWithFallback({
    provider,
    targetFormat,
    upstreamPayload,
    baseHeaders,
    executor,
    signal: endpoint.signal,
    stream: upstreamStream,
    targetModel,
    resolveUrl,
    sessionKey: endpoint.sessionKey,
    effort,
    requestId: endpoint.requestId,
  });

  if (!result.ok) return { ok: false, response: result.response, status: result.response.status };

  return {
    ok: true,
    provider,
    targetModel,
    targetFormat,
    upstreamStream,
    upstreamRes: result.upstreamRes,
    connection: result.connection,
    startTime,
  };
}

/**
 * A combo failure is reported in the shape the client's endpoint speaks, not in
 * whatever shape the last failing member happened to use.
 */
function comboError(endpoint, code, message, status = 503) {
  const payload =
    endpoint.sourceFormat === FORMATS.CLAUDE
      ? { type: "error", error: { type: "overloaded_error", message } }
      : { error: { message, type: "service_unavailable", code } };
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

async function attemptMember(provider, targetModel, endpoint) {
  return runPreparedMember(prepareMember(provider, targetModel, endpoint), provider, targetModel, endpoint);
}

async function lastErrorMessage(failure) {
  try {
    const text = await failure?.response?.clone().text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed?.error?.message || parsed?.message || text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return null;
  }
}

/**
 * Identity used by the per-request tried set: one runtime model on one provider.
 * Two different public names can resolve to the same upstream model, and running
 * it twice buys nothing but another cooldown.
 */
function identityOf({ provider, targetModel }) {
  return `${provider.id}:${targetModel}`;
}

/**
 * The members of one combo, attempted in order. Every attempt completes before
 * the next one starts, so a client in streaming mode still sees a clean
 * failover: either one member's response or nothing at all.
 */
async function runComboMembers(combo, endpoint, attempted) {
  const { members, start } = memberOrder(combo, endpoint.body);
  let lastFailure = null;

  try {
    for (const member of members) {
      const resolved = resolveModel(member);
      if (!resolved?.provider) {
        captureLine(`[COMBO] name=${combo.name} member="${member}" tidak bisa dipetakan, dilewati`);
        continue;
      }

      const identity = identityOf(resolved);

      // Sudah dipanggil pada request ini (mis. target fallback menunjuk anggota
      // yang barusan gagal): mengulanginya hanya menambah cooldown.
      if (attempted.has(identity)) {
        captureLine(`[COMBO] name=${combo.name} member="${member}" sudah dicoba, dilewati`);
        continue;
      }

      captureLine(
        `[ROUTE] combo=${combo.name} member="${member}" -> provider=${resolved.provider.id} (${resolved.targetModel})`
      );

      // A client that walked away stops the chain outright: no member is called
      // after the abort, and no cooldown is written on its behalf.
      if (endpoint.signal?.aborted) {
        captureLine(`[COMBO] name=${combo.name} klien berhenti, rantai dihentikan`);
        break;
      }

      // Prepare outside the catch below. A translator error is a deterministic
      // problem with this request — it would fail the same way on every member —
      // so it must surface instead of reading as an unreachable member.
      const prepared = prepareMember(resolved.provider, resolved.targetModel, endpoint);

      // A transport failure (connection reset, DNS, timeout) reaches us as a throw,
      // not a status. It is the most common shape of an upstream hiccup, so it has to
      // keep walking the chain instead of escaping to the gateway's 500 handler.
      let attempt;
      try {
        attempt = await runPreparedMember(prepared, resolved.provider, resolved.targetModel, endpoint);
      } catch (err) {
        if (endpoint.signal?.aborted) throw err;
        const message = `member "${member}" could not be reached: ${err.message}`;
        captureLine(`[COMBO] Combo '${combo.name}': ${message}`);
        attempt = {
          ok: false,
          status: 503,
          response: comboError(endpoint, "upstream_unreachable", message),
        };
      }

      attempted.add(identity);
      if (attempt.ok) return { ...attempt, comboName: combo.name };

      lastFailure = attempt;
      if (!shouldTryNextMember(attempt.status)) return attempt;

      captureLine(
        `[COMBO] name=${combo.name} member="${member}" gagal dengan HTTP ${attempt.status}, pindah ke anggota berikutnya`
      );
    }

    const detail = await lastErrorMessage(lastFailure);
    const message = `Combo '${combo.name}': every member failed. Last error: ${detail || "no member could be reached"}`;
    return {
      ok: false,
      comboName: combo.name,
      response: comboError(endpoint, "combo_exhausted", message),
      status: 503,
    };
  } finally {
    advanceRotation(combo, start);
  }
}

/**
 * The last resort of a request: when the requested model, or every member of the
 * requested combo, cannot serve it, the configured default fallback model gets a
 * turn. Running the same target again is pointless, so a setting that points
 * back at what just failed — or at a combo whose members were all tried — is
 * dropped and the original failure stands.
 */
async function runDefaultFallback({ endpoint, attempted, failure, origin, fallbackId }) {
  if (!fallbackId) return failure;

  const resolved = resolveTarget(fallbackId);
  if (!resolved) {
    captureLine(`[FALLBACK] model="${origin}" gagal, target "${fallbackId}" tidak dikenal, dilewati`);
    return failure;
  }

  // Klien bisa saja sudah pergi — rantai utama berhenti karena abort lalu status
  // 503-nya memicu fallback. Memanggil upstream di sini hanya membakar kuota
  // target cadangan dan menulis cooldown untuk request yang tidak ada penunggunya.
  if (endpoint.signal?.aborted) {
    captureLine(`[FALLBACK] klien berhenti, target "${fallbackId}" tidak dipanggil`);
    return failure;
  }

  if (resolved.combo) {
    // Nama combo yang sama dengan request bukan cadangan, melainkan pengulangan.
    const isSelf = resolved.combo.name === origin;
    const hasFreshMember = resolved.combo.models
      .map((member) => resolveModel(member))
      .some((r) => r?.provider && !attempted.has(identityOf(r)));
    if (isSelf || !hasFreshMember) {
      captureLine(`[FALLBACK] combo "${fallbackId}" sudah dicoba seluruhnya, dilewati`);
      return failure;
    }

    captureLine(`[FALLBACK] model="${origin}" gagal, beralih ke combo "${fallbackId}"`);
    const attempt = await runComboMembers(resolved.combo, endpoint, attempted);
    return attempt.ok ? { ...attempt, fallbackFrom: origin } : attempt;
  }

  const { provider, targetModel } = resolved;
  const identity = identityOf({ provider, targetModel });
  if (attempted.has(identity)) {
    captureLine(`[FALLBACK] target "${fallbackId}" sudah dicoba pada request ini, dilewati`);
    return failure;
  }

  captureLine(`[FALLBACK] model="${origin}" gagal, beralih ke "${fallbackId}"`);
  const attempt = await attemptMember(provider, targetModel, endpoint);
  attempted.add(identity);
  return attempt.ok ? { ...attempt, fallbackFrom: origin } : attempt;
}

/**
 * Resolve the requested model and run it, walking a combo chain when the name is
 * a combo. A request whose model, or whose whole combo, gives up falls back to
 * the default fallback model from Settings — once, and never onto a target the
 * request already called.
 */
export async function routeRequest({ model, ...endpoint }) {
  if (!endpoint.requestId) {
    routeRequestSeq += 1;
    endpoint.requestId = `route-${routeRequestSeq}`;
  }
  const target = resolveTarget(model);

  if (!target) return { notFound: true };

  const attempted = new Set();
  const fallbackId = getSetting("default_fallback_model", "").trim();

  if (!target.combo) {
    const { provider, targetModel } = target;
    captureLine(
      `[ROUTE] model=${model} -> provider=${provider.id} (${targetModel}) stream=${Boolean(endpoint.body.stream)}`
    );
    const attempt = await attemptMember(provider, targetModel, endpoint);
    attempted.add(identityOf({ provider, targetModel }));
    if (attempt.ok) return attempt;
    // A payload the upstream itself rejects fails the same way everywhere.
    if (!shouldTryNextMember(attempt.status)) return attempt;
    return runDefaultFallback({ endpoint, attempted, failure: attempt, origin: model, fallbackId });
  }

  const attempt = await runComboMembers(target.combo, endpoint, attempted);
  if (attempt.ok) return attempt;
  if (!shouldTryNextMember(attempt.status)) return attempt;
  return runDefaultFallback({ endpoint, attempted, failure: attempt, origin: model, fallbackId });
}
