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

export { FORMATS };

/**
 * Translate incoming request body from sourceFormat to targetFormat
 */
export function translateRequest(sourceFormat, targetFormat, body, targetModel) {
  const src = normalizeFormat(sourceFormat);
  const tgt = normalizeFormat(targetFormat);

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

  return createResponseTransformStream(src, tgt, model);
}
