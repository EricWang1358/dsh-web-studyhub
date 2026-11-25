/** The companion's bounded ingest operation keeps the upstream source identity and rollback path. */
export const BATCH_TOOL = Object.freeze({
  name: 'ingest_data_batch',
  description: 'Index up to eight independent pages, then refresh the search index once. Returns ordered per-page results. Stops at the first failed page; a maintenanceError leaves the batch unconfirmed.',
  inputSchema: {
    type: 'object', required: ['items'], additionalProperties: false,
    properties: { items: { type: 'array', minItems: 1, maxItems: 8, items: {
      type: 'object', required: ['content', 'metadata'],
      properties: { content: { type: 'string', minLength: 1 }, metadata: {
        type: 'object', required: ['source', 'format'], properties: {
          source: { type: 'string', minLength: 1 }, format: { type: 'string', enum: ['text', 'html', 'markdown'] },
        },
      } },
    } } },
  },
});

export const DEFAULT_MAINTENANCE_COOLDOWN_MS = 15_000;
export const MAX_MAINTENANCE_COOLDOWN_MS = 5 * 60_000;
const MAX_QUERY_OVERSAMPLE = 200;
const LEGACY_SOURCE_PREFIX = 'studyhub://source/';

const messageOf = error => String(error?.message || error).slice(0, 300);

function augmentQueryTool(tool) {
  if (tool?.name !== 'query_documents' || !tool.inputSchema?.properties) return tool;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        sourcePrefix: {
          type: 'string',
          description: 'Optional StudyHub library URI prefix used to isolate results to one library.',
        },
      },
    },
  };
}

function sourceOfHit(entry) {
  if (!entry || typeof entry !== 'object') return '';
  for (const key of ['source', 'filePath', 'file_path', 'document', 'path']) {
    if (typeof entry[key] === 'string' && entry[key]) return entry[key];
  }
  return '';
}

function matchesPrefix(entry, sourcePrefix, includeLegacy) {
  const source = sourceOfHit(entry);
  if (!source) return false;
  if (source.startsWith(sourcePrefix)) return true;
  return Boolean(includeLegacy && source.startsWith(LEGACY_SOURCE_PREFIX));
}

function parseQueryReplyHits(reply) {
  if (Array.isArray(reply?.structuredContent)) {
    return { kind: 'structured-array', hits: reply.structuredContent };
  }
  if (Array.isArray(reply?.structuredContent?.results)) {
    return { kind: 'structured-results', hits: reply.structuredContent.results };
  }
  const blocks = Array.isArray(reply?.content) ? reply.content : [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const trimmed = block.text.trim();
    if (!trimmed || (trimmed[0] !== '[' && trimmed[0] !== '{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { kind: 'text-array', index: i, hits: parsed };
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.results)) {
        return { kind: 'text-results', index: i, wrapper: parsed, hits: parsed.results };
      }
    } catch { /* non-JSON text block */ }
  }
  return null;
}

function formatQueryReply(reply, parsed, filtered) {
  if (parsed.kind === 'structured-array') {
    return {
      ...reply,
      structuredContent: filtered,
      ...(Array.isArray(reply.content) && reply.content.length ? { content: [{ type: 'text', text: JSON.stringify(filtered) }] } : {}),
    };
  }
  if (parsed.kind === 'structured-results') {
    const nextStructured = { ...reply.structuredContent, results: filtered };
    return {
      ...reply,
      structuredContent: nextStructured,
      ...(Array.isArray(reply.content) && reply.content.length ? { content: [{ type: 'text', text: JSON.stringify(nextStructured) }] } : {}),
    };
  }
  const content = reply.content.slice();
  const payload = parsed.kind === 'text-results' ? { ...parsed.wrapper, results: filtered } : filtered;
  content[parsed.index] = { ...content[parsed.index], text: JSON.stringify(payload) };
  return { ...reply, content };
}

/** Wrap the pinned server at its public request-registration boundary; stock tools keep their handlers. */
export function createBatchRAGServer(RAGServer, {
  parseIngestDataInput,
  invalidInput,
  maintenanceRetryCooldownMs = DEFAULT_MAINTENANCE_COOLDOWN_MS,
  maxMaintenanceCooldownMs = MAX_MAINTENANCE_COOLDOWN_MS,
  now = () => Date.now(),
}) {
  return class extends RAGServer {
    constructor(...args) {
      super(...args);
      this.maintenanceFailure = null;
      this.maintenanceState = { failure: null, failedAt: 0, attempts: 0, nextRetryAt: 0 };
      this.maintenanceRecovery = null;
      const optimize = this.vectorStore.optimize.bind(this.vectorStore);
      this.vectorStore.optimize = async (...options) => {
        try {
          const result = await optimize(...options);
          this.maintenanceFailure = null;
          this.maintenanceState = { failure: null, failedAt: 0, attempts: 0, nextRetryAt: 0 };
          return result;
        } catch (error) {
          const failure = messageOf(error);
          const failedAt = now();
          const attempts = (this.maintenanceState?.attempts || 0) + 1;
          const baseCooldown = Math.max(0, Number(maintenanceRetryCooldownMs) || 0);
          const capCooldown = Math.max(baseCooldown, Number(maxMaintenanceCooldownMs) || baseCooldown);
          const cooldown = baseCooldown > 0
            ? Math.min(capCooldown, baseCooldown * (2 ** Math.min(attempts - 1, 6)))
            : 0;
          this.maintenanceFailure = failure;
          this.maintenanceState = { failure, failedAt, attempts, nextRetryAt: failedAt + cooldown };
          throw error;
        }
      };
    }

    getMaintenanceStatus() {
      return { healthy: !this.maintenanceFailure, ...this.maintenanceState };
    }

    setupHandlers() {
      const register = this.server.setRequestHandler;
      this.server.setRequestHandler = (schema, handler) => {
        const method = schema.shape?.method?.value;
        if (method === 'tools/list') {
          return register.call(this.server, schema, async (...args) => {
            const result = await handler(...args);
            const tools = Array.isArray(result?.tools) ? result.tools.map(augmentQueryTool) : [];
            return { ...result, tools: [...tools, BATCH_TOOL] };
          });
        }
        if (method === 'tools/call') {
          return register.call(this.server, schema, async (request, extra) => {
            if (request.params.name === BATCH_TOOL.name) return this.ingestBatch(request.params.arguments, extra);
            if (request.params.name === 'query_documents') return this.queryWhenIdle(handler, request, extra);
            return handler(request, extra);
          });
        }
        return register.call(this.server, schema, handler);
      };
      try { super.setupHandlers(); }
      finally { this.server.setRequestHandler = register; }
    }

    async waitForPromise(promise, signal) {
      signal?.throwIfAborted();
      let abort;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
      });
      try {
        await Promise.race([promise, cancelled]);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    }

    async waitForBatch(signal) {
      while (this.batchCompletion) {
        await this.waitForPromise(this.batchCompletion, signal);
      }
      signal?.throwIfAborted();
    }

    async maybeRecoverMaintenance(signal) {
      if (!this.maintenanceFailure) return true;
      if (this.maintenanceRecovery) {
        await this.waitForPromise(this.maintenanceRecovery, signal);
        return !this.maintenanceFailure;
      }
      if (now() < (this.maintenanceState?.nextRetryAt || 0)) return false;
      const overlap = this.acquireMutation();
      if (overlap !== null) return false;
      let complete;
      this.maintenanceRecovery = new Promise(resolve => { complete = resolve; });
      try {
        await Promise.all(this.activeQueries || []);
        signal?.throwIfAborted();
        await this.vectorStore.optimize();
        return true;
      } catch (error) {
        if (signal?.aborted) throw error;
        // Read-only queries stay unblocked even if background maintenance retry fails again;
        // exponential cooldown has already been updated by the wrapped optimize() handler.
        return false;
      } finally {
        complete?.();
        this.maintenanceRecovery = null;
        this.releaseMutation();
      }
    }

    async executeScopedQuery(handler, request, extra) {
      const rawArgs = request?.params?.arguments;
      const sourcePrefix = typeof rawArgs?.sourcePrefix === 'string' && rawArgs.sourcePrefix ? rawArgs.sourcePrefix : null;
      if (!sourcePrefix) return handler(request, extra);
      const includeLegacy = rawArgs.includeLegacy === true;
      const { sourcePrefix: _prefix, includeLegacy: _legacy, ...cleanArgs } = rawArgs;
      const requestedLimit = Number.isInteger(Number(cleanArgs.limit)) && Number(cleanArgs.limit) > 0
        ? Number(cleanArgs.limit)
        : 10;
      const firstLimit = Math.min(MAX_QUERY_OVERSAMPLE, Math.max(requestedLimit * 4, 40));
      const fetchLimits = firstLimit < MAX_QUERY_OVERSAMPLE ? [firstLimit, MAX_QUERY_OVERSAMPLE] : [firstLimit];
      let lastReply = null;
      let lastParsed = null;
      let filtered = [];
      for (const fetchLimit of fetchLimits) {
        extra?.signal?.throwIfAborted();
        const scopedRequest = {
          ...request,
          params: {
            ...request.params,
            arguments: { ...cleanArgs, limit: fetchLimit },
          },
        };
        const reply = await handler(scopedRequest, extra);
        const parsed = parseQueryReplyHits(reply);
        if (!parsed) return reply;
        lastReply = reply;
        lastParsed = parsed;
        filtered = parsed.hits.filter(entry => matchesPrefix(entry, sourcePrefix, includeLegacy));
        if (filtered.length >= requestedLimit || parsed.hits.length < fetchLimit) break;
      }
      return lastReply && lastParsed ? formatQueryReply(lastReply, lastParsed, filtered.slice(0, requestedLimit)) : lastReply;
    }

    async queryWhenIdle(handler, request, extra) {
      do {
        await this.waitForBatch(extra?.signal);
        if (this.maintenanceFailure) await this.maybeRecoverMaintenance(extra?.signal);
      } while (this.batchCompletion);
      extra?.signal?.throwIfAborted();
      let complete;
      const completion = new Promise(resolve => { complete = resolve; });
      this.activeQueries ??= new Set();
      this.activeQueries.add(completion);
      try { return await this.executeScopedQuery(handler, request, extra); }
      finally { this.activeQueries.delete(completion); complete(); }
    }

    async ingestBatch(raw, extra) {
      const overlap = this.acquireMutation();
      if (overlap !== null) return overlap;
      let complete;
      const result = { results: [] };
      try {
        if (!Array.isArray(raw?.items) || raw.items.length < 1 || raw.items.length > 8) {
          throw invalidInput('items must contain between one and eight pages');
        }
        const items = raw.items.map(parseIngestDataInput);
        const optimize = this.vectorStore.optimize;
        this.batchCompletion = new Promise(resolve => { complete = resolve; });
        // Queries may still be embedding before their first database read.
        await Promise.all(this.activeQueries || []);
        this.vectorStore.optimize = async () => {};
        try {
          for (const item of items) {
            if (extra?.signal?.aborted) { result.cancelled = true; break; }
            const source = item.metadata.source;
            try {
              await this.handleIngestData(item);
              result.results.push({ source, status: 'indexed' });
            } catch (error) {
              const message = messageOf(error);
              if (/No chunks generated/i.test(message)) result.results.push({ source, status: 'no-chunks', message });
              else { result.results.push({ source, status: 'failed', message }); break; }
            }
          }
        } finally {
          this.vectorStore.optimize = optimize;
          try { await optimize.call(this.vectorStore); }
          catch (error) { result.maintenanceError = messageOf(error); }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } finally {
        complete?.(result.maintenanceError);
        this.batchCompletion = null;
        this.releaseMutation();
      }
    }
  };
}
