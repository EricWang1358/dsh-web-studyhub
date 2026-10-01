/* Retrieval providers (WP28). StudyHub does not build a search index of its own:
   a large textbook is searched by a tool the learner already runs in DSH (an MCP
   server) or by another plugin's service, and StudyHub only speaks one small
   contract to them.

     retrieve({ query, sourceIds?, course?, limit, signal? })
       -> [{ sourceId?, page?, document?, text, score }]

   `sourceId` is a StudyHub source (one page of a document). A provider that
   indexes its own copy of the book may instead name the `document` (file name
   or title) and the `page`, or just return the `text`; resolveHits() matches
   those to StudyHub sources. Pure and host-free: the host adapter
   (lib/retrieval-host.js) supplies a `port` { tools(), call(name, args, { signal }),
   service() }. Providers:
     - 'mcp:<tool>'  a third-party MCP tool DSH exposes as mcp__<server>__<tool>;
     - 'service'     another plugin's cordis service `studyRetrieval` (RETRIEVAL_SERVICE);
     - 'builtin'     no retrieval: StudyHub's own behaviour (the caller sends the selection). */

/** Cordis service name another DSH plugin registers to act as a provider: { retrieve(request) -> hits }. */
export const RETRIEVAL_SERVICE = 'studyRetrieval';
export const DEFAULT_LIMIT = 12;

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
  const document = firstString(raw, ['document', 'file', 'filePath', 'file_path', 'path', 'filename', 'fileName', 'source', 'title', 'document_title']);
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

/**
 * The arguments to call a search tool with, from its JSON schema: the text
 * argument gets the query and a numeric one the limit. `override` ({ queryArg,
 * limitArg }) wins. A required argument StudyHub cannot fill in is refused so
 * the learner picks another tool.
 */
export function argsForTool(schema, { query, limit }, override = {}) {
  const properties = isObject(schema?.properties) ? schema.properties : {};
  const names = Object.keys(properties);
  const stringNames = names.filter(name => isStringArg(properties[name]));
  const queryArg = override.queryArg || QUERY_ARGS.find(name => name in properties && isStringArg(properties[name])) || (stringNames.length === 1 ? stringNames[0] : undefined);
  const limitArg = override.limitArg || LIMIT_ARGS.find(name => name in properties && isNumberArg(properties[name]));
  for (const key of Array.isArray(schema?.required) ? schema.required : [])
    if (key !== queryArg && key !== limitArg && !('default' in (properties[key] || {})))
      throw new RetrievalError('retrieval-unsupported-tool', `这个检索工具需要一个 StudyHub 填不了的参数「${key}」，请在设置里换一个工具。`);
  if (!queryArg) throw new RetrievalError('retrieval-unsupported-tool', '这个工具没有可以放检索词的文字参数，请在设置里换一个工具。');
  return { [queryArg]: query, ...(limitArg ? { [limitArg]: limit } : {}) };
}

/* ---------- matching passages to StudyHub sources ---------- */

const collapse = value => String(value ?? '').replace(/\s+/g, '');
const nameOf = value => String(value ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(?:md|markdown|pdf|json|txt|docx|pptx|html?)$/, '').replace(/\s+/g, '');
const PAGE_SUFFIX = /\s·\s(?:p\.\s?\d+|第\s?\d+\s?页)$/;

function documentsOf(sources) {
  const documents = new Map();
  for (const source of sources) {
    const info = source.document;
    if (!Number.isInteger(info?.page)) continue;
    const key = info.id || info.materialId || source.id;
    if (!documents.has(key)) documents.set(key, { names: new Set(), pages: new Map() });
    const entry = documents.get(key);
    for (const name of [info.bookTitle, info.filename, String(source.title ?? '').replace(PAGE_SUFFIX, '')]) if (name) entry.names.add(nameOf(name));
    entry.pages.set(info.page, source);
  }
  return [...documents.values()];
}

/**
 * Match passages to StudyHub sources. By source id first; else by the document's
 * file name or title plus the page; a bare page number when the selection holds
 * one paged document; last, by finding the passage's own words in a source.
 * Returns { passages: [{ sourceId, page, title, text, score, matchedBy }] best
 * first (one per source, keeping its best score), unresolved } where unresolved
 * counts passages that matched nothing.
 */
export function resolveHits(hits, sources) {
  const list = Array.isArray(sources) ? sources : [];
  const byId = new Map(list.map(source => [source.id, source]));
  const documents = documentsOf(list);
  let collapsed;
  const best = new Map();
  let unresolved = 0;
  const KEY = 'studyhub://source/';
  const locate = hit => {
    if (hit.sourceId && byId.has(hit.sourceId)) return { source: byId.get(hit.sourceId), by: 'id' };
    // A page indexed by StudyHub's own search extension carries its source id in the file/source field (WP28b).
    if (typeof hit.document === 'string' && hit.document.startsWith(KEY) && byId.has(hit.document.slice(KEY.length))) return { source: byId.get(hit.document.slice(KEY.length)), by: 'id' };
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
    const { source, by } = located, known = best.get(source.id);
    if (!known || hit.score > known.score)
      best.set(source.id, { sourceId: source.id, page: source.document?.page, title: source.title, text: hit.text, score: hit.score, matchedBy: by });
  }
  return { passages: [...best.values()].sort((a, b) => b.score - a.score), unresolved };
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

/**
 * Ask the chosen provider for passages and resolve them to `sources`.
 * settings: { provider: 'builtin' | 'service' | 'mcp:<tool>', queryArg?, limitArg? }.
 * request: { query, sources, course?, limit?, signal? }. Resolves null when no
 * provider is chosen or the host has no port (the caller keeps its own behaviour);
 * rejects with a plain-words RetrievalError when the chosen provider is gone or fails.
 */
export async function retrieveFromPort(port, settings, { query, sources = [], course, limit = DEFAULT_LIMIT, signal } = {}) {
  const choice = settings?.provider || 'builtin';
  if (!port || choice === 'builtin') return null;
  const sourceIds = sources.map(source => source.id);
  let hits;
  if (choice === 'service') {
    const service = port.service?.();
    if (!service || typeof service.retrieve !== 'function') throw missing(RETRIEVAL_SERVICE);
    hits = normalizeHits(await service.retrieve({ query, sourceIds, ...(course ? { course } : {}), limit, signal }));
  } else if (choice.startsWith('mcp:')) {
    const name = choice.slice(4);
    const tool = port.tools().find(entry => entry.name === name);
    if (!tool) throw missing(name);
    const args = argsForTool(tool.parameters, { query, limit }, settings);
    hits = hitsFromMcpResult(await port.call(name, args, { signal }));
  } else return null;
  const { passages, unresolved } = resolveHits(hits, sources);
  return { provider: choice, query, limit, hits: hits.length, passages, unresolved };
}
