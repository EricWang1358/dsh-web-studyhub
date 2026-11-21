/** Parse incremental SSE text frames from a streaming chunk buffer, returning any trailing incomplete frame. */
export function parseSseFrames(buffer, onFrame) {
  const normalized = String(buffer || '').replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = blocks.pop() ?? '';
  for (const block of blocks) {
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) onFrame({ event: eventName, data: dataLines.join('\n') });
  }
  return remainder;
}

const PERMANENT_STOP_STATUSES = new Set([403, 404, 405]);

async function readSseStream(reader, isStopped, dispatchFrame) {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!isStopped()) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer = parseSseFrames(buffer + decoder.decode(value, { stream: true }), dispatchFrame);
  }
  if (buffer) parseSseFrames(`${buffer}\n\n`, dispatchFrame);
}

function resolveStreamTarget(connection, fallbackBaseUrl, fallbackToken) {
  const current = typeof connection?.get === 'function' ? connection.get() : null;
  const baseUrl = String(current?.baseUrl ?? fallbackBaseUrl ?? '').replace(/\/+$/, '');
  const token = String(current?.token ?? fallbackToken ?? '');
  return { endpoint: `${baseUrl}/api/events`, token };
}

function makeFrameDispatcher(onEvent) {
  return ({ event, data }) => {
    if (event !== 'study:library-changed') return;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') onEvent(parsed);
    } catch {
      // Ignore malformed event payloads.
    }
  };
}

function startSseSubscription(opts, onEvent) {
  let stopped = false;
  let inFlight = false;
  let immediateReconnect = false;
  let controller = null;
  let retryTimer = null;
  let attempt = 0;
  const dispatchFrame = makeFrameDispatcher(onEvent);

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = Math.min(opts.reconnectMaxMs, Math.round(opts.reconnectBaseMs * (2 ** Math.min(attempt, 4))));
    attempt += 1;
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, delay);
    retryTimer?.unref?.();
  };

  const openStream = async () => {
    const target = resolveStreamTarget(opts.connection, opts.baseUrl, opts.token);
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    const response = await opts.fetchImpl(target.endpoint, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'X-Study-Token': target.token },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response?.ok) return response && PERMANENT_STOP_STATUSES.has(response.status) ? 'stop' : 'retry';
    attempt = 0;
    const reader = response.body?.getReader?.();
    if (!reader) return 'stop';
    await readSseStream(reader, () => stopped, dispatchFrame);
    return 'retry';
  };

  const connect = async () => {
    if (stopped) return;
    inFlight = true;
    let next = 'retry';
    try { next = await openStream(); } catch { next = 'retry'; }
    inFlight = false;
    if (stopped) return;
    if (immediateReconnect) { immediateReconnect = false; void connect(); return; }
    if (next === 'retry') scheduleReconnect();
  };

  const onConnectionChange = () => {
    if (stopped) return;
    attempt = 0;
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; void connect(); return; }
    if (inFlight) { immediateReconnect = true; try { controller?.abort?.(); } catch { /* ignore */ } return; }
    void connect();
  };

  const unsubConnection = typeof opts.connection?.subscribe === 'function'
    ? opts.connection.subscribe(onConnectionChange)
    : () => {};
  void connect();

  return () => {
    stopped = true;
    unsubConnection();
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    try { controller?.abort?.(); } catch { /* ignore */ }
  };
}

/**
 * Subscribe to the StudyHub Desktop sidecar's authenticated SSE push stream (`GET ${baseUrl}/api/events`
 * with `X-Study-Token`). Automatically reconnects with bounded backoff, follows live sidecar restarts,
 * and degrades silently on older sidecars.
 */
export function createDesktopEventSubscription({
  baseUrl = '',
  token = '',
  connection = null,
  fetchImpl = globalThis.fetch,
  reconnectBaseMs = 500,
  reconnectMaxMs = 5000,
} = {}) {
  const opts = { baseUrl, token, connection, fetchImpl, reconnectBaseMs, reconnectMaxMs };
  return (onEvent) => {
    if (typeof onEvent !== 'function' || typeof fetchImpl !== 'function') return () => {};
    return startSseSubscription(opts, onEvent);
  };
}
