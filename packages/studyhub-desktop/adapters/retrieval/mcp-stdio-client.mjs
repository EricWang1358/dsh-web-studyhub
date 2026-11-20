import {
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  buildCancelledNotification,
  buildInitializeParams,
  createMcpAbortError,
  formatCancellationReason,
  makeMcpError,
  negotiateProtocolVersion,
  normalizeMcpToolResult,
  normalizeMcpTools,
  shouldSendCancellationNotification,
} from '../../domain/mcp-protocol.js';
import { spawnPersistent as defaultSpawnPersistent } from '../cli/process-runner.mjs';
import {
  createLineWriter,
  createStderrRing,
  createStdoutLineHandler,
  gracefulTerminate,
} from './mcp-stdio-transport.mjs';

const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 90_000;
const DEFAULT_CLOSE_GRACE_MS = 300;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_WRITE_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_LIST_PAGES = 20;

function buildExitError(outcome, stderrText) {
  const detail = outcome?.error?.message
    || `code=${outcome?.code ?? 'null'}, signal=${outcome?.signal ?? 'null'}`;
  const tail = stderrText ? ` | stderr: ${stderrText.slice(-400)}` : '';
  return Object.assign(
    new Error(`Retrieval MCP server exited unexpectedly (${detail})${tail}`),
    { code: 'retrieval-start-failed' }
  );
}

function rejectAllPending(pending, error) {
  for (const [id, entry] of pending.entries()) {
    pending.delete(id);
    entry.cleanup();
    entry.reject(error);
  }
}

function emitCancelled(state, id, method, error) {
  if (!state.running || !state.writer || !shouldSendCancellationNotification(method)) return;
  try {
    state.writer.send(buildCancelledNotification(id, formatCancellationReason(error)));
  } catch { /* ignore closed pipe or backpressure while cancelling */ }
}

function cancelInFlightRequests(state) {
  for (const [id, entry] of state.pending.entries()) {
    emitCancelled(state, id, entry.method, 'Retrieval MCP client closing');
  }
}

function sendClientResponse(state, msg) {
  if (!state.writer) return;
  const reply = msg.method === 'ping'
    ? { jsonrpc: '2.0', id: msg.id, result: {} }
    : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unsupported client method: ${msg.method}` } };
  try {
    state.writer.send(reply);
  } catch { /* ignore closed pipe */ }
}

function handleJsonMessage(state, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (Object.hasOwn(msg, 'id') && typeof msg.method === 'string') {
    sendClientResponse(state, msg);
    return;
  }
  if (!Object.hasOwn(msg, 'id') || !state.pending.has(msg.id)) return;
  const entry = state.pending.get(msg.id);
  state.pending.delete(msg.id);
  entry.cleanup();
  if (msg.error) entry.reject(makeMcpError(msg.error));
  else entry.resolve(msg.result);
}

function handleRawStdoutLine(state, trimmed) {
  try {
    handleJsonMessage(state, JSON.parse(trimmed));
  } catch {
    state.stderrRing.push(`[non-json stdout] ${trimmed.slice(0, 200)}\n`);
  }
}

function sendJsonRpc(state, method, params, { signal, timeoutMs } = {}) {
  if (!state.running || !state.writer) {
    return Promise.reject(Object.assign(new Error('Retrieval MCP client is not running'), { code: 'retrieval-start-failed' }));
  }
  if (signal?.aborted) return Promise.reject(createMcpAbortError(signal));

  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error, notifyCancel = false) => {
      if (!state.pending.has(id)) return;
      state.pending.delete(id);
      cleanup();
      if (notifyCancel) emitCancelled(state, id, method, error);
      reject(error);
    };
    const onAbort = signal ? () => fail(createMcpAbortError(signal), true) : null;
    if (onAbort) signal.addEventListener('abort', onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        const timeoutErr = Object.assign(
          new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`),
          { code: 'retrieval-call-timeout' }
        );
        fail(timeoutErr, true);
      }, timeoutMs);
      timer.unref?.();
    }

    state.pending.set(id, { method, resolve, reject, cleanup });
    try {
      state.writer.send({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      fail(error, false);
    }
  });
}

async function listAllTools(state, initTimeoutMs) {
  const allTools = [];
  let cursor = undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
    const params = cursor ? { cursor } : {};
    const listed = await sendJsonRpc(state, 'tools/list', params, { timeoutMs: initTimeoutMs });
    allTools.push(...normalizeMcpTools(listed?.tools));
    cursor = typeof listed?.nextCursor === 'string' && listed.nextCursor ? listed.nextCursor : undefined;
    if (!cursor) break;
  }
  return allTools;
}

async function runHandshake(state, { initTimeoutMs, protocolVersion, supportedProtocolVersions }) {
  const initResult = await sendJsonRpc(
    state,
    'initialize',
    buildInitializeParams({ protocolVersion }),
    { timeoutMs: initTimeoutMs }
  );
  const negotiated = negotiateProtocolVersion(initResult?.protocolVersion, supportedProtocolVersions);
  if (!negotiated.ok) {
    throw Object.assign(new Error(negotiated.reason), { code: 'retrieval-protocol-unsupported' });
  }
  state.protocolVersion = negotiated.protocolVersion;
  state.writer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  state.cachedTools = await listAllTools(state, initTimeoutMs);
  return state.cachedTools;
}

function shutdownClientState(state, error, closeGraceMs) {
  if (state.closePromise) return state.closePromise;
  state.closing = true;
  cancelInFlightRequests(state);
  state.running = false;
  state.writer?.clear();
  state.writer = null;
  rejectAllPending(state.pending, error);
  const target = state.proc;
  state.proc = null;
  state.closePromise = gracefulTerminate(target, closeGraceMs).then(() => undefined);
  return state.closePromise;
}

function wireProcessStreams({ state, proc, maxLineBytes, closeGraceMs, onExit }) {
  const onOverflow = () => {
    const msg = `Retrieval MCP stdout line exceeded maximum allowed size (${maxLineBytes} bytes)`;
    state.stderrRing.push(`[stdout-overflow] ${msg}\n`);
    void shutdownClientState(state, Object.assign(new Error(msg), { code: 'retrieval-protocol-error' }), closeGraceMs);
  };
  const onStdout = createStdoutLineHandler({
    isRunning: () => state.running,
    getStdout: () => proc.stdout,
    maxLineBytes,
    onLine: (line) => handleRawStdoutLine(state, line),
    onOverflow,
  });
  const onStderr = (chunk) => state.stderrRing.push(chunk);
  proc.stdout?.on('data', onStdout);
  proc.stderr?.on('data', onStderr);
  proc.exited.then((outcome) => {
    proc.stdout?.off?.('data', onStdout);
    proc.stderr?.off?.('data', onStderr);
    const wasClosing = state.closing;
    state.running = false;
    state.writer?.clear();
    state.writer = null;
    rejectAllPending(state.pending, buildExitError(outcome, state.stderrRing.read()));
    if (!wasClosing && typeof onExit === 'function') {
      onExit({ ...outcome, stderr: state.stderrRing.read() });
    }
  });
}

/**
 * Create a JSON-RPC 2.0 NDJSON stdio MCP client (2024-11-05 / 2025-03-26) backed by `spawnPersistent`.
 */
export function createMcpStdioClient({
  command,
  args = [],
  cwd,
  env,
  spawnPersistent = defaultSpawnPersistent,
  initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS,
  defaultCallTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  closeGraceMs = DEFAULT_CLOSE_GRACE_MS,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxWriteBufferBytes = DEFAULT_MAX_WRITE_BUFFER_BYTES,
  protocolVersion = MCP_LATEST_PROTOCOL_VERSION,
  supportedProtocolVersions = MCP_SUPPORTED_PROTOCOL_VERSIONS,
  onExit = null,
}) {
  const state = {
    stderrRing: createStderrRing(maxStderrBytes),
    pending: new Map(),
    proc: null,
    writer: null,
    running: false,
    closing: false,
    nextId: 1,
    cachedTools: [],
    protocolVersion: null,
    closePromise: null,
  };

  function close() {
    const closedErr = Object.assign(new Error('Retrieval MCP client closed'), { code: 'retrieval-closed' });
    return shutdownClientState(state, closedErr, closeGraceMs);
  }

  async function start() {
    if (state.running) return state.cachedTools;
    state.closing = false;
    state.closePromise = null;
    state.protocolVersion = null;
    const proc = spawnPersistent({ command, args, cwd, env });
    state.proc = proc;
    state.writer = createLineWriter(proc, maxWriteBufferBytes);
    state.running = true;
    wireProcessStreams({ state, proc, maxLineBytes, closeGraceMs, onExit });

    try {
      return await runHandshake(state, { initTimeoutMs, protocolVersion, supportedProtocolVersions });
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
    return normalizeMcpToolResult(result);
  }

  return Object.freeze({
    start,
    close,
    callTool,
    listTools: () => [...state.cachedTools],
    isRunning: () => state.running,
    getProtocolVersion: () => state.protocolVersion,
    getStderr: () => state.stderrRing.read(),
    get pid() { return state.proc?.pid ?? null; },
  });
}
