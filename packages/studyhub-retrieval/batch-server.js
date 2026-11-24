import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

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
/** Strict filename ceiling under NTFS's 255-character single-filename limit (covers both `.md` and `.meta.json`). */
export const MAX_CACHE_FILENAME_BYTES = 240;
/** Fixed-length short source URI prefix used internally for raw-data cache filenames (`sh://<32hex>` -> 53-char `.md`, 60-char `.meta.json`). */
export const SHORT_CACHE_PREFIX = 'sh://';
const NTFS_FILENAME_HARD_LIMIT = 255;
const SOURCE_MAP_FILENAME = 'source-map.json';
const MAX_QUERY_OVERSAMPLE = 200;
const LEGACY_SOURCE_PREFIX = 'studyhub://source/';

const messageOf = error => String(error?.message || error).slice(0, 300);

/** Mirror mcp-local-rag's normalizeSource so cache filename calculations match disk paths exactly. */
function normalizeRawSource(source) {
  const text = String(source ?? '');
  try {
    const parsed = new URL(text);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return text;
  } catch {
    return text;
  }
}

function encodeBase64Url(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function decodeBase64Url(value) {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/** Worst-case physical filename length inside `<dbPath>/raw-data/` (`base64url(source) + '.meta.json'`). */
export function rawDataFilenameLength(source) {
  return encodeBase64Url(normalizeRawSource(source)).length + '.meta.json'.length;
}

/** Deterministic fixed-length short cache key (`sh://<32hex>`) whose Base64URL cache filenames stay <= 60 chars. */
export function shortCacheKey(source) {
  const normalized = normalizeRawSource(source);
  if (normalized.startsWith(SHORT_CACHE_PREFIX)) return normalized;
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return `${SHORT_CACHE_PREFIX}${digest}`;
}

/** Pre-write filename length guard (#1451): fails with an explicit length error instead of NTFS ENOENT. */
export function assertSafeCacheFilename(storageSource, originalSource = storageSource) {
  const len = rawDataFilenameLength(storageSource);
  if (len > MAX_CACHE_FILENAME_BYTES) {
    throw new Error(`cache file name too long (${len} > ${MAX_CACHE_FILENAME_BYTES}): ${originalSource}`);
  }
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (2 ** attempt)));
    }
  }
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

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

function extractRawDataSource(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.includes('/raw-data/')) return '';
  const name = basename(normalized);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return decodeBase64Url(name.slice(0, dot));
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
      this.sourceMap = new Map();
      this.sourceMapLoaded = false;
      this.sourceMapDirty = false;
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

    sourceMapPath() {
      return typeof this.dbPath === 'string' && this.dbPath ? join(this.dbPath, SOURCE_MAP_FILENAME) : null;
    }

    shouldShortenSource(source) {
      if (typeof source !== 'string' || !source || source.startsWith(SHORT_CACHE_PREFIX)) return false;
      return Boolean(this.dbPath) || rawDataFilenameLength(source) > MAX_CACHE_FILENAME_BYTES;
    }

    toStorageSource(source) {
      return this.shouldShortenSource(source) ? shortCacheKey(source) : source;
    }

    async ensureSourceMapLoaded() {
      if (this.sourceMapLoaded) return;
      this.sourceMapLoaded = true;
      const mapPath = this.sourceMapPath();
      if (!mapPath) return;
      try {
        const raw = await readFile(mapPath, 'utf8');
        const parsed = JSON.parse(raw);
        const byKey = parsed && typeof parsed === 'object' && parsed.byKey && typeof parsed.byKey === 'object'
          ? parsed.byKey
          : null;
        if (!byKey) return;
        for (const [key, value] of Object.entries(byKey)) {
          if (typeof key === 'string' && key.startsWith(SHORT_CACHE_PREFIX) && typeof value === 'string' && value) {
            this.sourceMap.set(key, value);
          }
        }
      } catch {
        // Missing or unreadable source-map degrades gracefully; new writes recreate it atomically.
      }
    }

    recordSourceMapping(storageSource, originalSource) {
      if (storageSource === originalSource) return;
      if (this.sourceMap.get(storageSource) === originalSource) return;
      this.sourceMap.set(storageSource, originalSource);
      this.sourceMapDirty = true;
    }

    deleteSourceMapping(storageSource) {
      if (!this.sourceMap.delete(storageSource)) return;
      this.sourceMapDirty = true;
    }

    async flushSourceMap() {
      if (!this.sourceMapDirty) return;
      const mapPath = this.sourceMapPath();
      if (!mapPath) {
        this.sourceMapDirty = false;
        return;
      }
      await mkdir(this.dbPath, { recursive: true });
      const payload = `${JSON.stringify({ version: 1, byKey: Object.fromEntries(this.sourceMap.entries()) }, null, 2)}\n`;
      const tempPath = `${mapPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, payload, 'utf8');
        await renameWithRetry(tempPath, mapPath);
        this.sourceMapDirty = false;
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        throw error;
      }
    }

    legacyRawDataPaths(originalSource) {
      if (!this.dbPath || typeof originalSource !== 'string' || !originalSource) return null;
      if (rawDataFilenameLength(originalSource) > NTFS_FILENAME_HARD_LIMIT) return null;
      const mdPath = resolve(this.dbPath, 'raw-data', `${encodeBase64Url(normalizeRawSource(originalSource))}.md`);
      return { mdPath, metaPath: mdPath.replace(/\.md$/, '.meta.json') };
    }

    async cleanupLegacyCacheEntry(originalSource, { optimize = false } = {}) {
      const legacy = this.legacyRawDataPaths(originalSource);
      if (!legacy) return false;
      const [mdExists, metaExists] = await Promise.all([fileExists(legacy.mdPath), fileExists(legacy.metaPath)]);
      if (!mdExists && !metaExists) return false;
      let removedChunks = 0;
      if (typeof this.vectorStore?.deleteChunks === 'function') {
        try {
          removedChunks = Number(await this.vectorStore.deleteChunks(legacy.mdPath)) || 0;
        } catch { /* best-effort legacy chunk cleanup */ }
      }
      if (optimize && removedChunks > 0 && typeof this.vectorStore?.optimize === 'function') {
        try { await this.vectorStore.optimize(); } catch { /* maintenance state tracks failures */ }
      }
      await unlink(legacy.mdPath).catch(() => {});
      await unlink(legacy.metaPath).catch(() => {});
      return true;
    }

    restoreHitSource(entry) {
      if (!entry || typeof entry !== 'object') return entry;
      const candidates = [entry.source, entry.filePath, extractRawDataSource(entry.filePath)];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !candidate.startsWith(SHORT_CACHE_PREFIX)) continue;
        const original = this.sourceMap.get(candidate);
        if (!original) continue;
        const next = { ...entry, source: original };
        if (entry.filePath === candidate) next.filePath = original;
        return next;
      }
      return entry;
    }

    restoreQueryReply(reply) {
      if (!this.sourceMap.size) return reply;
      const parsed = parseQueryReplyHits(reply);
      if (!parsed) return reply;
      const restored = parsed.hits.map(entry => this.restoreHitSource(entry));
      return formatQueryReply(reply, parsed, restored);
    }

    async ingestSingleMapped(handler, request, extra) {
      await this.ensureSourceMapLoaded();
      const rawArgs = request?.params?.arguments;
      const originalSource = typeof rawArgs?.metadata?.source === 'string' ? rawArgs.metadata.source : '';
      const storageSource = originalSource ? this.toStorageSource(originalSource) : originalSource;
      if (storageSource) assertSafeCacheFilename(storageSource, originalSource);
      const mappedRequest = storageSource !== originalSource
        ? {
          ...request,
          params: {
            ...request.params,
            arguments: { ...rawArgs, metadata: { ...rawArgs.metadata, source: storageSource } },
          },
        }
        : request;
      const reply = await handler(mappedRequest, extra);
      if (!reply?.isError && storageSource && storageSource !== originalSource) {
        this.recordSourceMapping(storageSource, originalSource);
        await this.flushSourceMap();
        await this.cleanupLegacyCacheEntry(originalSource, { optimize: true });
      }
      return reply;
    }

    async deleteMapped(handler, request, extra) {
      await this.ensureSourceMapLoaded();
      const rawArgs = request?.params?.arguments;
      const originalSource = typeof rawArgs?.source === 'string' ? rawArgs.source : '';
      if (!originalSource) return handler(request, extra);
      const storageSource = this.toStorageSource(originalSource);
      if (storageSource === originalSource) return handler(request, extra);
      const mappedRequest = {
        ...request,
        params: {
          ...request.params,
          arguments: { ...rawArgs, source: storageSource },
        },
      };
      const reply = await handler(mappedRequest, extra);
      if (!reply?.isError) {
        this.deleteSourceMapping(storageSource);
        await this.flushSourceMap();
        // Also remove any legacy Base64 cache entry created before fixed-length short keys (#1451).
        const legacy = this.legacyRawDataPaths(originalSource);
        if (legacy && (await fileExists(legacy.mdPath) || await fileExists(legacy.metaPath))) {
          await handler(request, extra).catch(() => {});
        }
      }
      return reply;
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
            if (request.params.name === 'ingest_data') return this.ingestSingleMapped(handler, request, extra);
            if (request.params.name === 'delete_file') return this.deleteMapped(handler, request, extra);
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
      await this.ensureSourceMapLoaded();
      const rawArgs = request?.params?.arguments;
      const sourcePrefix = typeof rawArgs?.sourcePrefix === 'string' && rawArgs.sourcePrefix ? rawArgs.sourcePrefix : null;
      if (!sourcePrefix) return this.restoreQueryReply(await handler(request, extra));
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
        const restoredHits = this.sourceMap.size ? parsed.hits.map(entry => this.restoreHitSource(entry)) : parsed.hits;
        lastReply = reply;
        lastParsed = parsed;
        filtered = restoredHits.filter(entry => matchesPrefix(entry, sourcePrefix, includeLegacy));
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
        await this.ensureSourceMapLoaded();
        if (!Array.isArray(raw?.items) || raw.items.length < 1 || raw.items.length > 8) {
          throw invalidInput('items must contain between one and eight pages');
        }
        const items = raw.items.map(parseIngestDataInput);
        const optimize = this.vectorStore.optimize;
        this.batchCompletion = new Promise(resolve => { complete = resolve; });
        // Queries may still be embedding before their first database read.
        await Promise.all(this.activeQueries || []);
        this.vectorStore.optimize = async () => {};
        const migratedLegacySources = [];
        try {
          for (const item of items) {
            if (extra?.signal?.aborted) { result.cancelled = true; break; }
            const source = item.metadata.source;
            const storageSource = this.toStorageSource(source);
            try {
              assertSafeCacheFilename(storageSource, source);
              const mappedItem = storageSource !== source
                ? { ...item, metadata: { ...item.metadata, source: storageSource } }
                : item;
              await this.handleIngestData(mappedItem);
              if (storageSource !== source) {
                this.recordSourceMapping(storageSource, source);
                migratedLegacySources.push(source);
              }
              result.results.push({ source, status: 'indexed' });
            } catch (error) {
              const message = messageOf(error);
              if (/No chunks generated/i.test(message)) result.results.push({ source, status: 'no-chunks', message });
              else { result.results.push({ source, status: 'failed', message }); break; }
            }
          }
          for (const migratedSource of migratedLegacySources) {
            await this.cleanupLegacyCacheEntry(migratedSource);
          }
        } finally {
          await this.flushSourceMap().catch(error => {
            if (!result.maintenanceError) result.maintenanceError = messageOf(error);
          });
          this.vectorStore.optimize = optimize;
          try { await optimize.call(this.vectorStore); }
          catch (error) { if (!result.maintenanceError) result.maintenanceError = messageOf(error); }
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
