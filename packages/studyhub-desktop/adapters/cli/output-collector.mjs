import { StringDecoder } from 'node:string_decoder';

/**
 * Collect a child's output up to `maxBytes`, and hand each complete line to `lineSink.onLine` as it arrives.
 * `lineSink` is an object so the handler can be set after the process has started: a line completed while
 * there is no handler is kept in the collected text and not replayed later.
 * @param {number} maxBytes
 * @param {{ onLine: ((line: string) => void) | null } | null} [lineSink] null when nothing reads line by line
 */
export function createOutputCollector(maxBytes, lineSink = null) {
  const chunks = [];
  const decoder = lineSink ? new StringDecoder('utf8') : null;
  let collected = 0;
  let truncated = false;
  let lineBuffer = '';

  function push(buffer) {
    const chunk = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (decoder) {
      lineBuffer += decoder.write(chunk);
      const parts = lineBuffer.split(/\r?\n/);
      lineBuffer = parts.pop() || '';
      for (const line of parts) lineSink.onLine?.(line);
    }
    if (collected >= maxBytes) {
      truncated = true;
      return;
    }
    const remaining = maxBytes - collected;
    if (chunk.length > remaining) {
      chunks.push(chunk.subarray(0, remaining));
      collected += remaining;
      truncated = true;
    } else {
      chunks.push(chunk);
      collected += chunk.length;
    }
  }

  function finish() {
    if (decoder) {
      lineBuffer += decoder.end();
      if (lineBuffer) {
        lineSink.onLine?.(lineBuffer);
        lineBuffer = '';
      }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  }

  return { push, finish };
}
