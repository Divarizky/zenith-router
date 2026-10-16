import { getExecutor } from "../executors/base.js";
import { opencodePathForModel } from "../executors/opencode.js";
import { translateRequest, FORMATS } from "../translator/index.js";
import { applyTokenSaver, tokenSaverOptions } from "../services/tokenSaver.js";
import { getAllSettings } from "../services/settings.js";
import { effortFromRequest } from "../services/antigravityCatalog.js";

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * All upstream shaping lived inline in each gateway and the three copies drifted.
 * Everything the three endpoints actually agree on lives here; they only supply
 * their source format, which url to call, and their own header divergences.
 * Response-side behavior (error envelopes, response translation, warmup
 * interception) deliberately stays in the gateways.
 */
export function prepareUpstreamRequest({
  provider,
  targetModel,
  body,
  sourceFormat,
  defaultFormat = sourceFormat,
  baseUrlFor,
  tokenSaverHeader,
  withUsageChunk = false,
  streamOptions,
  extraHeaders,
}) {
  const startTime = Date.now();

  let targetFormat = provider.format || provider.transport?.format || defaultFormat;
  if (provider.id === "opencode") {
    const path = opencodePathForModel(targetModel);
    if (path.endsWith("/responses")) targetFormat = FORMATS.OPENAI_RESPONSES;
    else if (path.endsWith("/messages")) targetFormat = FORMATS.CLAUDE;
  }

  const upstreamStream = Boolean(body.stream) || Boolean(provider.transport?.forceStream);
  const translatedPayload = translateRequest(
    sourceFormat,
    targetFormat,
    { ...body, stream: upstreamStream },
    targetModel
  );

  const upstreamPayload = applyTokenSaver(
    translatedPayload,
    targetFormat,
    tokenSaverOptions(getAllSettings(), tokenSaverHeader)
  );

  if (withUsageChunk && upstreamStream && targetFormat === FORMATS.OPENAI) {
    upstreamPayload.stream_options = { include_usage: true, ...(streamOptions || {}) };
  }

  const baseHeaders = {
    "Content-Type": "application/json",
    ...(provider.transport?.headers || {}),
  };

  if (targetFormat === FORMATS.CLAUDE && !baseHeaders["Anthropic-Version"]) {
    baseHeaders["Anthropic-Version"] = ANTHROPIC_VERSION;
  }

  if (extraHeaders) Object.assign(baseHeaders, extraHeaders);

  const upstreamUrl = baseUrlFor(provider, targetFormat);

  return {
    targetFormat,
    upstreamStream,
    upstreamPayload,
    // The pivot body drops the client's thinking fields, so the level is read
    // from the original body and carried to the executor out of band.
    effort: effortFromRequest(sourceFormat, body),
    baseHeaders,
    executor: getExecutor(provider),
    startTime,
    resolveUrl: (conn) => {
      let url = upstreamUrl;
      if (url.includes("{accountId}") && conn?.credentials) {
        const acc =
          conn.credentials.account_id ||
          conn.credentials.accountId ||
          (typeof conn.credentials.api_key === "string" && conn.credentials.api_key.includes(":")
            ? conn.credentials.api_key.split(":")[0]
            : "");
        url = url.replace("{accountId}", acc);
      }
      return url;
    },
  };
}
