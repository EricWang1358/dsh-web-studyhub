import { short16 } from '../../../course-book-inventory.js';
import { parseJson } from '../../../generation.js';
import { locateQuote } from '../blueprint/quote.js';
import { POINTS_PER_BATCH, QUOTE_CHARS } from './constants.js';

/* Reading the model's answers. Nothing is trusted: an answer that is not the shape asked for is null (the call is asked once more, lib/.../blueprint/jobs/ask.js),
   ids are only strings here and are checked against the plan by tree.js, a quote of a paper must be found in the paper. */

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function parse(text) { try { const value = parseJson(String(text)); return object(value) ? value : null; } catch { return null; } }
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ids = value => (Array.isArray(value) ? value : [value]).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim());
const QUESTION_HEAD = /(?:^|\s)(?:Q\d+|Question\s+\d+|\d+[.)]|[（(]\d+[)）]|第\s*[0-9一二三四五六七八九十]+\s*题)\s*$/i;

export const paperChunkDigest = chunk => short16(['paper', chunk.paper, chunk.sources.map(source => [source.id, source.text])]);

/** @returns null, or `{ points: [{ title, intro?, ids }] }` (at most POINTS_PER_BATCH; a point without a title or an id is left out). */
export function readMap(text) {
  const value = parse(text);
  if (!value || !Array.isArray(value.points)) return null;
  const points = value.points.filter(object).map(raw => ({ title: clean(raw.title, 200), intro: clean(raw.intro, 400), ids: ids(raw.ids) }))
    .filter(point => point.title && point.ids.length).slice(0, POINTS_PER_BATCH);
  return { points };
}

/** A leaf as the reduce answer gives it: a point id, a list of point ids, or { title?, points }. */
const leafOf = raw => (typeof raw === 'string' ? { ids: ids(raw) } : Array.isArray(raw) ? { ids: ids(raw) }
  : object(raw) ? { ids: ids(raw.points ?? raw.ids ?? raw.id), ...(clean(raw.title, 200) ? { title: clean(raw.title, 200) } : {}) } : { ids: [] });
/** Every leaf under a section, however deep the model nested it (depth is the program's, at most three levels). */
const leavesUnder = raw => [...(Array.isArray(raw?.points) ? raw.points : []).map(leafOf), ...(Array.isArray(raw?.sections) ? raw.sections : []).flatMap(leavesUnder)];

/** @returns null, or `{ basis: [code], chapters: [{ title, intro?, leaves: [leaf], sections: [{ title, intro?, leaves }] }] }`. */
export function readReduce(text) {
  const value = parse(text);
  if (!value || !Array.isArray(value.chapters)) return null;
  const head = raw => ({ title: clean(raw?.title, 200), intro: clean(raw?.intro, 400) });
  const chapters = value.chapters.filter(object).map(raw => ({ ...head(raw), leaves: (Array.isArray(raw.points) ? raw.points : []).map(leafOf),
    sections: (Array.isArray(raw.sections) ? raw.sections : []).filter(object).map(section => ({ ...head(section), leaves: leavesUnder(section) })) }));
  return { basis: ids(value.basis), chapters };
}

function splitBetween(full, prev, next) {
  const nextLine = full.lastIndexOf('\n', next.start);
  if (nextLine >= prev.end) return nextLine + 1;
  if (next.start <= prev.end) return next.start;
  const between = full.slice(prev.end, next.start);
  if (next.label) {
    const idx = between.lastIndexOf(next.label);
    if (idx >= 0) return prev.end + idx;
  }
  const head = QUESTION_HEAD.exec(between);
  if (head) return prev.end + head.index + (/^\s/.test(head[0]) ? 1 : 0);
  return next.start;
}

/**
 * @returns null, or `{ questions: [{ sourceId, quote, start, end, points: [id] }], extracted: [{ label?, sourceId, quote, start, end, text }], unverified }`:
 * a question whose quote is not in the paper is not kept (its points are not marked) and is counted in `unverified`.
 */
export function readPaper(text, chunk) {
  const value = parse(text);
  if (!value || !Array.isArray(value.questions)) return null;
  const questions = [], verified = [];
  let unverified = 0;
  for (const raw of value.questions.filter(object)) {
    const quote = clean(raw.quote, QUOTE_CHARS), points = ids(raw.points).slice(0, 3);
    let found = null;
    for (const source of chunk.sources) { const at = quote ? locateQuote(source.text, quote) : null; if (at) { found = { sourceId: source.id, ...at }; break; } }
    if (found) {
      verified.push({ ...(clean(raw.label, 40) ? { label: clean(raw.label, 40) } : {}), ...found });
      if (points.length) questions.push({ ...found, points });
    } else if (points.length) unverified++;
  }
  const bySource = new Map(chunk.sources.map(source => [source.id, source.text])), extracted = [], seen = new Set();
  for (const source of chunk.sources) {
    const own = verified.filter(q => q.sourceId === source.id).sort((a, b) => a.start - b.start);
    const full = bySource.get(source.id) || '';
    own.forEach((q, at) => {
      const key = `${q.sourceId}\u0000${q.quote}`;
      if (seen.has(key)) return;
      seen.add(key);
      const lineStart = full.lastIndexOf('\n', q.start) + 1;
      const from = at > 0 ? Math.min(q.start, Math.max(lineStart, splitBetween(full, own[at - 1], q))) : lineStart;
      const nextBound = at + 1 < own.length ? splitBetween(full, q, own[at + 1]) : full.length;
      const to = Math.min(Math.max(q.end, nextBound), from + 1600);
      extracted.push({ ...(q.label ? { label: q.label } : {}), sourceId: q.sourceId, quote: q.quote, start: q.start, end: q.end,
        text: full.slice(from, to).trim() || q.quote });
    });
  }
  return { questions, extracted, unverified };
}
