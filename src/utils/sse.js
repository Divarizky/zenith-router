/**
 * Text SSE framing.
 *
 * Every place that folds a complete SSE body back into one payload, or inspects
 * it before committing the stream, needs the same rule: events are separated by
 * a blank line, and several `data:` lines inside one event are joined with a
 * newline. Three callers used to implement this with different tolerances
 * (line-only splits, `\r\n` ignored, data lines glued without a separator), so
 * the same body could parse in one path and disappear silently in another.
 */

export function parseSSEBlocks(text, { dropIncompleteTail = false } = {}) {
  const blocks = String(text ?? "").split(/\r?\n\r?\n/);
  // The last block may still be an incomplete event when the caller reads a
  // body that was cut off; dropping it keeps a half-written frame out.
  if (dropIncompleteTail) blocks.pop();

  const out = [];
  for (const block of blocks) {
    let event = "";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    // Comments and keep-alive pings carry no data.
    if (data.length === 0) continue;
    out.push({ event, data: data.join("\n").trim() });
  }
  return out;
}

export function parseSSEEvents(text, options = {}) {
  const events = [];
  for (const { data } of parseSSEBlocks(text, options)) {
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return events;
}
