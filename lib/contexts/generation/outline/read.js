import { parseJson } from '../../../generation.js';
import { locateQuote } from '../blueprint/quote.js';
import { POINTS_PER_BATCH, QUOTE_CHARS } from './constants.js';

/* Reading the model's answers. Nothing is trusted: an answer that is not the shape asked for is null (the call is asked once more, lib/.../blueprint/jobs/ask.js),
   ids are only strings here and are checked against the plan by tree.js, a quote of a paper must be found in the paper. */

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function parse(text) { try { const value = parseJson(String(text)); return object(value) ? value : null; } catch { return null; } }
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ids = value => (Array.isArray(value) ? value : [value]).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim());

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

/**
 * @returns null, or `{ questions: [{ sourceId, quote, start, end, points: [id] }], unverified }`: a question whose quote is not in the paper is not kept
 * (its points are not marked) and is counted in `unverified`.
 */
export function readPaper(text, chunk) {
  const value = parse(text);
  if (!value || !Array.isArray(value.questions)) return null;
  const questions = [];
  let unverified = 0;
  for (const raw of value.questions.filter(object)) {
    const quote = clean(raw.quote, QUOTE_CHARS), points = ids(raw.points).slice(0, 3);
    let found = null;
    for (const source of chunk.sources) { const at = quote ? locateQuote(source.text, quote) : null; if (at) { found = { sourceId: source.id, ...at }; break; } }
    if (found && points.length) questions.push({ ...found, points }); else if (points.length) unverified++;
  }
  return { questions, unverified };
}
