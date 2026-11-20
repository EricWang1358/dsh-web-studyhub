import { spawnPersistent as defaultSpawnPersistent } from '../cli/process-runner.mjs';

const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const MCP_PROTOCOL_VERSION = '2024-11-05';

function createStderrRing(maxBytes) {
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

function makeMcpError(errPayload) {
  const message = typeof errPayload?.message === 'string' && errPayload.message
    ? errPayload.message
    : 'MCP server returned an error';
  const error = new Error(message);
  if (errPayload?.code !== undefined) error.code = errPayload.code;
  if (errPayload?.data !== undefined) error.mcpData = errPayload.data;
  return error;
}

function normalizeTools(rawTools) {
  if (!Array.isArray(rawTools)) return [];
  return rawTools
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    }));
}

function normalizeToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return {
    content,
    ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result?.isError ? { isError: true } : {}),
  };
}

function buildExitError(outcome, stderrText) {
  const detail = outcome?.error?.message
    || `code=${outcome?.code ?? 'null'}, signal=${outcome?.signal ?? 'null'}`;
  const tail = stderrText ? ` | stderr: ${stderrText.slice(-400)}` : '';
  return Object.assign(
    new Error(`Retrieval MCP server exited unexpectedly (${detail})${tail}`),
    { code: 'retrieval-start-failed' }
  );
}

function createAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const message = typeof reason === 'string' && reason ? reason : 'Retrieval tool call aborted';
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' });
}

function writeJsonLine(proc, payload) {
  if (!proc?.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
    throw Object.assign(new Error('Retrieval MCP stdin is not writable'), { code: 'retrieval-start-failed' });
  }
  proc.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
}

function rejectAllPending(pending, error) {
  for (const [id, entry] of pending.entries()) {
    pending.delete(id);
    entry.cleanup();
    entry.reject(error);
  }
}

function handleJsonMessage(state, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (Object.hasOwn(msg, 'id') && typeof msg.method === 'string') {
    try {
      writeJsonLine(state.proc, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
      });
    } catch { /* ignore closed pipe */ }
    return;
  }
  if (!Object.hasOwn(msg, 'id') || !state.pending.has(msg.id)) return;
  const entry = state.pending.get(msg.id);
  state.pending.delete(msg.id);
  entry.cleanup();
  if (msg.error) entry.reject(makeMcpError(msg.error));
  else entry.resolve(msg.result);
}

function onStdoutChunk(state, chunk) {
  state.lineBuffer += chunk.toString('utf8');
  const parts = state.lineBuffer.split('\n');
  state.lineBuffer = parts.pop() || '';
  for (const rawLine of parts) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      handleJsonMessage(state, JSON.parse(trimmed));
    } catch {
      state.stderrRing.push(`[non-json stdout] ${trimmed.slice(0, 200)}\n`);
    }
  }
}

function sendJsonRpc(state, method, params, { signal, timeoutMs } = {}) {
  if (!state.running || !state.proc) {
    return Promise.reject(Object.assign(new Error('Retrieval MCP client is not running'), { code: 'retrieval-start-failed' }));
  }
  if (signal?.aborted) return Promise.reject(createAbortError(signal));

  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (!state.pending.has(id)) return;
      state.pending.delete(id);
      cleanup();
      reject(error);
    };
    const onAbort = signal ? () => fail(createAbortError(signal)) : null;
    if (onAbort) signal.addEventListener('abort', onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(Object.assign(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`), { code: 'retrieval-call-timeout' }));
      }, timeoutMs);
      timer.unref?.();
    }

    state.pending.set(id, { resolve, reject, cleanup });
    try {
      writeJsonLine(state.proc, { jsonrpc: '2.0', id, method, params });
    } catch (error) {
      fail(error);
    }
  });
}

async function runHandshake(state, initTimeoutMs) {
  await sendJsonRpc(
    state,
    'initialize',
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'studyhub-desktop', version: '1.0.0' },
    },
    { timeoutMs: initTimeoutMs }
  );
  writeJsonLine(state.proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await sendJsonRpc(state, 'tools/list', {}, { timeoutMs: initTimeoutMs });
  state.cachedTools = normalizeTools(listed?.tools);
  return state.cachedTools;
}

/**
 * Create a lightweight JSON-RPC 2.0 NDJSON stdio MCP client backed by `spawnPersistent`.
 */
export function createMcpStdioClient({
  command,
  args = [],
  cwd,
  env,
  spawnPersistent = defaultSpawnPersistent,
  initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS,
  defaultCallTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  onExit = null,
}) {
  const state = {
    stderrRing: createStderrRing(maxStderrBytes),
    pending: new Map(),
    proc: null,
    running: false,
    closing: false,
    nextId: 1,
    lineBuffer: '',
    cachedTools: [],
    closePromise: null,
  };

  function close() {
    if (state.closePromise) return state.closePromise;
    state.closing = true;
    state.running = false;
    rejectAllPending(state.pending, Object.assign(new Error('Retrieval MCP client closed'), { code: 'retrieval-closed' }));
    const target = state.proc;
    state.proc = null;
    state.closePromise = target ? target.terminate().then(() => undefined) : Promise.resolve();
    return state.closePromise;
  }

  async function start() {
    if (state.running) return state.cachedTools;
    state.closing = false;
    state.lineBuffer = '';
    state.proc = spawnPersistent({ command, args, cwd, env });
    state.running = true;

    state.proc.stdout?.on('data', (chunk) => onStdoutChunk(state, chunk));
    state.proc.stderr?.on('data', (chunk) => state.stderrRing.push(chunk));
    state.proc.exited.then((outcome) => {
      const wasClosing = state.closing;
      state.running = false;
      rejectAllPending(state.pending, buildExitError(outcome, state.stderrRing.read()));
      if (!wasClosing && typeof onExit === 'function') {
        onExit({ ...outcome, stderr: state.stderrRing.read() });
      }
    });

    try {
      return await runHandshake(state, initTimeoutMs);
    } catch (error) {
      const stderr = state.stderrRing.read();
      await close();
      if (stderr && !String(error?.message || '').includes('stderr:')) {
        error.message = `${error.message} (stderr: ${stderr.slice(-400)})`;
      }
      throw error;
    }
  }

  async function callTool(name, toolArgs = {}, { signal, timeoutMs = defaultCallTimeoutMs } = {}) {
    const result = await sendJsonRpc(
      state,
      'tools/call',
      { name, arguments: toolArgs ?? {} },
      { signal, timeoutMs }
    );
    return normalizeToolResult(result);
  }

  return Object.freeze({
    start,
    close,
    callTool,
    listTools: () => [...state.cachedTools],
    isRunning: () => state.running,
    getStderr: () => state.stderrRing.read(),
    get pid() { return state.proc?.pid ?? null; },
  });
}
