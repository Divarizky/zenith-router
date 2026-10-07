/**
 * RTK (Reduced Token Kit)
 * In-process prompt and tool-output condenser
 */

function deduplicateLines(text) {
  const lines = text.split("\n");
  const result = [];
  let currentLine = null;
  let repeatCount = 0;

  function flushRepeat() {
    if (repeatCount > 2) {
      // Keep first 2 lines, suppress the rest
      result.push(currentLine);
      result.push(`[... ${repeatCount - 1} duplicate lines suppressed ...]`);
    } else {
      for (let i = 0; i < repeatCount; i++) {
        result.push(currentLine);
      }
    }
    repeatCount = 0;
  }

  for (const line of lines) {
    if (line === currentLine) {
      repeatCount++;
    } else {
      if (repeatCount > 0) {
        flushRepeat();
      }
      currentLine = line;
      repeatCount = 1;
    }
  }

  if (repeatCount > 0) {
    flushRepeat();
  }

  return result.join("\n");
}

/**
 * Condense text while safely preserving markdown code blocks
 */
export function condenseContent(text) {
  if (!text || typeof text !== "string") {
    return {
      condensedText: text,
      originalLength: 0,
      condensedLength: 0,
      savedChars: 0,
      savedTokensEstimate: 0,
    };
  }

  const originalLength = text.length;

  // Split into segments by code blocks (```...```)
  const segments = text.split(/(```[\s\S]*?```)/g);
  const processedSegments = [];

  for (const seg of segments) {
    if (seg.startsWith("```") && seg.endsWith("```")) {
      // Segment is a code block - preserve intact
      processedSegments.push(seg);
    } else {
      // Non-code segment (prose, terminal logs, diff output)
      const deduped = deduplicateLines(seg);
      // Collapse excessive blank lines (> 2 newlines into 2)
      const collapsed = deduped.replace(/\n{3,}/g, "\n\n");
      processedSegments.push(collapsed);
    }
  }

  const condensedText = processedSegments.join("");
  const condensedLength = condensedText.length;
  const savedChars = Math.max(0, originalLength - condensedLength);
  const savedTokensEstimate = Math.ceil(savedChars / 4);

  return {
    condensedText,
    originalLength,
    condensedLength,
    savedChars,
    savedTokensEstimate,
  };
}

/**
 * Condense an array of messages.
 * Only user-typed text is touched: tool results carry raw file contents that agents
 * later match exactly when editing, and assistant turns are the model's own output.
 */
export function condenseMessages(messages) {
  if (!Array.isArray(messages)) {
    return { messages, totalSavedChars: 0, totalSavedTokens: 0 };
  }

  let totalSavedChars = 0;

  const newMessages = messages.map((msg) => {
    if (!msg || !msg.content || msg.role !== "user") return msg;

    if (typeof msg.content === "string") {
      const res = condenseContent(msg.content);
      totalSavedChars += res.savedChars;
      return { ...msg, content: res.condensedText };
    }

    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map((part) => {
        if (part && (part.type === "text" || part.type === undefined) && typeof part.text === "string") {
          const res = condenseContent(part.text);
          totalSavedChars += res.savedChars;
          return { ...part, text: res.condensedText };
        }
        return part;
      });
      return { ...msg, content: newContent };
    }

    return msg;
  });

  return {
    messages: newMessages,
    totalSavedChars,
    totalSavedTokens: Math.ceil(totalSavedChars / 4),
  };
}
