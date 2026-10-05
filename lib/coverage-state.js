/* Coverage (lib/coverage.js) read from a library state: the coverage of one draft (its own sources, its own questions and the plans of its runs), of one document (every
   question of the library that points into it, published or still in a draft), and the numbers of every document for the snapshot (the 资料 page's chip). The top-up round of a
   draft (lib/coverage-round.js) is made here too, so the screen that offers it, the estimate under the button and the job it starts read one function. Backend side: the browser
   gets these through the `coverage.get` action and the snapshot's `materialCoverage`. */
import { coverageOf, coverageDigest } from './coverage.js';
import { planRound, roundRequest, ROUND_LIMIT } from './coverage-round.js';
import { groupSourcesByDocument } from './source-groups.js';
import { segmentationViews, stampSegmentations } from './document-outline.js';

const sourcesById = state => new Map((Array.isArray(state?.sources) ? state.sources : []).map(source => [source.id, source]));

/** The kept chapters (a segmentation the learner applied) that belong to some sources: the sections of those sources are then the chapters, like everywhere else. */
function chaptersFor(views, ids) {
  const wanted = new Set(ids);
  return views.filter(view => view.sourceIds.some(id => wanted.has(id))).flatMap(view => view.chapters.filter(chapter => wanted.has(chapter.sourceId)));
}

/** The sources a draft was generated from, in the order of the library (a recording's volumes and a book's pages stay in reading order). */
export function sourcesOfDraft(state, draft) {
  const wanted = new Set(draft?.editorial?.generation?.sourceIds || []);
  return (Array.isArray(state?.sources) ? state.sources : []).filter(source => wanted.has(source.id) && typeof source.text === 'string');
}

/**
 * The coverage of a draft: its own questions over the sources it was generated from, with the plans its runs recorded. `targets: true` keeps, on each planned-failed
 * section, the planned targets that can be written again (the top-up needs them; the browser does not).
 */
export function coverageForDraft(state, draft, { targets = false, views = segmentationViews(state) } = {}) {
  const sources = sourcesOfDraft(state, draft);
  return coverageOf({ sources, cards: draft?.cards || [], partPlans: draft?.editorial?.partPlans, chapters: chaptersFor(views, sources.map(source => source.id)), targets });
}

/** A coverage as the browser gets it: no planned targets (the top-up reads them on the backend). */
export const plainCoverage = coverage => ({ ...coverage, sections: coverage.sections.map(({ targets: _targets, ...section }) => section) });

/**
 * The top-up round of a draft: `{ coverage, round, request }`. `sectionIds` are the section keys the screen showed (lib/coverage.js sectionKey); without them the default round
 * (everything uncovered that fits in the generation limit). `round.error` says why a key list cannot be run.
 */
export function topUpRound(state, draft, { sectionIds, batchSize = 5, limit = ROUND_LIMIT } = {}) {
  const coverage = coverageForDraft(state, draft, { targets: true });
  const round = planRound(coverage, { limit, ...(Array.isArray(sectionIds) ? { keys: sectionIds } : {}) });
  if (round.error) return { coverage, round };
  return { coverage, round, request: roundRequest(round, coverage, sourcesOfDraft(state, draft), { batchSize }) };
}

/* ---------- a document ---------- */

/** Every question that points into some source, once: Map<sourceId, cards[]> over the published decks (not archived, not suspended) and the drafts that are not copies of a published deck. */
function cardsBySource(state) {
  const by = new Map();
  const add = (card, scope) => {
    if (!card || card.suspended) return;
    const ids = new Set([...(card.selections || []).map(selection => selection?.sourceId), ...(card.citations || []).map(citation => citation?.selection?.sourceId || citation?.sourceId)].filter(id => typeof id === 'string' && id));
    for (const id of ids) { if (!by.has(id)) by.set(id, []); by.get(id).push({ card, scope }); }
  };
  for (const deck of Array.isArray(state?.decks) ? state.decks : []) if (!deck.archived) for (const card of deck.cards || []) add(card, deck.id);
  for (const draft of Array.isArray(state?.drafts) ? state.drafts : []) {
    if (!draft || draft.editingDeckId || draft.editorial?.repairOfDeckId) continue;
    for (const card of draft.cards || []) add(card, draft.id);
  }
  return by;
}

const documentItems = state => groupSourcesByDocument(stampSegmentations(Array.isArray(state?.sources) ? state.sources : [], segmentationViews(state)), { documents: state?.documents }).filter(item => !item.archived);

function coverageOfItem(state, item, { by, byId, views }) {
  const ids = item.sourceIds, own = new Set(ids), sources = ids.map(id => byId.get(id)).filter(source => source && typeof source.text === 'string');
  const cards = [], seen = new Set();
  for (const id of ids) for (const { card, scope } of by.get(id) || []) { const key = `${scope}|${card.id}`; if (!seen.has(key)) { seen.add(key); cards.push(card); } }
  const plans = [];
  for (const draft of Array.isArray(state?.drafts) ? state.drafts : []) {
    if (!draft?.editorial?.partPlans?.length || draft.editingDeckId || draft.editorial?.repairOfDeckId) continue;
    if ((draft.editorial.generation?.sourceIds || []).some(id => own.has(id))) plans.push(...draft.editorial.partPlans);
  }
  return { sources, cards, plans, chapters: chaptersFor(views, ids) };
}

/** The coverage of the document an id names (`documentId`, `key`, or any `sourceId` of it): { item, coverage } or null. */
export function coverageForDocument(state, args = {}) {
  const items = documentItems(state);
  const item = items.find(entry => (args.documentId && (entry.documentId === args.documentId || entry.key === args.documentId)) || (args.key && entry.key === args.key)
    || (args.sourceId && entry.sourceIds.includes(args.sourceId)));
  if (!item) return null;
  const context = { by: cardsBySource(state), byId: sourcesById(state), views: segmentationViews(state) }, { sources, cards, plans, chapters } = coverageOfItem(state, item, context);
  return { item, coverage: coverageOf({ sources, cards, partPlans: plans, chapters }) };
}

/** The digest (lib/coverage.js coverageDigest) of every document that has a question (published or in a draft), keyed like groupSourcesByDocument: for the 资料 rows. A document with no question has no entry. */
export function materialCoverageIndex(state) {
  const by = cardsBySource(state);
  if (!by.size) return {};
  const byId = sourcesById(state), views = segmentationViews(state), result = {};
  for (const item of documentItems(state)) {
    if (!item.sourceIds.some(id => by.has(id))) continue;
    const { sources, cards, plans, chapters } = coverageOfItem(state, item, { by, byId, views });
    if (!cards.length) continue;
    result[item.key] = coverageDigest(coverageOf({ sources, cards, partPlans: plans, chapters }));
  }
  return result;
}

const memo = { root: undefined, revision: undefined, value: null };
/** The snapshot's `materialCoverage`, computed once per library revision. */
export function materialCoverageOf(state, { root = '' } = {}) {
  const revision = state?.revision;
  if (memo.value && memo.root === root && memo.revision === revision && revision !== undefined) return memo.value;
  const value = materialCoverageIndex(state);
  Object.assign(memo, { root, revision, value });
  return value;
}
