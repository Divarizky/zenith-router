/*
 * ZCode identity helpers: LLM request headers and the 3-block system prompt.
 *
 * Identity assets (cliPrefix, stablePrefix, anthropic version/beta, SDK user
 * agent) are captured from ZCode 3.16.3 and derived from the MIT-licensed
 * project azrinaldi/zcode-bridge (https://github.com/azrinaldi/zcode-bridge).
 * Copyright (c) azrinaldi/zcode-bridge contributors, MIT License.
 */
import crypto from "node:crypto";
import identity from "../providers/assets/zcodeIdentity.json" with { type: "json" };

export const ZCODE_APP_VERSION = "3.16.3";

function hex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Build the header set ZCode sends on plan-lane LLM requests.
 * Session, request and trace ids are generated unless the caller passes them.
 */
export function buildZcodeLLMHeaders(options = {}) {
  return {
    "http-referer": "https://zcode.z.ai",
    "x-title": "Z Code@electron",
    "x-zcode-agent": "glm",
    "x-zcode-app-version": ZCODE_APP_VERSION,
    "anthropic-version": identity.anthropicVersion,
    "anthropic-beta": identity.anthropicBeta,
    "user-agent": identity.sdkUserAgent,
    "x-session-id": options.sessionId || `session_${hex()}`,
    "x-request-id": options.requestId || `req_${hex()}`,
    "x-zcode-trace-id": options.traceId || `tr_${hex()}`,
    "x-zcode-query-source": options.querySource || "main_turn",
    "x-zcode-session-type": options.sessionType || "main",
  };
}

/**
 * Build the system array for an Anthropic Messages upstream.
 * Block 2 carries the ephemeral cache marker. Block 3 is added only when the
 * client sent its own system prompt, and it carries a marker too so the client
 * prefix is cached.
 */
export function buildZcodeSystemBlocks(clientSystemPrompt) {
  const blocks = [
    { type: "text", text: identity.cliPrefix },
    { type: "text", text: identity.stablePrefix, cache_control: { type: "ephemeral" } },
  ];
  if (clientSystemPrompt) {
    blocks.push({ type: "text", text: `\n\n${clientSystemPrompt}`, cache_control: { type: "ephemeral" } });
  }
  return blocks;
}

export { identity as ZCODE_IDENTITY };
