import "../../executors/deepseekWeb.js";
import { DEEPSEEK_WEB_MODELS } from "../../services/deepseekWeb/models.js";

/**
 * DeepSeek consumer chat (chat.deepseek.com), not the metered platform API.
 *
 * The account is a browser session (userToken + cookies), so the auth type is
 * "session" and there is no refresh flow: when the token dies the connection
 * reports 401 and the dashboard asks for a new one.
 *
 * `serialTurns: true` is what the upstream actually enforces: one web account
 * generates one answer at a time. Sending a second turn while the first is
 * still streaming makes the chat answer "Messages too frequent", which the
 * router used to read as a rate limit and punish with a model lock. The traffic
 * guard now hands out a single slot per account and queues the rest.
 *
 * `concurrency: 2` stays as the warm-conversation pool: two chats may be open
 * server-side, they just take turns. Dropping it to 1 would evict one chat every
 * time the two conversations alternate, forcing a full prompt re-render.
 *
 * `queueTimeoutMs` matches the longest turn an agent loop may legitimately run;
 * with a single slot the generic 30s ceiling would reject the second
 * conversation before the first one finished.
 *
 * `softRateLimit: true` marks the 429 as contention rather than exhaustion:
 * the account is not out of quota, so it is retried after the throttle gap
 * instead of being locked.
 *
 * `throttleMs: 3000` keeps a minimum cool-off between turns on one account.
 */
export default {
  id: "deepseek-web",
  name: "DeepSeek Web Chat",
  alias: ["dsw", "dweb", "chatbrain"],
  category: "session",
  authMethods: ["session"],
  format: "openai",
  executor: "deepseek-web",
  concurrency: 2,
  serialTurns: true,
  queueTimeoutMs: 180000,
  softRateLimit: true,
  throttleMs: 3000,
  transport: {
    baseUrl: "https://chat.deepseek.com/api/v0",
    format: "openai",
  },
  // The published window follows the static capability table (128k). The web chat
  // itself accepts more, but claiming a window the router has not verified is
  // worse than under-claiming. Both ids hit the same endpoint; they differ only in
  // the `thinking_enabled` flag.
  models: DEEPSEEK_WEB_MODELS.map(({ id, name }) => ({ id, name })),
};
