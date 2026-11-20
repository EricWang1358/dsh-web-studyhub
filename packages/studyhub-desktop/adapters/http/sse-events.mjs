const HEARTBEAT_MS = 25_000;

/**
 * Serve an authenticated loopback SSE stream (`GET /api/events`) for `study:library-changed` events.
 * Tracks open stream closers in `activeStreams` so server shutdown completes immediately.
 */
export function serveSseEvents({ req, res, origin, applyCorsHeaders, onSubscribeEvents, activeStreams }) {
  applyCorsHeaders(res, origin);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  let unsubscribe = () => {};
  const writeChunk = (chunk) => {
    if (closed || res.destroyed || res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      close();
    }
  };
  const heartbeat = setInterval(() => writeChunk(': keepalive\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    activeStreams.delete(close);
    try { unsubscribe(); } catch { /* ignore */ }
    if (!res.destroyed && !res.writableEnded) {
      try { res.end(); } catch { /* ignore */ }
    }
  };

  activeStreams.add(close);
  req.once('close', close);
  res.once('close', close);
  res.once('error', close);

  writeChunk(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  unsubscribe = onSubscribeEvents((event) => {
    const eventName = typeof event?.type === 'string' && event.type ? event.type : 'study:library-changed';
    writeChunk(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
  });
}
