/* Zero-download local lexical retrieval engine powered by `minisearch` (MIT, zero deps)
   and Node 22 native `Intl.Segmenter('zh', { granularity: 'word' })`.
   Provides CJK + Latin tokenization, native `course` / `sourceIds` filtering,
   incremental index updates (`upsert` / `remove` / `syncSources`), and snippet highlighting.
   Kept as a self-contained module under `lib/contexts/materials/` ready for future wiring into `lib/retrieval.js`. */

import MiniSearch from 'minisearch';

const zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const DEFAULT_SNIPPET_LENGTH = 180;
const AUTO_VACUUM_DISCARD_THRESHOLD = 64;

/**
 * Segment mixed CJK / Latin / technical text into lowercased lexical tokens using
 * Node 22's built-in `Intl.Segmenter('zh', { granularity: 'word' })`.
 */
export function tokenizeLexical(text) {
  const input = String(text ?? '').normalize('NFKC');
  if (!input.trim()) return [];
  const tokens = [];
  for (const part of zhSegmenter.segment(input)) {
    if (!part.isWordLike) continue;
    const token = part.segment.trim().toLowerCase();
    if (token && WORD_CHAR_RE.test(token)) tokens.push(token);
  }
  return tokens;
}

/** Normalize a raw source/chunk document into the canonical indexed shape. */
function normalizeDocument(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Lexical document must be an object');
  const id = String(doc.id ?? doc.sourceId ?? '').trim();
  if (!id) throw new Error('Lexical document requires a non-empty id or sourceId');
  const sourceId = String(doc.sourceId ?? id).trim();
  const title = String(doc.title ?? '');
  const text = String(doc.text ?? '');
  const course = String(doc.course ?? '');
  const page = Number.isInteger(doc.page) ? doc.page : null;
  return { id, sourceId, title, text, course, page };
}

/** Cheap deterministic fingerprint to skip unchanged documents during `syncSources`. */
function docSignature(doc) {
  return `${doc.sourceId}\0${doc.course}\0${doc.page ?? ''}\0${doc.title}\0${doc.text}`;
}

/**
 * Extract a compact excerpt around the densest cluster of matched terms in `text`,
 * returning both the plain excerpt (`snippet`), highlighted text (`highlighted`),
 * and exact UTF-16 match ranges (`highlights`) relative to `snippet`.
 */
export function extractHighlightSnippet(text, terms = [], {
  maxLength = DEFAULT_SNIPPET_LENGTH,
  markStart = '<mark>',
  markEnd = '</mark>',
} = {}) {
  const raw = String(text ?? '');
  const normalizedSpace = raw.replace(/\s+/g, ' ').trim();
  if (!normalizedSpace) return { snippet: '', highlighted: '', highlights: [] };

  const uniqueTerms = [...new Set(
    (Array.isArray(terms) ? terms : [])
      .map(t => String(t ?? '').trim().toLowerCase())
      .filter(Boolean),
  )].sort((a, b) => b.length - a.length);

  if (!uniqueTerms.length) {
    const clipped = normalizedSpace.length > maxLength
      ? `${normalizedSpace.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
      : normalizedSpace;
    return { snippet: clipped, highlighted: clipped, highlights: [] };
  }

  const lower = normalizedSpace.toLowerCase();
  const rawMatches = [];
  for (const term of uniqueTerms) {
    let pos = lower.indexOf(term);
    while (pos >= 0) {
      rawMatches.push({ start: pos, end: pos + term.length, term });
      pos = lower.indexOf(term, pos + Math.max(1, term.length));
    }
  }
  rawMatches.sort((a, b) => a.start - b.start || b.end - a.end);

  // Merge overlapping spans so highlights never nest or double-wrap.
  const merged = [];
  for (const hit of rawMatches) {
    const prev = merged.at(-1);
    if (prev && hit.start < prev.end) {
      if (hit.end > prev.end) prev.end = hit.end;
      continue;
    }
    merged.push({ ...hit });
  }

  if (!merged.length) {
    const clipped = normalizedSpace.length > maxLength
      ? `${normalizedSpace.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
      : normalizedSpace;
    return { snippet: clipped, highlighted: clipped, highlights: [] };
  }

  // Pick the window anchored near the highest-density match cluster.
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < merged.length; i++) {
    const anchor = merged[i].start;
    let count = 0;
    for (let j = i; j < merged.length && merged[j].end - anchor <= maxLength; j++) count++;
    if (count > bestScore) {
      bestScore = count;
      bestIndex = i;
    }
  }

  const focus = merged[bestIndex];
  const lead = Math.floor(maxLength * 0.25);
  let winStart = Math.max(0, focus.start - lead);
  let winEnd = Math.min(normalizedSpace.length, winStart + maxLength);
  if (winEnd - winStart < maxLength && winStart > 0) {
    winStart = Math.max(0, winEnd - maxLength);
  }
  // Avoid slicing mid-surrogate pair.
  if (winStart > 0 && normalizedSpace.charCodeAt(winStart) >= 0xDC00 && normalizedSpace.charCodeAt(winStart) <= 0xDFFF) winStart++;
  if (winEnd < normalizedSpace.length && normalizedSpace.charCodeAt(winEnd - 1) >= 0xD800 && normalizedSpace.charCodeAt(winEnd - 1) <= 0xDBFF) winEnd--;

  const prefixEllipsis = winStart > 0 ? '…' : '';
  const suffixEllipsis = winEnd < normalizedSpace.length ? '…' : '';
  const body = normalizedSpace.slice(winStart, winEnd);
  const snippet = `${prefixEllipsis}${body}${suffixEllipsis}`;
  const shift = prefixEllipsis.length;

  const highlights = [];
  for (const hit of merged) {
    if (hit.end <= winStart || hit.start >= winEnd) continue;
    highlights.push({
      start: Math.max(0, hit.start - winStart) + shift,
      end: Math.min(body.length, hit.end - winStart) + shift,
      term: hit.term,
    });
  }

  let highlighted = '';
  let cursor = 0;
  for (const range of highlights) {
    if (range.start > cursor) highlighted += snippet.slice(cursor, range.start);
    highlighted += `${markStart}${snippet.slice(range.start, range.end)}${markEnd}`;
    cursor = range.end;
  }
  if (cursor < snippet.length) highlighted += snippet.slice(cursor);

  return { snippet, highlighted, highlights };
}

function buildMiniSearch(options = {}) {
  return new MiniSearch({
    idField: 'id',
    fields: ['title', 'text', 'course'],
    storeFields: ['id', 'sourceId', 'title', 'course', 'page', 'text'],
    tokenize: tokenizeLexical,
    processTerm: term => term.toLowerCase(),
    searchOptions: {
      boost: { title: 2.5, course: 1.2, text: 1 },
      prefix: true,
      fuzzy: options.fuzzy ?? 0.15,
      combineWith: options.combineWith ?? 'OR',
    },
  });
}

/**
 * Create an in-memory local lexical search index backed by `MiniSearch` + `Intl.Segmenter('zh')`.
 */
export function createLexicalIndex(options = {}) {
  let engine = buildMiniSearch(options);
  const docs = new Map();
  const signatures = new Map();
  let discarded = 0;

  const maybeVacuum = () => {
    if (discarded >= AUTO_VACUUM_DISCARD_THRESHOLD) {
      engine.vacuum();
      discarded = 0;
    }
  };

  const upsert = (rawDoc) => {
    const doc = normalizeDocument(rawDoc);
    const sig = docSignature(doc);
    if (signatures.get(doc.id) === sig) return 'unchanged';
    const existed = docs.has(doc.id);
    if (existed) {
      engine.discard(doc.id);
      discarded++;
    }
    engine.add(doc);
    docs.set(doc.id, doc);
    signatures.set(doc.id, sig);
    maybeVacuum();
    return existed ? 'updated' : 'added';
  };

  const upsertMany = (list = []) => {
    const counts = { added: 0, updated: 0, unchanged: 0 };
    for (const item of list) {
      const status = upsert(item);
      counts[status]++;
    }
    return counts;
  };

  const remove = (id) => {
    const key = String(id ?? '').trim();
    if (!key || !docs.has(key)) return false;
    engine.discard(key);
    docs.delete(key);
    signatures.delete(key);
    discarded++;
    maybeVacuum();
    return true;
  };

  const syncSources = (sources = []) => {
    const seen = new Set();
    let added = 0;
    let updated = 0;
    let removed = 0;
    for (const item of sources) {
      const doc = normalizeDocument(item);
      seen.add(doc.id);
      const status = upsert(doc);
      if (status === 'added') added++;
      else if (status === 'updated') updated++;
    }
    for (const existingId of [...docs.keys()]) {
      if (!seen.has(existingId)) {
        if (remove(existingId)) removed++;
      }
    }
    return { added, updated, removed, total: docs.size };
  };

  const clear = () => {
    engine = buildMiniSearch(options);
    docs.clear();
    signatures.clear();
    discarded = 0;
  };

  const search = (query, {
    limit = 10,
    course = null,
    courses = null,
    sourceIds = null,
    fuzzy = options.fuzzy ?? 0.15,
    prefix = true,
    combineWith = options.combineWith ?? 'OR',
    snippetLength = DEFAULT_SNIPPET_LENGTH,
    markStart = '<mark>',
    markEnd = '</mark>',
  } = {}) => {
    const rawQuery = String(query ?? '').trim();
    if (!rawQuery || !docs.size) return [];

    const allowedCourses = (() => {
      const list = [];
      if (typeof course === 'string' && course.trim()) list.push(course.trim());
      if (Array.isArray(courses)) {
        for (const item of courses) if (typeof item === 'string' && item.trim()) list.push(item.trim());
      }
      return list.length ? new Set(list) : null;
    })();

    const allowedSources = (() => {
      if (!sourceIds) return null;
      const items = sourceIds instanceof Set ? [...sourceIds] : Array.isArray(sourceIds) ? sourceIds : [];
      const cleaned = items.map(v => String(v ?? '').trim()).filter(Boolean);
      return new Set(cleaned);
    })();

    if (allowedSources && allowedSources.size === 0) return [];

    const filter = (allowedCourses || allowedSources)
      ? (result) => {
          if (allowedCourses && !allowedCourses.has(result.course)) return false;
          if (allowedSources && !allowedSources.has(result.sourceId) && !allowedSources.has(result.id)) return false;
          return true;
        }
      : undefined;

    const rawHits = engine.search(rawQuery, {
      filter,
      fuzzy,
      prefix,
      combineWith,
    });

    const queryTokens = tokenizeLexical(rawQuery);
    const capped = rawHits.slice(0, Math.max(0, limit));
    return capped.map(hit => {
      const highlightTerms = [...new Set([...(hit.terms || []), ...queryTokens])];
      const { snippet, highlighted, highlights } = extractHighlightSnippet(hit.text, highlightTerms, {
        maxLength: snippetLength,
        markStart,
        markEnd,
      });
      return {
        id: hit.id,
        sourceId: hit.sourceId,
        title: hit.title,
        course: hit.course,
        page: hit.page,
        score: hit.score,
        terms: hit.terms,
        match: hit.match,
        snippet,
        highlighted,
        highlights,
      };
    });
  };

  return {
    upsert,
    upsertMany,
    remove,
    syncSources,
    clear,
    search,
    has: (id) => docs.has(String(id ?? '')),
    get: (id) => docs.get(String(id ?? '')) ?? null,
    get size() { return docs.size; },
    vacuum: () => { engine.vacuum(); discarded = 0; },
  };
}
