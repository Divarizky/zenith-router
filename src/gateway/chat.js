import { openAIEnvelope, relayClientRequest } from "./relay.js";
import { FORMATS } from "../translator/index.js";
import { estimateTokens, normalizeUsage } from "../services/usage.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";

const upstreamBaseUrl = (provider) =>
  provider.transport?.baseUrl || "https://api.openai.com/v1/chat/completions";

export async function handleChat(c) {
  return relayClientRequest(c, {
    sourceFormat: FORMATS.OPENAI,
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: upstreamBaseUrl,
    withUsageChunk: true,
    validate: (body) => Boolean(body && body.model && Array.isArray(body.messages)),
    missingFieldMessage: "Missing or invalid 'model' or 'messages' parameter",
    envelope: openAIEnvelope,
    streamFormat: "openai",
    // Chat clients cannot declare Responses custom tools, so their set is
    // empty: upstream function_call items must never reach them as
    // custom_tool_call even when another client registered the same name.
    transformOptions: (body) => ({
      customToolNames: new Set(),
      // OpenAI spec: the final usage chunk is sent only when requested.
      includeUsage: Boolean(body.stream_options?.include_usage),
    }),
    estimateInputTokens: (body) => estimateTokens(body.messages),
    finalize: async ({ upstreamRes, targetFormat, targetModel }) => {
      const data = await upstreamResponseToOpenAI(upstreamRes, targetFormat, targetModel);
      return { data, usage: normalizeUsage(data.usage) };
    },
  });
}
