import { FORMATS, normalizeFormat } from "./formats.js";
import { openaiToClaude, claudeToOpenAI } from "./request.js";
import {
  claudeToOpenAIResponse,
  openAIToClaudeResponse,
  createResponseTransformStream,
} from "./response.js";
import {
  openaiToResponsesRequest,
  responsesToOpenAIResponse,
  createResponsesToOpenAITransformStream,
  createOpenAIToResponsesTransformStream,
} from "./responses.js";
import {
  openaiToGeminiRequest,
  geminiToOpenAIResponse,
  createGeminiToOpenAITransformStream,
} from "./gemini.js";
import {
  openaiToKiroRequest,
  createKiroToOpenAITransformStream,
} from "./kiro.js";

export { FORMATS, normalizeFormat };

/**
 * OpenAI clients (Pi, newer SDKs) send the system prompt as role "developer".
 * Most OpenAI-compatible upstreams (Mistral, Groq, ...) only accept "system",
 * and the translators below only look for "system", so map it once here.
 */
function normalizeDeveloperRole(body) {
  if (!Array.isArray(body?.messages) || !body.messages.some((m) => m?.role === "developer")) {
    return body;
  }
  return {
    ...body,
    messages: body.messages.map((m) => (m?.role === "developer" ? { ...m, role: "system" } : m)),
  };
}

/**
 * Translate incoming request body from sourceFormat to targetFormat
 */
export function translateRequest(sourceFormat, targetFormat, body, targetModel) {
  const src = normalizeFormat(sourceFormat);
  const tgt = normalizeFormat(targetFormat);

  if (src === FORMATS.OPENAI) {
    body = normalizeDeveloperRole(body);
  }

  if (src === tgt) {
    return { ...body, model: targetModel || body.model };
  }

  // Normalize source to OpenAI first if incoming from Claude
  let openAIBody = body;
  if (src === FORMATS.CLAUDE) {
    openAIBody = claudeToOpenAI(body, targetModel);
  }

  if (tgt === FORMATS.CLAUDE) {
    return openaiToClaude(openAIBody, targetModel);
  }

  if (tgt === FORMATS.OPENAI_RESPONSES) {
    return openaiToResponsesRequest(openAIBody, targetModel);
  }

  if (tgt === FORMATS.GEMINI) {
    return openaiToGeminiRequest(openAIBody, targetModel);
  }

  if (tgt === FORMATS.KIRO) {
    return openaiToKiroRequest(openAIBody, targetModel);
  }

  return { ...openAIBody, model: targetModel || openAIBody.model };
}

/**
 * Translate non-streaming response from sourceFormat to targetFormat
 */
export function translateResponse(sourceFormat, targetFormat, data, model) {
  const src = normalizeFormat(sourceFormat);
  const tgt = normalizeFormat(targetFormat);

  if (src === tgt) return data;

  if (src === FORMATS.CLAUDE && tgt === FORMATS.OPENAI) {
    return claudeToOpenAIResponse(data, model);
  }

  if (src === FORMATS.OPENAI && tgt === FORMATS.CLAUDE) {
    return openAIToClaudeResponse(data, model);
  }

  if (src === FORMATS.OPENAI_RESPONSES && tgt === FORMATS.OPENAI) {
    return responsesToOpenAIResponse(data, model);
  }

  if (src === FORMATS.GEMINI && tgt === FORMATS.OPENAI) {
    return geminiToOpenAIResponse(data, model);
  }

  return data;
}

/**
 * Create TransformStream to translate SSE stream chunks from sourceFormat to targetFormat
 */
export function createTransformStream(sourceFormat, targetFormat, model) {
  const src = normalizeFormat(sourceFormat);
  const tgt = normalizeFormat(targetFormat);

  if (src === FORMATS.OPENAI_RESPONSES && tgt === FORMATS.OPENAI) {
    return createResponsesToOpenAITransformStream(model);
  }

  if (src === FORMATS.GEMINI && tgt === FORMATS.OPENAI) {
    return createGeminiToOpenAITransformStream(model);
  }

  if (src === FORMATS.KIRO && tgt === FORMATS.OPENAI) {
    return createKiroToOpenAITransformStream(model);
  }

  if (tgt === FORMATS.OPENAI_RESPONSES && src !== FORMATS.OPENAI_RESPONSES) {
    if (src === FORMATS.OPENAI) {
      return createOpenAIToResponsesTransformStream(model);
    }
    return composeTransformStreams(
      createTransformStream(src, FORMATS.OPENAI, model),
      createOpenAIToResponsesTransformStream(model),
    );
  }

  if (tgt === FORMATS.CLAUDE && src !== FORMATS.CLAUDE) {
    return composeTransformStreams(
      createTransformStream(src, FORMATS.OPENAI, model),
      createResponseTransformStream(FORMATS.OPENAI, FORMATS.CLAUDE, model),
    );
  }

  return createResponseTransformStream(src, tgt, model);
}

function composeTransformStreams(...streams) {
  let inputController;
  const input = new ReadableStream({ start(controller) { inputController = controller; } });
  const piped = streams.reduce((readable, stream) => readable.pipeThrough(stream), input);
  const reader = piped.getReader();
  let done;

  return new TransformStream({
    start(controller) {
      done = (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        }
      })();
    },
    transform(chunk) {
      inputController.enqueue(chunk);
    },
    async flush() {
      inputController.close();
      await done;
    },
  });
}
