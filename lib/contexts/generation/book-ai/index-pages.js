import { excerpt } from '../../../course-book-reading.js';
import { displayTitle } from '../../../document-title.js';
import { MATERIAL_CHARS } from './plan.js';

/* Explain / add-a-paragraph with the course's search index: before the one model call, book.search finds the pages most relevant to the selected words and the
   instruction within the point's materials (topped up from the whole course when the point gives too few), and those pages go first into the material
   the model sees, inside the same budget (plan.js MATERIAL_CHARS). Quotes are still checked against exactly the text given (plan.segments). Without a
   usable index, or when the search fails, the plan is today's. No model call here. */

/** At most this many pages come from the index, with at most this much of their text. */
export const INDEX_PAGES = 6, INDEX_CHARS = 6000;
/** Fewer hits than this within the point: the whole course is asked too. */
export const MIN_HITS = 3;
const USABLE = new Set(['ok', 'partial', 'building']);

/** What the request is about, as the index is asked: the selected words, the instruction, and for 加一段 the point's title. */
export const requestQuery = plan => [plan.words, plan.instruction, plan.mode === 'here' || !plan.words ? plan.leaf.title : ''].filter(Boolean).join(' ').slice(0, 400);

/**
 * The hits' pages as passages of the plan: [{ sourceId, start, end, text, material, page, fromIndex }], best first, one per page, those with text only.
 * `byId`: the library's sources by id.
 */
export function hitPages(hits, byId) {
  const seen = new Set(), pages = [];
  for (const hit of hits || []) {
    const source = byId.get(hit.sourceId);
    if (!source || seen.has(source.id) || typeof source.text !== 'string' || !source.text.trim()) continue;
    seen.add(source.id);
    pages.push({ sourceId: source.id, start: 0, end: source.text.length, text: source.text, material: displayTitle(hit.title || source.title),
      ...(Number.isInteger(hit.page) ? { page: hit.page } : {}), fromIndex: true });
    if (pages.length >= INDEX_PAGES) break;
  }
  return pages;
}

/** The plan with the index's pages first: their text up to INDEX_CHARS, then the point's own passages (without those pages) in what is left. */
export function withIndexPages(plan, pages) {
  if (!pages.length) return plan;
  const ids = new Set(pages.map(page => page.sourceId)), own = plan.segments.filter(segment => !ids.has(segment.sourceId));
  const first = excerpt(pages, INDEX_CHARS), used = first.reduce((sum, part) => sum + part.text.length, 0);
  return { ...plan, materials: [...first, ...(own.length ? excerpt(own, MATERIAL_CHARS - used) : [])], segments: [...pages, ...own],
    indexPages: pages.map(page => ({ material: page.material, page: page.page ?? null })) };
}

/**
 * Ask the index for the plan's request: `search(args)` is book.search, `read()` the library. -> the pages to add ([] when the index cannot be used).
 * A failing search is an empty answer: the task goes on as it always did.
 */
export async function findIndexPages(plan, { search, read }) {
  if (typeof search !== 'function' || typeof read !== 'function') return [];
  const query = requestQuery(plan);
  const point = await search({ course: plan.course, hid: plan.leaf.hid, query, limit: INDEX_PAGES }).catch(() => null);
  if (!USABLE.has(point?.status)) return [];
  let hits = point.hits || [];
  if (hits.length < MIN_HITS) {
    const course = await search({ course: plan.course, query, limit: INDEX_PAGES }).catch(() => null);
    hits = [...hits, ...(course?.hits || []).filter(hit => !hits.some(own => own.sourceId === hit.sourceId))];
  }
  if (!hits.length) return [];
  const state = await read();
  return hitPages(hits, new Map((state.sources || []).map(source => [source.id, source])));
}
