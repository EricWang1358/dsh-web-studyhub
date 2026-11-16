/* Federated full-text search adapter for 找功能 (Ctrl+K): pure helpers, no DOM, no lib/ imports. */

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHARS = /[\p{L}\p{N}]/gu;

/** Trigger federated content search when typing >= 1 CJK character or >= 2 Latin/alphanumeric characters. */
export function shouldSearchContent(query) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return false;
  if (CJK_CHAR.test(trimmed)) return true;
  return (trimmed.match(WORD_CHARS) || []).length >= 2;
}

/** Convert `search.content` hits into Finder rows with jump targets for source, card, note, and book. */
export function toFinderContentEntries(responseOrResults) {
  const list = Array.isArray(responseOrResults)
    ? responseOrResults
    : (Array.isArray(responseOrResults?.results) ? responseOrResults.results : []);
  const entries = [];
  for (const hit of list) {
    if (!hit || typeof hit !== 'object') continue;
    if (hit.kind === 'source' && hit.sourceId) {
      entries.push({
        id: `content:source:${hit.sourceId}:${hit.matchOffset ?? 0}`,
        kind: 'content',
        contentKind: 'source',
        title: hit.title || hit.sourceId,
        course: hit.course || '',
        page: Number.isInteger(hit.page) ? hit.page : null,
        snippet: hit.snippet || '',
        target: {
          kind: 'source',
          id: hit.sourceId,
          matchOffset: Number.isInteger(hit.matchOffset) ? hit.matchOffset : 0,
          quote: hit.quote || '',
        },
      });
    } else if (hit.kind === 'card' && hit.deckId && hit.cardId) {
      entries.push({
        id: `content:card:${hit.deckId}:${hit.cardId}`,
        kind: 'content',
        contentKind: 'card',
        title: hit.prompt || hit.topic || hit.deckTitle || hit.cardId,
        course: hit.course || '',
        deckTitle: hit.deckTitle || '',
        topic: hit.topic || '',
        snippet: hit.snippet || '',
        target: {
          kind: 'card',
          deckId: hit.deckId,
          cardId: hit.cardId,
        },
      });
    } else if (hit.kind === 'note' && hit.noteId) {
      entries.push({
        id: `content:note:${hit.noteId}`,
        kind: 'content',
        contentKind: 'note',
        title: hit.title || '',
        course: hit.course || '',
        snippet: hit.snippet || '',
        target: {
          kind: 'note',
          id: hit.noteId,
        },
      });
    } else if (hit.kind === 'book' && hit.chapterId) {
      entries.push({
        id: `content:book:${hit.course || '_'}:${hit.chapterId}:${hit.paragraphIndex ?? 0}`,
        kind: 'content',
        contentKind: 'book',
        title: hit.chapterTitle || hit.chapterId,
        course: hit.course || '',
        paragraphIndex: Number.isInteger(hit.paragraphIndex) ? hit.paragraphIndex : 0,
        snippet: hit.snippet || '',
        target: {
          kind: 'book',
          course: hit.course || '',
          chapterId: hit.chapterId,
        },
      });
    }
  }
  return entries;
}

function foldChar(ch) {
  if (ch === 'İ') return ch;
  const norm = ch.normalize('NFKC').toLowerCase();
  return norm.length === ch.length ? norm : ch.toLowerCase();
}

function foldSameLength(text) {
  let out = '';
  for (const ch of String(text ?? '')) out += foldChar(ch);
  return out;
}

/** Split `snippet` into `{ text, match }[]` parts for safe `<mark>` highlighting without HTML injection. */
export function highlightSnippetParts(snippet, query) {
  const source = String(snippet ?? '');
  if (!source) return [];
  const rawTerms = String(query ?? '')
    .trim()
    .split(/[\s|,，、"]+/)
    .map((t) => foldSameLength(t.trim()))
    .filter((t) => t.length >= 2 || CJK_CHAR.test(t));
  if (!rawTerms.length) return [{ text: source, match: false }];
  const terms = [...new Set(rawTerms)].sort((a, b) => b.length - a.length);
  const folded = foldSameLength(source);
  const intervals = [];
  for (const term of terms) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      intervals.push([at, at + term.length]);
    }
  }
  if (!intervals.length) return [{ text: source, match: false }];
  intervals.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i += 1) {
    const prev = merged[merged.length - 1];
    const cur = intervals[i];
    if (cur[0] <= prev[1]) prev[1] = Math.max(prev[1], cur[1]);
    else merged.push(cur);
  }
  const parts = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: source.slice(cursor, start), match: false });
    parts.push({ text: source.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), match: false });
  return parts;
}
