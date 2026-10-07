const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Decode AWS binary EventStream chunk buffer into array of parsed event objects
 */
export function decodeEventStreamBuffer(buffer) {
  const events = [];
  let offset = 0;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const textDecoder = new TextDecoder();

  while (offset + 16 <= buffer.length) {
    const totalLength = view.getUint32(offset, false);
    const headersLength = view.getUint32(offset + 4, false);

    if (totalLength < 16 || totalLength > 24 * 1024 * 1024) {
      // Corrupt frame length or invalid offset
      break;
    }

    if (offset + totalLength > buffer.length) {
      // Incomplete frame, wait for more data
      break;
    }

    const payloadLength = totalLength - 16 - headersLength;
    const headersOffset = offset + 12;
    const payloadOffset = headersOffset + headersLength;

    // Parse headers
    const headers = {};
    let hOffset = headersOffset;
    while (hOffset < headersOffset + headersLength) {
      const nameLen = buffer[hOffset++];
      const name = textDecoder.decode(buffer.subarray(hOffset, hOffset + nameLen));
      hOffset += nameLen;
      const type = buffer[hOffset++];

      if (type === 7) {
        // String value
        const valLen = view.getUint16(hOffset, false);
        hOffset += 2;
        const val = textDecoder.decode(buffer.subarray(hOffset, hOffset + valLen));
        hOffset += valLen;
        headers[name] = val;
      } else {
        // Skip unknown header type for simplicity
        break;
      }
    }

    // Parse payload
    let payload = null;
    if (payloadLength > 0) {
      const payloadBytes = buffer.subarray(payloadOffset, payloadOffset + payloadLength);
      const payloadText = textDecoder.decode(payloadBytes);
      try {
        payload = JSON.parse(payloadText);
      } catch {
        payload = { text: payloadText };
      }
    }

    events.push({
      headers,
      payload,
      eventType: headers[":event-type"] || headers["event-type"] || null,
      messageType: headers[":message-type"] || headers["message-type"] || null,
    });

    offset += totalLength;
  }

  return {
    events,
    remainder: buffer.subarray(offset),
  };
}

/**
 * Transform binary AWS EventStream ReadableStream into parsed SSE text/event-stream
 */
export function createEventStreamTransformStream() {
  let pendingBuffer = new Uint8Array(0);

  return new TransformStream({
    transform(chunk, controller) {
      let combined;
      if (chunk instanceof Uint8Array) {
        combined = new Uint8Array(pendingBuffer.length + chunk.length);
        combined.set(pendingBuffer, 0);
        combined.set(chunk, pendingBuffer.length);
      } else {
        const bytes = new Uint8Array(chunk);
        combined = new Uint8Array(pendingBuffer.length + bytes.length);
        combined.set(pendingBuffer, 0);
        combined.set(bytes, pendingBuffer.length);
      }

      const { events, remainder } = decodeEventStreamBuffer(combined);
      pendingBuffer = remainder;

      for (const ev of events) {
        if (ev.payload) {
          controller.enqueue(ev);
        }
      }
    },
  });
}
