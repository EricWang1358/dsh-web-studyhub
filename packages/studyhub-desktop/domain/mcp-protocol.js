// @ts-check

export const MCP_LATEST_PROTOCOL_VERSION = '2025-03-26';
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-03-26',
  '2024-11-05',
]);

/**
 * Negotiate an MCP protocol version per the 2024-11-05 / 2025-03-26 lifecycle spec.
 * @param {unknown} serverVersion
 * @param {readonly string[]} [supportedVersions]
 * @returns {{ ok: true, protocolVersion: string } | { ok: false, reason: string }}
 */
export function negotiateProtocolVersion(
  serverVersion,
  supportedVersions = MCP_SUPPORTED_PROTOCOL_VERSIONS
) {
  if (typeof serverVersion !== 'string' || !serverVersion.trim()) {
    return { ok: false, reason: 'MCP server did not return a protocolVersion' };
  }
  const normalized = serverVersion.trim();
  if (!supportedVersions.includes(normalized)) {
    return {
      ok: false,
      reason: `Unsupported MCP protocolVersion "${normalized}" (supported: ${supportedVersions.join(', ')})`,
    };
  }
  return { ok: true, protocolVersion: normalized };
}

/**
 * Per MCP 2024-11-05 / 2025-03-26 cancellation rules, clients MUST NOT cancel `initialize`.
 * @param {string} method
 * @returns {boolean}
 */
export function shouldSendCancellationNotification(method) {
  return typeof method === 'string' && method !== 'initialize';
}

/**
 * Extract a concise human-readable reason string for `notifications/cancelled`.
 * @param {unknown} error
 * @returns {string}
 */
export function formatCancellationReason(error) {
  if (error instanceof Error && error.message) return error.message.slice(0, 300);
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 300);
  return 'Request cancelled by client';
}

/**
 * Build a JSON-RPC 2.0 `notifications/cancelled` payload.
 * @param {string | number} requestId
 * @param {string} [reason]
 * @returns {{ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: string | number, reason?: string } }}
 */
export function buildCancelledNotification(requestId, reason = '') {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: {
      requestId,
      ...(trimmed ? { reason: trimmed } : {}),
    },
  };
}

/**
 * Build an MCP `initialize` request params object.
 * @param {{ protocolVersion?: string, clientName?: string, clientVersion?: string }} [options]
 */
export function buildInitializeParams({
  protocolVersion = MCP_LATEST_PROTOCOL_VERSION,
  clientName = 'studyhub-desktop',
  clientVersion = '1.0.0',
} = {}) {
  return {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: clientName, version: clientVersion },
  };
}

/**
 * Normalize an MCP JSON-RPC error object into a standard Error instance.
 * @param {any} errPayload
 */
export function makeMcpError(errPayload) {
  const message = typeof errPayload?.message === 'string' && errPayload.message
    ? errPayload.message
    : 'MCP server returned an error';
  /** @type {Error & { code?: unknown, mcpData?: unknown }} */
  const error = new Error(message);
  if (errPayload?.code !== undefined) error.code = errPayload.code;
  if (errPayload?.data !== undefined) error.mcpData = errPayload.data;
  return error;
}

/**
 * Create an AbortError preserving the original AbortSignal reason when present.
 * @param {AbortSignal | undefined} signal
 */
export function createMcpAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const message = typeof reason === 'string' && reason ? reason : 'Retrieval tool call aborted';
  return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' });
}

/**
 * Normalize MCP `tools/list` response entries.
 * @param {unknown} rawTools
 */
export function normalizeMcpTools(rawTools) {
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

/**
 * Normalize an MCP `tools/call` response payload.
 * @param {any} result
 */
export function normalizeMcpToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return {
    content,
    ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result?.isError ? { isError: true } : {}),
  };
}
