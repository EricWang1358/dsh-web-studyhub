import { StringDecoder } from 'node:string_decoder';

/**
 * Create a bounded UTF-8 ring buffer for child stderr diagnostics.
 */
export function createStderrRing(maxBytes) {
  let chunks = [];
  let total = 0;

  function push(raw) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    if (!buf.length) return;
    chunks.push(buf);
    total += buf.length;
    while (total > maxBytes && chunks.length > 1) {
      total -= chunks.shift().length;
    }
    if (total > maxBytes) {
      const only = chunks[0];
      chunks = [only.subarray(only.length - maxBytes)];
      total = chunks[0].length;
    }
  }

  return {
    push,
    read: () => Buffer.concat(chunks, total).toString('utf8').trim(),
  };
}

/**
 * Create a backpressure-aware NDJSON writer for a child process stdin stream.
 */
export function createLineWriter(proc, maxWriteBufferBytes) {
  const queue = [];
  let queuedBytes = 0;
  let waitingDrain = false;

  const onDrain = () => {
    waitingDrain = false;
    flush();
  };

  function flush() {
    const stdin = proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      queue.length = 0;
      queuedBytes = 0;
      return;
    }
    while (queue.length > 0 && !waitingDrain) {
      const next = queue.shift();
      queuedBytes -= next.bytes;
      if (stdin.write(next.line, 'utf8') === false) {
        waitingDrain = true;
        stdin.once?.('drain', onDrain);
      }
    }
  }

  function send(payload) {
    const stdin = proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw Object.assign(new Error('Retrieval MCP stdin is not writable'), { code: 'retrieval-start-failed' });
    }
    const line = `${JSON.stringify(payload)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    const streamBuffered = Number.isFinite(stdin.writableLength) ? stdin.writableLength : 0;
    if (streamBuffered + queuedBytes + bytes > maxWriteBufferBytes) {
      throw Object.assign(
        new Error(`Retrieval MCP stdin backpressure limit exceeded (${maxWriteBufferBytes} bytes)`),
        { code: 'retrieval-backpressure' }
      );
    }
    if (waitingDrain || queue.length > 0) {
      queue.push({ line, bytes });
      queuedBytes += bytes;
      return false;
    }
    const ok = stdin.write(line, 'utf8');
    if (ok === false) {
      waitingDrain = true;
      stdin.once?.('drain', onDrain);
    }
    return ok !== false;
  }

  function clear() {
    queue.length = 0;
    queuedBytes = 0;
    if (waitingDrain) {
      proc?.stdin?.off?.('drain', onDrain);
      waitingDrain = false;
    }
  }

  return { send, clear };
}

function dispatchLines({ parts, maxLineBytes, onLine, onOverflow }) {
  for (const rawLine of parts) {
    if (Buffer.byteLength(rawLine, 'utf8') > maxLineBytes) {
      onOverflow();
      return false;
    }
    const trimmed = rawLine.trim();
    if (trimmed) onLine(trimmed);
  }
  return true;
}

/**
 * Create a UTF-8 safe, pause/resume backpressure-aware NDJSON stdout reader with max line cap.
 */
export function createStdoutLineHandler({ isRunning, getStdout, maxLineBytes, onLine, onOverflow }) {
  const decoder = new StringDecoder('utf8');
  let lineBuffer = '';

  return function onStdoutChunk(chunk) {
    if (!isRunning()) return;
    const stdout = getStdout();
    stdout?.pause?.();
    try {
      const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
      const parts = (lineBuffer + text).split('\n');
      lineBuffer = parts.pop() || '';
      if (!dispatchLines({ parts, maxLineBytes, onLine, onOverflow })) return;
      if (Buffer.byteLength(lineBuffer, 'utf8') > maxLineBytes) {
        lineBuffer = '';
        onOverflow();
      }
    } finally {
      if (isRunning()) stdout?.resume?.();
    }
  };
}

/**
 * Gracefully close an MCP stdio child process: close stdin first (MCP spec EOF signal),
 * wait up to `closeGraceMs` for clean exit, then escalate to `target.terminate()`.
 */
export async function gracefulTerminate(target, closeGraceMs) {
  if (!target) return;
  try {
    target.stdin?.end?.();
  } catch { /* stdin may already be closed */ }

  let exitedInGrace = false;
  let timer = null;
  try {
    await Promise.race([
      target.exited.then(() => { exitedInGrace = true; }),
      new Promise((done) => {
        timer = setTimeout(done, Math.max(0, closeGraceMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!exitedInGrace) {
    await target.terminate();
  }
}
