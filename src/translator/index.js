import { FORMATS, normalizeFormat } from "./formats.js";
import { openaiToClaude, claudeToOpenAI } from "./request.js";
import {
  claudeToOpenAIResponse,
  openAIToClaudeResponse,
  createResponseTransformStream,
} from "./response.js";

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

  if (src === FORMATS.OPENAI && tgt === FORMATS.CLAUDE) {
    return openaiToClaude(body, targetModel);
  }

  if (src === FORMATS.CLAUDE && tgt === FORMATS.OPENAI) {
    return claudeToOpenAI(body, targetModel);
  }

  return { ...body, model: targetModel || body.model };
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

  return data;
}

/**
 * Create TransformStream to translate SSE stream chunks from sourceFormat to targetFormat
 */
export function createTransformStream(sourceFormat, targetFormat, model) {
  const src = normalizeFormat(sourceFormat);
  const tgt = normalizeFormat(targetFormat);
  return createResponseTransformStream(src, tgt, model);
}
