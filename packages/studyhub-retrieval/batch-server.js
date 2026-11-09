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

const messageOf = error => String(error?.message || error).slice(0, 300);

/** Wrap the pinned server at its public request-registration boundary; stock tools keep their handlers. */
export function createBatchRAGServer(RAGServer, { parseIngestDataInput, invalidInput }) {
  return class extends RAGServer {
    constructor(...args) {
      super(...args);
      const optimize = this.vectorStore.optimize.bind(this.vectorStore);
      this.vectorStore.optimize = async (...options) => {
        try {
          const result = await optimize(...options);
          this.maintenanceFailure = null;
          return result;
        } catch (error) { this.maintenanceFailure = messageOf(error); throw error; }
      };
    }

    setupHandlers() {
      const register = this.server.setRequestHandler;
      this.server.setRequestHandler = (schema, handler) => {
        const method = schema.shape?.method?.value;
        if (method === 'tools/list') {
          return register.call(this.server, schema, async (...args) => {
            const result = await handler(...args);
            return { ...result, tools: [...result.tools, BATCH_TOOL] };
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

    async waitForBatch(signal) {
      while (this.batchCompletion) {
        signal?.throwIfAborted();
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal?.addEventListener('abort', abort, { once: true });
        });
        try {
          const error = await Promise.race([this.batchCompletion, cancelled]);
          if (error) throw new Error(error);
        } finally { signal?.removeEventListener('abort', abort); }
      }
      signal?.throwIfAborted();
      if (this.maintenanceFailure) throw new Error(this.maintenanceFailure);
    }

    async queryWhenIdle(handler, request, extra) {
      do { await this.waitForBatch(extra?.signal); } while (this.batchCompletion);
      extra?.signal?.throwIfAborted();
      let complete;
      const completion = new Promise(resolve => { complete = resolve; });
      this.activeQueries ??= new Set();
      this.activeQueries.add(completion);
      try { return await handler(request, extra); }
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
