import { INDEX_TOOLS, contentHash, readManifest } from '../../../retrieval-index.js';
import { readRetrievalSettings } from '../../../retrieval-settings.js';
import { bookOfCourse, materialIndex, placesOf, pointList, pointOf } from '../../../book-agent-view.js';
import { courseOf } from '../../../course-book-files.js';
import { groupSourcesByDocument } from '../../../source-groups.js';
import { createIndexPlanner } from './index-plan.js';
import { askPages } from './ask.js';

/* book.search { course?, hid?, query?, limit? } (docs/review-book-agent.md): the course's search index asked for the pages most relevant to a query,
   within one knowledge point's materials (`hid`) or the whole course. The index is the search extension's (lib/retrieval-index.js: every page under its
   own source id), the question and the mapping are retrieval.preview's (./ask.js). A hit names exactly what source.pages takes (documentId and page);
   it is a pointer, never evidence. Without a query it answers only where the index stands. Read only: nothing is written, no model is called. */

export const SEARCH_LIMIT = 8, SEARCH_MAX = 20;
const COMPANION = `mcp:${INDEX_TOOLS.query}`;
const NOTE = 'A hit is a pointer, never evidence: open its page with source.pages {documentId, from: page, to: page, hid} and quote only what you read there.';
const HINTS = {
  'no-extension': () => 'The search extension is not running, so nothing can be searched. The learner installs it in Settings > Search extension; '
    + 'meanwhile read the pages book.coverage names in readNext.',
  'no-index': () => 'This course has no search index yet. Settings > Search extension builds it on this computer (no model tokens); meanwhile use readNext of book.coverage.',
  partial: index => `${index.missing} of the course's ${index.pages} pages are not in the index yet, so a relevant page may be missing from the hits. `
    + 'Settings > Search extension adds them (local, no tokens).',
  building: index => `The index is being built (${index.building?.done ?? 0}/${index.building?.total ?? 0}); the hits cover the pages indexed so far.`,
};

/** Whether the search extension offers its query tool. */
export const canQuery = port => (port?.tools?.() ?? []).some(tool => tool.name === INDEX_TOOLS.query);
const indexedCount = (pages, entries) => pages.filter(source => entries[source.id]?.hash === contentHash(source.text)).length;

/** Where the index of some pages stands: { pages, indexed, missing, building? } (a page edited since it was indexed counts as missing). */
export function indexSummary(pages, manifest, building = null) {
  const indexed = indexedCount(pages, manifest?.sources || {});
  return { pages: pages.length, indexed, missing: pages.length - indexed, ...(building ? { building: { done: building.done, total: building.total } } : {}) };
}

/** The answer's status from the extension, the course's index and the pages searched (`scopeMissing`: pages of the scope not indexed). */
export function searchStatus({ extension, index, scopeMissing }) {
  if (!extension) return 'no-extension';
  if (index.building) return 'building';
  if (!index.indexed) return 'no-index';
  return scopeMissing > 0 ? 'partial' : 'ok';
}

/** The pages a search covers and where each sits: { pages: [source], place: Map<sourceId, { documentId, title, page }> }. */
function scopeOf(state, course, hid, picked) {
  const place = new Map();
  for (const item of groupSourcesByDocument(state.sources || [], { documents: state.documents })) {
    for (const page of item.pages) place.set(page.sourceId, { documentId: item.documentId || item.key, title: item.title, page: page.page });
  }
  const byId = new Map((state.sources || []).map(source => [source.id, source]));
  let ids = picked.map(source => source.id);
  if (hid) {
    const book = bookOfCourse(state, { course }), row = pointOf(pointList(book.doc), hid), index = materialIndex(state, course);
    const items = new Map(placesOf(index, row.node).filter(item => item.item).map(item => [item.item.key, item.item]));
    ids = [...items.values()].flatMap(item => item.sourceIds);
  }
  return { pages: [...new Set(ids)].map(id => byId.get(id)).filter(source => source && place.has(source.id) && typeof source.text === 'string'), place };
}

/** book.search over `ports` (state, retrieval); `indexRuns` says whether a build is running (./index-runs.js). */
export function createBookSearch(ports, { indexRuns }) {
  return async (args = {}) => {
    const state = await ports.state.read(), course = courseOf(state, args), hid = typeof args.hid === 'string' && args.hid ? args.hid : null;
    if (hid && !bookOfCourse(state, { course })) return { status: 'empty', course: course ?? null, reason: 'no-book' };
    const { picked } = await createIndexPlanner(ports).prepare(course ?? undefined);
    const scope = scopeOf(state, course, hid, picked), manifest = await readManifest(ports.state.root);
    const running = await indexRuns.building().catch(() => null);
    const building = running && (running.course === '*' || running.course === course) ? running : null;
    const index = indexSummary(picked, manifest, building), extension = canQuery(ports.retrieval);
    const status = searchStatus({ extension, index, scopeMissing: scope.pages.length - indexedCount(scope.pages, manifest.sources || {}) });
    const query = String(args.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const limit = Math.max(1, Math.min(SEARCH_MAX, Math.trunc(Number(args.limit)) || SEARCH_LIMIT));
    const answer = { status, course: course ?? null, ...(hid ? { hid } : {}), ...(query ? { query } : {}), index, hits: [],
      ...(HINTS[status] ? { hint: HINTS[status](index) } : {}) };
    if (!query || !scope.pages.length || status === 'no-extension' || status === 'no-index') return answer;
    const saved = await readRetrievalSettings().catch(() => ({ provider: 'builtin' }));
    try {
      const found = await askPages(ports.retrieval, saved.provider === COMPANION ? saved : { provider: COMPANION }, scope.pages, query,
        { course: course ?? undefined, limit: Math.min(50, Math.max(20, limit * 3)), budgetChars: Number.POSITIVE_INFINITY });
      answer.hits = [...(found?.pages ?? [])].sort((a, b) => b.score - a.score).slice(0, limit).map(page => ({ ...scope.place.get(page.sourceId),
        sourceId: page.sourceId, snippet: page.snippet, score: Math.round(page.score * 1000) / 1000 }));
    } catch (error) { answer.error = String(error?.message || error).slice(0, 200); }
    if (answer.hits.length) answer.note = NOTE;
    return answer;
  };
}
