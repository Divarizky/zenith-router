import "../../executors/deepseekWeb.js";
import { DEEPSEEK_WEB_MODELS } from "../../services/deepseekWeb/models.js";

/**
 * DeepSeek consumer chat (chat.deepseek.com), not the metered platform API.
 *
 * The account is a browser session (userToken + cookies), so the auth type is
 * "session" and there is no refresh flow: when the token dies the connection
 * reports 401 and the dashboard asks for a new one.
 *
 * `concurrency: 2` caps parallel turns per account. One web account is one login,
 * so the limit is per connection; a second account doubles the allowed parallel
 * turns. Auxiliary calls (session titles, memory jobs) share those slots but are
 * evicted first and give up quickly.
 * `throttleMs: 3000` enforces a 3-second minimum cool-off between turns on the same
 * account to prevent upstream "Messages too frequent" rate limits.
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
