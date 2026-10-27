import "../../executors/duckduckgoWeb.js";
import { DUCKDUCKGO_STATIC_MODELS } from "../../services/duckduckgoWeb/models.js";

/**
 * DuckDuckGo AI Chat (duck.ai).
 *
 * Keyless: the endpoint is anonymous and free, gated only by a per-IP rate limit
 * and an anti-abuse challenge that the executor solves. No account rows exist, so
 * the connection is virtual (see getActiveConnection's noAuth branch).
 *
 * The roster rotates without notice, so the list below is only a fallback: the
 * executor reads GET /duckchat/v1/models first and reroutes to a live id when the
 * requested one is gone. There is no tool calling on this endpoint; a request
 * carrying `tools` gets plain prose back.
 *
 * Terms of service: Duck.ai's privacy terms prohibit automated querying and
 * building services on top of the chat, so treat this provider as a personal
 * convenience with a short shelf life, not as production capacity.
 */
export default {
  id: "duckduckgo-web",
  name: "DuckDuckGo AI Chat",
  alias: ["ddgw", "ddg", "duckduckgo"],
  category: "free",
  noAuth: true,
  format: "openai",
  executor: "duckduckgo-web",
  // One shared anonymous session; parallel turns on one IP trip the rate limit.
  concurrency: 1,
  throttleMs: 2000,
  transport: {
    baseUrl: "https://duck.ai/duckchat/v1/chat",
    format: "openai",
  },
  models: DUCKDUCKGO_STATIC_MODELS,
};
