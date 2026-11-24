/* Retrieval providers (WP28). StudyHub speaks one small contract to external
   providers (an MCP server or another plugin's `studyRetrieval` service), and
   also offers a zero-download local hybrid engine (`retrieveBuiltin`) combining
   `MiniSearch` + Node 22 `Intl.Segmenter('zh')` lexical indexing with
   `PageIndex` document-outline tree reasoning:

     retrieve({ query, sourceIds?, course?, libraryId?, limit, signal? })
       -> [{ sourceId?, page?, document?, text, score }]

   `sourceId` is a StudyHub source (one page of a document). A provider that
   indexes its own copy of the book may instead name the `document` (file name
   or title) and the `page`, or just return the `text`; resolveHits() matches
   those to StudyHub sources. Pure and host-free: the host adapter
   (lib/retrieval-host.js) supplies a `port` { tools(), call(name, args, { signal }),
   service() }. Providers:
     - 'mcp:<tool>'  a third-party MCP tool DSH exposes as mcp__<server>__<tool>;
     - 'service'     another plugin's cordis service `studyRetrieval` (RETRIEVAL_SERVICE);
     - 'builtin'     default no-op unless local hybrid is requested (`retrieveBuiltin` / `localHybrid: true`). */

import { createHash } from 'node:crypto';
import { createLexicalIndex } from './contexts/materials/retrieval-lexical.js';
import { treeRetrieveWithTrace } from './contexts/generation/retrieval/tree-retrieve.js';

/** Cordis service name another DSH plugin registers to act as a provider: { retrieve(request) -> hits }. */
export const RETRIEVAL_SERVICE = 'studyRetrieval';
export const DEFAULT_LIMIT = 12;
export const MAX_OVERSAMPLE_LIMIT = 200;
export const BUILTIN_RETRIEVAL_MODES = Object.freeze(['hybrid', 'lexical', 'tree']);

/** Legacy unscoped source URI prefix (`studyhub://source/<sourceId>`). */
export const SOURCE_PREFIX = 'studyhub://source/';
/** Library-isolated source URI prefix (`studyhub://lib/<libraryId>/source/<sourceId>`). */
export const SCOPED_SOURCE_PREFIX = 'studyhub://lib/';
/** Current index key namespace version (v2 isolates every library under `studyhub://lib/<libraryId>/source/<sourceId>`). */
export const INDEX_KEY_VERSION = 2;
/** Maximum safe cache filename length (bytes/chars) under NTFS 255-char hard limit, covering `.md` and `.meta.json`. */
export const MAX_CACHE_FILENAME_LENGTH = 240;

const LIBRARY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPED_SOURCE_RE = /^studyhub:\/\/lib\/([A-Za-z0-9_-]{1,64})\/source\/(.+)$/;
const HASHED_SOURCE_RE = /^~([0-9a-f]{32})$/;

/** Fixed-length 128-bit hex digest of a source id for NTFS-safe retrieval keys (#1451). */
export function sourceIdHash(id) {
  return createHash('sha256').update(String(id ?? '')).digest('hex').slice(0, 32);
}

/** Worst-case raw-data cache filename length produced by mcp-local-rag (`base64url(uri) + '.meta.json'`). */
export function cacheFilenameLength(uri) {
  return Buffer.from(String(uri ?? ''), 'utf8').toString('base64url').length + '.meta.json'.length;
}

/** Normalize an optional library identifier (rejecting non-strings such as array map indices). */
export function normalizeLibraryId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return LIBRARY_ID_RE.test(trimmed) ? trimmed : undefined;
}

/** The URI prefix for all sources indexed from `libraryId`, or the legacy prefix when omitted. */
export function scopedSourcePrefix(libraryId) {
  const lib = normalizeLibraryId(libraryId);
  return lib ? `${SCOPED_SOURCE_PREFIX}${lib}/source/` : SOURCE_PREFIX;
}

/** Unhashed legacy/direct index key for `id` (may exceed NTFS 255-char Base64 cache filenames for long document ids). */
export function legacySourceKey(id, libraryId) {
  return `${scopedSourcePrefix(libraryId)}${id}`;
}

/**
 * The canonical index key of `id`, isolated to `libraryId` when supplied.
 * Keeps short ids verbatim for backward compatibility and falls back to a fixed-length
 * SHA-256 short segment (`~<32hex>`) whenever Base64URL raw-data cache filenames would
 * exceed `MAX_CACHE_FILENAME_LENGTH` (240, safely under NTFS's 255-char limit, #1451).
 */
export function sourceKey(id, libraryId) {
  const direct = legacySourceKey(id, libraryId);
  if (cacheFilenameLength(direct) <= MAX_CACHE_FILENAME_LENGTH) return direct;
  return `${scopedSourcePrefix(libraryId)}~${sourceIdHash(id)}`;
}

/** Parse a StudyHub index URI (scoped v2, hashed short key, or legacy v1) into `{ libraryId, sourceId, sourceHash?, scoped, hashed? }`, else null. */
export function parseSourceKey(value) {
  if (typeof value !== 'string') return null;
  const scoped = SCOPED_SOURCE_RE.exec(value);
  if (scoped) {
    const hashed = HASHED_SOURCE_RE.exec(scoped[2]);
    if (hashed) return { libraryId: scoped[1], sourceId: null, sourceHash: hashed[1], scoped: true, hashed: true };
    return { libraryId: scoped[1], sourceId: scoped[2], scoped: true };
  }
  if (value.startsWith(SOURCE_PREFIX) && value.length > SOURCE_PREFIX.length) {
    const tail = value.slice(SOURCE_PREFIX.length);
    const hashed = HASHED_SOURCE_RE.exec(tail);
    if (hashed) return { libraryId: null, sourceId: null, sourceHash: hashed[1], scoped: false, hashed: true };
    return { libraryId: null, sourceId: tail, scoped: false };
  }
  return null;
}

/** Extract the source id from a StudyHub index URI; when `libraryId` is given, foreign-library keys return undefined. */
export function sourceIdFromKey(value, libraryId) {
  const parsed = parseSourceKey(value);
  if (!parsed || parsed.hashed) return undefined;
  const expected = normalizeLibraryId(libraryId);
  if (expected && parsed.scoped && parsed.libraryId !== expected) return undefined;
  return parsed.sourceId;
}

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const firstString = (source, keys) => { for (const key of keys) if (typeof source[key] === 'string' && source[key].trim()) return source[key].trim(); return undefined; };
const firstNumber = (source, keys) => { for (const key of keys) { const value = Number(source[key]); if (source[key] !== '' && source[key] !== null && source[key] !== undefined && Number.isFinite(value)) return value; } return undefined; };

export class RetrievalError extends Error {
  constructor(code, message) { super(message); this.name = 'RetrievalError'; this.code = code; }
}

/* ---------- passages ---------- */

const TEXT_KEYS = ['text', 'content', 'chunk', 'passage', 'snippet', 'information', 'body'];
const LIST_KEYS = ['results', 'items', 'passages', 'hits', 'matches', 'chunks', 'documents', 'data'];

function normalizeHit(raw, rank) {
  if (!isObject(raw)) return null;
  const text = firstString(raw, TEXT_KEYS);
  if (!text) return null;
  const hit = { text };
  const sourceId = firstString(raw, ['sourceId', 'source_id']);
  if (sourceId) hit.sourceId = sourceId;
  let page = firstNumber(raw, ['page', 'page_no', 'pageNo', 'pageNumber', 'page_number']);
  if (page === undefined) { const index = firstNumber(raw, ['page_idx', 'pageIndex', 'page_index']); if (index !== undefined) page = index + 1; }
  if (Number.isInteger(page) && page >= 1) hit.page = page;
  const rawSource = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : '';
  const document = (rawSource && parseSourceKey(rawSource))
    ? rawSource
    : firstString(raw, ['document', 'file', 'filePath', 'file_path', 'path', 'filename', 'fileName', 'source', 'title', 'document_title']);
  if (document) hit.document = document;
  let score = firstNumber(raw, ['score', 'relevance', 'similarity']);
  if (score === undefined) { const distance = firstNumber(raw, ['distance']); if (distance !== undefined) score = 1 / (1 + Math.max(0, distance)); }
  hit.score = score ?? 1 / (1 + rank);
  return hit;
}

/** Passages from whatever a provider returned: a list, or an object holding one under a common key. */
export function normalizeHits(raw, offset = 0) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (isObject(raw)) {
    const key = LIST_KEYS.find(name => Array.isArray(raw[name]));
    list = key ? raw[key] : [raw];
  }
  return list.map((entry, rank) => normalizeHit(entry, rank + offset)).filter(Boolean);
}

const ENTRY = /<entry>\s*<content>([\s\S]*?)<\/content>\s*(?:<metadata>([\s\S]*?)<\/metadata>)?\s*<\/entry>/;
const PAGE_HINT = /(?:第\s*(\d+)\s*页|\bpages?\s*[:#]?\s*(\d+)|\bp\.\s*(\d+))/i;

/** Passages from an MCP tool result ({ content: [...], structuredContent? }) as DSH's MCP client delivers it. */
export function hitsFromMcpResult(value) {
  if (!isObject(value)) return [];
  if (value.structuredContent !== undefined) {
    const structured = normalizeHits(value.structuredContent);
    if (structured.length) return structured;
  }
  const hits = [];
  let rank = 0;
  for (const block of Array.isArray(value.content) ? value.content : []) {
    const text = typeof block === 'string' ? block : isObject(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (trimmed[0] === '[' || trimmed[0] === '{') {
      try {
        const parsed = normalizeHits(JSON.parse(trimmed), rank);
        if (parsed.length) { hits.push(...parsed); rank += parsed.length; continue; }
      } catch { /* plain text that happens to start with a bracket */ }
    }
    const entry = ENTRY.exec(trimmed);
    if (entry) {
      let metadata = {};
      try { const parsed = JSON.parse(entry[2] || '{}'); if (isObject(parsed)) metadata = parsed; } catch { /* metadata is optional */ }
      const hit = normalizeHit({ ...metadata, text: entry[1].trim() }, rank++);
      if (hit) hits.push(hit);
      continue;
    }
    const hint = PAGE_HINT.exec(trimmed);
    const page = hint ? Number(hint[1] || hint[2] || hint[3]) : undefined;
    hits.push({ text: trimmed, ...(page >= 1 ? { page } : {}), score: 1 / (1 + rank++) });
  }
  return hits;
}

/* ---------- tool arguments ---------- */

const QUERY_ARGS = ['query', 'q', 'question', 'search', 'search_query', 'searchQuery', 'text', 'keywords', 'prompt', 'input'];
const LIMIT_ARGS = ['limit', 'top_k', 'topK', 'k', 'n', 'max_results', 'maxResults', 'num_results', 'numResults', 'count'];
const isStringArg = definition => !definition?.type || definition.type === 'string';
const isNumberArg = definition => definition?.type === 'integer' || definition?.type === 'number';

function resolveToolArgNames(schema, override = {}) {
  const properties = isObject(schema?.properties) ? schema.properties : {};
  const names = Object.keys(properties);
  const stringNames = names.filter(name => isStringArg(properties[name]));
  const queryArg = override.queryArg || QUERY_ARGS.find(name => name in properties && isStringArg(properties[name])) || (stringNames.length === 1 ? stringNames[0] : undefined);
  const limitArg = override.limitArg || LIMIT_ARGS.find(name => name in properties && isNumberArg(properties[name]));
  const supportsSourcePrefix = 'sourcePrefix' in properties && isStringArg(properties.sourcePrefix);
  return { properties, queryArg, limitArg, supportsSourcePrefix };
}

/**
 * The arguments to call a search tool with, from its JSON schema: the text
 * argument gets the query and a numeric one the limit. `override` ({ queryArg,
 * limitArg }) wins. A required argument StudyHub cannot fill in is refused so
 * the learner picks another tool.
 */
export function argsForTool(schema, { query, limit }, override = {}) {
  const { properties, queryArg, limitArg } = resolveToolArgNames(schema, override);
  for (const key of Array.isArray(schema?.required) ? schema.required : [])
    if (key !== queryArg && key !== limitArg && !('default' in (properties[key] || {})))
      throw new RetrievalError('retrieval-unsupported-tool', `这个检索工具需要一个 StudyHub 填不了的参数「${key}」，请在设置里换一个工具。`);
  if (!queryArg) throw new RetrievalError('retrieval-unsupported-tool', '这个工具没有可以放检索词的文字参数，请在设置里换一个工具。');
  return { [queryArg]: query, ...(limitArg ? { [limitArg]: limit } : {}) };
}

/* ---------- matching passages to StudyHub sources ---------- */

const collapse = value => String(value ?? '').replace(/\s+/g, '');
const nameOf = value => String(value ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(?:md|markdown|pdf|json|txt|docx|pptx?|html?)$/, '').replace(/\s+/g, '');
const PAGE_SUFFIX = /\s·\s(?:p\.\s?\d+|第\s?\d+\s?页)$/;

function documentsOf(sources) {
  const documents = new Map();
  for (const source of sources) {
    const info = source.document;
    if (!Number.isInteger(info?.page)) continue;
    const key = info.id || info.materialId || source.id;
    if (!documents.has(key)) documents.set(key, { names: new Set(), pages: new Map() });
    const entry = documents.get(key);
    for (const name of [info.bookTitle, info.filename, source.renamedFrom, String(source.title ?? '').replace(PAGE_SUFFIX, '')]) if (name) entry.names.add(nameOf(name));
    entry.pages.set(info.page, source);
  }
  return [...documents.values()];
}

/**
 * Match passages to StudyHub sources. By source id first; else by the document's
 * file name or title plus the page; a bare page number when the selection holds
 * one paged document; last, by finding the passage's own words in a source.
 * When `libraryId` is given, passages tagged with another library's scoped URI
 * (`studyhub://lib/<other>/source/<id>`) are strictly rejected and counted in
 * `foreignLibrary` (never matched by colliding `sourceId` or text).
 * Returns { passages: [{ sourceId, page, title, text, score, matchedBy }] best
 * first (one per source, keeping its best score), unresolved, foreignLibrary, legacyMatched? }.
 */
export function resolveHits(hits, sources, { libraryId } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const byId = new Map(list.map(source => [source.id, source]));
  const byHash = new Map(list.map(source => [sourceIdHash(source.id), source]));
  const documents = documentsOf(list);
  const expectedLib = normalizeLibraryId(libraryId);
  let collapsed;
  const best = new Map();
  let unresolved = 0;
  let foreignLibrary = 0;
  let legacyMatched = 0;
  const locate = hit => {
    const parsedDoc = parseSourceKey(hit.document);
    if (parsedDoc) {
      if (parsedDoc.scoped) {
        if (expectedLib && parsedDoc.libraryId !== expectedLib) return { foreign: true };
        const matched = parsedDoc.hashed ? byHash.get(parsedDoc.sourceHash) : byId.get(parsedDoc.sourceId);
        if (matched) return { source: matched, by: 'id' };
        return null;
      }
      const matched = parsedDoc.hashed ? byHash.get(parsedDoc.sourceHash) : byId.get(parsedDoc.sourceId);
      if (matched) return { source: matched, by: 'id', legacy: true };
      return null;
    }
    if (hit.sourceId && byId.has(hit.sourceId)) return { source: byId.get(hit.sourceId), by: 'id' };
    if (hit.page) {
      const wanted = hit.document ? nameOf(hit.document) : '';
      const candidates = wanted
        ? documents.filter(document => [...document.names].some(name => name === wanted || (name.length >= 3 && wanted.length >= 3 && (wanted.includes(name) || name.includes(wanted)))))
        : documents.length === 1 ? documents : [];
      const found = candidates.map(document => document.pages.get(hit.page)).find(Boolean);
      if (found) return { source: found, by: wanted ? 'document' : 'page' };
    }
    const probe = collapse(hit.text).slice(0, 40);
    if (probe.length >= 12) {
      collapsed ||= list.map(source => collapse(source.text));
      const index = collapsed.findIndex(text => text.includes(probe));
      if (index >= 0) return { source: list[index], by: 'text' };
    }
    return null;
  };
  for (const hit of hits) {
    const located = locate(hit);
    if (!located) { unresolved++; continue; }
    if (located.foreign) { unresolved++; foreignLibrary++; continue; }
    if (located.legacy) legacyMatched++;
    const { source, by } = located, known = best.get(source.id);
    if (!known || hit.score > known.score)
      best.set(source.id, { sourceId: source.id, page: source.document?.page, title: source.title, text: hit.text, score: hit.score, matchedBy: by });
  }
  return {
    passages: [...best.values()].sort((a, b) => b.score - a.score),
    unresolved,
    foreignLibrary,
    ...(legacyMatched ? { legacyMatched } : {}),
  };
}

/**
 * The sources to send: the best passages' sources until `budgetChars` of text is
 * reached (the first is always kept), in reading order. { sources, pages:
 * [{ sourceId, title, page, score }] in reading order, truncated, chars }.
 */
export function narrowSources(sources, passages, { budgetChars = 120000 } = {}) {
  const order = new Map(sources.map((source, index) => [source.id, index]));
  const byId = new Map(sources.map(source => [source.id, source]));
  const chosen = [];
  let chars = 0, truncated = false;
  for (const passage of passages) {
    const source = byId.get(passage.sourceId);
    if (!source || chosen.some(item => item.source.id === source.id)) continue;
    const size = String(source.text ?? '').length;
    if (chosen.length && chars + size > budgetChars) { truncated = true; continue; }
    chosen.push({ source, passage });
    chars += size;
  }
  chosen.sort((a, b) => order.get(a.source.id) - order.get(b.source.id));
  return { sources: chosen.map(item => item.source),
    pages: chosen.map(({ source, passage }) => ({ sourceId: source.id, title: source.title, page: source.document?.page ?? passage.page, score: passage.score })),
    truncated, chars };
}

/* ---------- providers ---------- */

const SEARCH_LIKE = /search|query|retriev|find|lookup|recall|(?:^|[_-])rag(?:$|[_-])/i;
const hasTextArg = tool => isObject(tool.parameters?.properties) && Object.values(tool.parameters.properties).some(isStringArg);

/**
 * What can be picked, from what the host exposes: { providers, otherTools }.
 * providers: the registered `studyRetrieval` service first, then MCP tools that
 * look like search tools [{ id, kind, label, tool?, server?, description }].
 * otherTools: remaining MCP tools (the learner may still choose one).
 */
export function describeProviders({ tools = [], service } = {}) {
  const providers = [], otherTools = [];
  if (service && typeof service.retrieve === 'function') providers.push({ id: 'service', kind: 'service', label: RETRIEVAL_SERVICE, description: '' });
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || !tool.name.startsWith('mcp__')) continue;
    const [, server = '', ...rest] = tool.name.split('__');
    const raw = rest.join('__');
    const entry = { id: `mcp:${tool.name}`, kind: 'mcp', label: raw || tool.name, tool: tool.name, server, description: String(tool.description ?? '').slice(0, 300) };
    if (hasTextArg(tool) && SEARCH_LIKE.test(`${raw} ${tool.description ?? ''}`)) providers.push(entry);
    else otherTools.push({ name: tool.name, server, label: raw || tool.name, description: entry.description });
  }
  return { providers, otherTools };
}

const missing = what => new RetrievalError('retrieval-missing', `已选择的检索工具「${what}」现在找不到。请确认它在 DSH 里已启用，或到设置里换一个。`);

/* ---------- zero-download local hybrid builtin engine ---------- */

const RRF_K = 30;
const LEXICAL_WEIGHT = 0.55;
const TREE_WEIGHT = 0.45;
const BUILTIN_EXCERPT_CHARS = 1600;

function normalizeBuiltinMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BUILTIN_RETRIEVAL_MODES.includes(mode) ? mode : 'hybrid';
}

function matchesCourseScope(source, courseLow) {
  if (!courseLow) return true;
  const list = Array.isArray(source?.courses)
    ? source.courses
    : typeof source?.course === 'string' && source.course.trim()
      ? [source.course]
      : [];
  if (!list.length) return true;
  return list.some(item => String(item ?? '').trim().toLowerCase() === courseLow);
}

function lexicalDocumentOf(source) {
  const primaryCourse = typeof source.course === 'string' && source.course.trim()
    ? source.course.trim()
    : Array.isArray(source.courses) && typeof source.courses[0] === 'string'
      ? source.courses[0].trim()
      : '';
  return {
    id: source.id,
    sourceId: source.id,
    title: String(source.title || source.document?.bookTitle || source.document?.filename || ''),
    text: String(source.text ?? ''),
    course: primaryCourse,
    page: Number.isInteger(source.document?.page) ? source.document.page : null,
  };
}

/**
 * Zero-download local retrieval for `provider: 'builtin'`.
 * Combines `MiniSearch` + Node 22 `Intl.Segmenter('zh')` lexical indexing with
 * `PageIndex` outline-tree reasoning (`mode`: `'hybrid' | 'lexical' | 'tree'`),
 * returning the same canonical `{ provider, query, limit, hits, passages, unresolved, diagnostics }`
 * shape produced by `retrieveFromPort()`.
 */
export async function retrieveBuiltin({
  query,
  sources = [],
  documents = null,
  state = null,
  course,
  libraryId,
  limit = DEFAULT_LIMIT,
  mode = 'hybrid',
  completeLight = null,
  whitelist = null,
  signal,
} = {}) {
  signal?.throwIfAborted();
  const cleanQuery = String(query ?? '').trim();
  const engineMode = normalizeBuiltinMode(mode);
  const lib = normalizeLibraryId(libraryId);
  const cap = Math.max(1, Math.min(MAX_OVERSAMPLE_LIMIT, Math.trunc(Number(limit)) || DEFAULT_LIMIT));
  const rawSources = Array.isArray(sources) && sources.length
    ? sources
    : Array.isArray(state?.sources)
      ? state.sources
      : [];
  const courseLow = typeof course === 'string' && course.trim() && course.trim() !== '*'
    ? course.trim().toLowerCase()
    : '';
  const scopedSources = rawSources.filter(source => (
    source && typeof source.id === 'string' && source.id.trim() && !source.archived && !source.historical
    && matchesCourseScope(source, courseLow)
  ));

  const emptyDiagnostics = {
    libraryId: lib || null,
    serverFiltered: false,
    oversampled: false,
    attempts: 1,
    fetchedLimit: cap,
    rawHits: 0,
    matchedPassages: 0,
    foreignLibraryHits: 0,
    unresolvedHits: 0,
    legacyMatched: 0,
    recallShortfall: false,
    engine: engineMode,
    lexicalHits: 0,
    treeHits: 0,
    usedModel: false,
    treeSize: 0,
    selectedNodes: [],
  };

  if (!cleanQuery || !scopedSources.length) {
    return {
      provider: 'builtin',
      query: cleanQuery,
      limit: cap,
      hits: 0,
      passages: [],
      unresolved: 0,
      diagnostics: emptyDiagnostics,
    };
  }

  const byId = new Map(scopedSources.map(source => [source.id, source]));
  const fetchLimit = Math.min(MAX_OVERSAMPLE_LIMIT, Math.max(cap * 2, 20));

  let lexicalHits = [];
  if (engineMode === 'hybrid' || engineMode === 'lexical') {
    const index = createLexicalIndex();
    index.upsertMany(scopedSources.map(lexicalDocumentOf));
    signal?.throwIfAborted();
    lexicalHits = index.search(cleanQuery, { limit: fetchLimit, snippetLength: 280 });
  }

  let treeTrace = { hits: [], selectedNodes: [], usedModel: false, reason: '', treeSize: 0 };
  if (engineMode === 'hybrid' || engineMode === 'tree') {
    signal?.throwIfAborted();
    treeTrace = await treeRetrieveWithTrace({
      query: cleanQuery,
      sources: scopedSources,
      documents: documents ?? state?.documents ?? null,
      state,
      course,
      sourceIds: scopedSources.map(source => source.id),
      limit: Math.min(100, fetchLimit),
      completeLight,
      whitelist,
      signal,
    });
  }
  signal?.throwIfAborted();

  const maxLexScore = lexicalHits.reduce((max, item) => Math.max(max, Number(item.score) || 0), 0) || 1;
  const maxTreeScore = treeTrace.hits.reduce((max, item) => Math.max(max, Number(item.score) || 0), 0) || 1;

  const candidates = new Map();
  const ensureCandidate = (sourceId) => {
    let entry = candidates.get(sourceId);
    if (!entry) {
      const source = byId.get(sourceId);
      entry = {
        sourceId,
        page: Number.isInteger(source?.document?.page) ? source.document.page : undefined,
        document: source?.document?.bookTitle || source?.document?.filename || source?.title,
        lexRank: -1,
        lexNorm: 0,
        lexSnippet: '',
        treeRank: -1,
        treeNorm: 0,
        treeText: '',
      };
      candidates.set(sourceId, entry);
    }
    return entry;
  };

  lexicalHits.forEach((hit, rank) => {
    if (!byId.has(hit.sourceId)) return;
    const entry = ensureCandidate(hit.sourceId);
    entry.lexRank = rank;
    entry.lexNorm = (Number(hit.score) || 0) / maxLexScore;
    entry.lexSnippet = hit.snippet || '';
    if (Number.isInteger(hit.page) && entry.page === undefined) entry.page = hit.page;
  });

  treeTrace.hits.forEach((hit, rank) => {
    if (!byId.has(hit.sourceId)) return;
    const entry = ensureCandidate(hit.sourceId);
    entry.treeRank = rank;
    entry.treeNorm = (Number(hit.score) || 0) / maxTreeScore;
    entry.treeText = hit.text || '';
    if (Number.isInteger(hit.page) && entry.page === undefined) entry.page = hit.page;
    if (hit.document && !entry.document) entry.document = hit.document;
  });

  const scored = [...candidates.values()].map(entry => {
    let rawScore;
    if (engineMode === 'lexical') {
      rawScore = entry.lexNorm;
    } else if (engineMode === 'tree') {
      rawScore = entry.treeNorm;
    } else {
      const lexRrf = entry.lexRank >= 0 ? LEXICAL_WEIGHT / (RRF_K + entry.lexRank + 1) : 0;
      const treeRrf = entry.treeRank >= 0 ? TREE_WEIGHT / (RRF_K + entry.treeRank + 1) : 0;
      rawScore = (lexRrf + treeRrf) * 15 + entry.lexNorm * LEXICAL_WEIGHT + entry.treeNorm * TREE_WEIGHT;
    }
    const source = byId.get(entry.sourceId);
    const text = entry.treeText || entry.lexSnippet || String(source?.text ?? '').trim().slice(0, BUILTIN_EXCERPT_CHARS);
    return {
      sourceId: entry.sourceId,
      ...(Number.isInteger(entry.page) ? { page: entry.page } : {}),
      ...(entry.document ? { document: entry.document } : {}),
      text,
      rawScore,
    };
  }).filter(item => item.text && item.rawScore > 0);

  scored.sort((a, b) => (
    b.rawScore - a.rawScore
    || (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER)
    || a.sourceId.localeCompare(b.sourceId)
  ));

  const top = scored.slice(0, cap);
  const topRawScore = top[0]?.rawScore || 1;
  const fusedHits = top.map(({ rawScore, ...hit }) => ({
    ...hit,
    score: Math.round(Math.min(1, Math.max(0.01, rawScore / topRawScore)) * 10000) / 10000,
  }));

  const resolved = resolveHits(fusedHits, scopedSources, { libraryId: lib });
  const diagnostics = {
    ...emptyDiagnostics,
    rawHits: fusedHits.length,
    matchedPassages: resolved.passages.length,
    foreignLibraryHits: resolved.foreignLibrary,
    unresolvedHits: resolved.unresolved,
    legacyMatched: resolved.legacyMatched || 0,
    lexicalHits: lexicalHits.length,
    treeHits: treeTrace.hits.length,
    usedModel: treeTrace.usedModel,
    treeSize: treeTrace.treeSize,
    selectedNodes: treeTrace.selectedNodes,
  };

  return {
    provider: 'builtin',
    query: cleanQuery,
    limit: cap,
    hits: fusedHits.length,
    passages: resolved.passages,
    unresolved: resolved.unresolved,
    diagnostics,
  };
}

/**
 * Factory for a drop-in `studyRetrieval` service provider (`{ retrieve(request) -> hits }`)
 * backed by the zero-download local hybrid engine (MiniSearch + PageIndex).
 */
export function createBuiltinRetriever(stateOrGetter, { mode = 'hybrid', completeLight = null, whitelist = null } = {}) {
  return {
    async retrieve({ query, sourceIds, course, libraryId, limit = DEFAULT_LIMIT, signal } = {}) {
      const state = typeof stateOrGetter === 'function' ? await stateOrGetter() : stateOrGetter;
      const allSources = Array.isArray(state?.sources) ? state.sources : Array.isArray(state) ? state : [];
      const wanted = Array.isArray(sourceIds) && sourceIds.length ? new Set(sourceIds) : null;
      const scoped = wanted ? allSources.filter(source => wanted.has(source?.id)) : allSources;
      const result = await retrieveBuiltin({
        query,
        sources: scoped,
        documents: Array.isArray(state?.documents) ? state.documents : null,
        state: Array.isArray(state) ? null : state,
        course,
        libraryId,
        limit,
        mode,
        completeLight,
        whitelist,
        signal,
      });
      return result.passages;
    },
  };
}

/**
 * Ask the chosen provider for passages and resolve them to `sources`.
 * settings: { provider: 'builtin' | 'service' | 'mcp:<tool>', queryArg?, limitArg?, localHybrid?, builtinMode? }.
 * request: { query, sources, course?, libraryId?, limit?, signal?, localHybrid?, builtinMode?, documents?, state?, completeLight?, whitelist? }.
 * Resolves null when no provider is chosen (`builtin` without local hybrid enabled) or the host has no port for
 * external providers (the caller keeps its own behaviour); rejects with a plain-words RetrievalError when the
 * chosen external provider is gone or fails.
 */
export async function retrieveFromPort(port, settings, {
  query,
  sources = [],
  course,
  libraryId,
  limit = DEFAULT_LIMIT,
  signal,
  localHybrid,
  builtinMode,
  documents,
  state,
  completeLight,
  whitelist,
} = {}) {
  const choice = settings?.provider || 'builtin';
  const useLocalBuiltin = choice === 'builtin'
    && Boolean(localHybrid ?? settings?.localHybrid ?? builtinMode ?? settings?.builtinMode);
  if (useLocalBuiltin) {
    return retrieveBuiltin({
      query,
      sources,
      documents,
      state,
      course,
      libraryId,
      limit,
      mode: builtinMode || settings?.builtinMode || 'hybrid',
      completeLight: completeLight ?? settings?.completeLight ?? null,
      whitelist,
      signal,
    });
  }
  if (!port || choice === 'builtin') return null;
  const lib = normalizeLibraryId(libraryId);
  const sourceIds = sources.map(source => source.id);
  const targetCount = sources.length > 0 ? Math.min(limit, sources.length) : limit;
  let hits = [];
  let resolved;
  let attempts = 1;
  let fetchedLimit = limit;
  let serverFiltered = false;

  if (choice === 'service') {
    const service = port.service?.();
    if (!service || typeof service.retrieve !== 'function') throw missing(RETRIEVAL_SERVICE);
    hits = normalizeHits(await service.retrieve({
      query,
      sourceIds,
      ...(course ? { course } : {}),
      ...(lib ? { libraryId: lib } : {}),
      limit,
      signal,
    }));
    resolved = resolveHits(hits, sources, { libraryId: lib });
  } else if (choice.startsWith('mcp:')) {
    const name = choice.slice(4);
    const tool = port.tools().find(entry => entry.name === name);
    if (!tool) throw missing(name);
    const { limitArg, supportsSourcePrefix } = resolveToolArgNames(tool.parameters, settings);
    const baseArgs = argsForTool(tool.parameters, { query, limit }, settings);
    if (lib && supportsSourcePrefix) {
      baseArgs.sourcePrefix = scopedSourcePrefix(lib);
      serverFiltered = true;
    }
    hits = hitsFromMcpResult(await port.call(name, baseArgs, { signal }));
    resolved = resolveHits(hits, sources, { libraryId: lib });

    // When a shared index returns foreign-library or out-of-scope hits that starve this library's recall,
    // adaptively oversample (bounded by MAX_OVERSAMPLE_LIMIT) to recover in-library passages.
    while (
      limitArg
      && attempts < 3
      && resolved.passages.length < targetCount
      && hits.length >= fetchedLimit
      && (resolved.foreignLibrary > 0 || resolved.unresolved > 0)
      && fetchedLimit < MAX_OVERSAMPLE_LIMIT
    ) {
      signal?.throwIfAborted();
      fetchedLimit = Math.min(MAX_OVERSAMPLE_LIMIT, Math.max(fetchedLimit * 3, limit * 2));
      attempts++;
      hits = hitsFromMcpResult(await port.call(name, { ...baseArgs, [limitArg]: fetchedLimit }, { signal }));
      resolved = resolveHits(hits, sources, { libraryId: lib });
    }
  } else return null;

  const diagnostics = {
    libraryId: lib || null,
    serverFiltered,
    oversampled: attempts > 1,
    attempts,
    fetchedLimit,
    rawHits: hits.length,
    matchedPassages: resolved.passages.length,
    foreignLibraryHits: resolved.foreignLibrary,
    unresolvedHits: resolved.unresolved,
    legacyMatched: resolved.legacyMatched || 0,
    recallShortfall: resolved.passages.length < targetCount && (resolved.foreignLibrary > 0 || resolved.unresolved > 0),
  };

  return {
    provider: choice,
    query,
    limit,
    hits: hits.length,
    passages: resolved.passages,
    unresolved: resolved.unresolved,
    diagnostics,
  };
}
