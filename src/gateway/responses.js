import { openAIEnvelope, relayClientRequest } from "./relay.js";
import { FORMATS } from "../translator/index.js";
import { estimateResponsesInputTokens } from "../services/usage.js";
import { upstreamResponseToOpenAI } from "../services/upstreamResponse.js";
import {
  aggregateResponsesStream,
  customToolNamesFromBody,
  openAIMessageToResponsesOutput,
} from "../translator/responses.js";

const upstreamBaseUrl = (provider) =>
  provider.transport?.responsesUrl ||
  provider.transport?.baseUrl ||
  "https://api.openai.com/v1/chat/completions";

export async function handleResponses(c) {
  return relayClientRequest(c, {
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    // The raw Responses body is routed as-is: a Responses upstream receives it
    // verbatim, and a chat/Claude/Gemini/Kiro upstream gets the pivot inside
    // translateRequest per member — including after a combo failover.
    defaultFormat: FORMATS.OPENAI,
    baseUrlFor: upstreamBaseUrl,
    withUsageChunk: true,
    validate: (body) => Boolean(body && body.model),
    missingFieldMessage: "Missing required 'model' parameter",
    envelope: openAIEnvelope,
    streamFormat: "responses",
    transformOptions: (body) => ({ customToolNames: customToolNamesFromBody(body) }),
    estimateInputTokens: (body) => estimateResponsesInputTokens(body),
    finalize: async ({ upstreamRes, targetFormat, targetModel, body }) => {
      // Responses upstream answering a Responses client: the JSON body is the
      // client's own protocol, so it is returned untouched. Responses backends
      // always stream, so a non-streaming client gets the events aggregated.
      if (targetFormat === FORMATS.OPENAI_RESPONSES) {
        const contentType = upstreamRes.headers.get("content-type") || "";
        const rawText = await upstreamRes.text();
        const data = contentType.includes("event-stream") || /^\s*(data|event):/m.test(rawText)
          ? aggregateResponsesStream(rawText, targetModel)
          : JSON.parse(rawText);
        return {
          data,
          usage: {
            inputTokens: data.usage?.input_tokens || 0,
            outputTokens: data.usage?.output_tokens || 0,
          },
        };
      }

      const openAIData = await upstreamResponseToOpenAI(upstreamRes, targetFormat, targetModel);
      const inputTokens = openAIData.usage?.prompt_tokens || openAIData.usage?.input_tokens || 0;
      const outputTokens = openAIData.usage?.completion_tokens || openAIData.usage?.output_tokens || 0;
      const data = {
        id: openAIData.id || `resp_${Date.now()}`,
        object: "response",
        status: "completed",
        model: targetModel,
        output: openAIMessageToResponsesOutput(openAIData.choices?.[0]?.message, {
          customToolNames: customToolNamesFromBody(body),
        }),
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      };
      return { data, usage: { inputTokens, outputTokens } };
    },
  });
}
