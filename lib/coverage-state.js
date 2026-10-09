/* Coverage (lib/coverage.js) read from a library state: the coverage of one draft (its own sources, its own questions and the plans of its runs), of one document (every
   question of the library that points into it, published or still in a draft), and the numbers of every document for the snapshot (the 资料 page's chip). The top-up round of a
   draft (lib/coverage-round.js) is made here too, so the screen that offers it, the estimate under the button and the job it starts read one function. Backend side: the browser
   gets these through the `coverage.get` action and the snapshot's `materialCoverage`. */
import { coverageOf, coverageDigest, sectionKey } from './coverage.js';
import { sectionsOf } from './sections.js';
import { specNotes } from './coverage-plan.js';
import { nextPlannedKeys, wantedUncovered, isRepeating, needsReplan, roundList } from './coverage-run.js';
import { planRound, roundRequest, ROUND_LIMIT } from './coverage-round.js';
import { isPartDraft, nextPartOf } from './deck-parts.js';
import { groupSourcesByDocument } from './source-groups.js';
import { segmentationViews, stampSegmentations } from './document-outline.js';
import { createLocator } from './quote-locate.js';
import { documentSourceFamily, versionFamilies, recordingIndex } from './material-mastery.js';

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
  const sources = sourcesOfDraft(state, draft), chapters = chaptersFor(views, sources.map(source => source.id));
  // A draft that will be the next part of a published deck (lib/deck-parts.js) tops up a DOCUMENT: its coverage is the document's (the deck's questions count, and every other draft's), so
  // the draft page, the 任务 console and the 资料 row say the same numbers. Its own questions are the ones it holds now (the copy in `state` may be older).
  if (isPartDraft(draft)) {
    const ids = sources.map(source => source.id), { cards, plans } = documentCards(state, ids, { by: cardsBySource(state), skip: draft.id, related: relatedIdsOf(state, ids) });
    return coverageOf({ sources, cards: [...homeCards(cards, sources), ...(draft.cards || [])], partPlans: [...plans.filter(plan => plan.draftId !== draft.id).flatMap(plan => plan.list), ...(draft.editorial?.partPlans || [])], chapters, targets });
  }
  return coverageOf({ sources, cards: draft?.cards || [], partPlans: draft?.editorial?.partPlans, chapters, targets });
}

/** The quotas of the plan a draft kept (Map(section key -> questions)), or undefined: a draft that kept its plan continues it, an uncovered section costs the quota the plan gave it. */
export const quotasOfDraft = draft => (Array.isArray(draft?.editorial?.coverageSpec?.quotas) ? new Map(draft.editorial.coverageSpec.quotas.map(item => [item.sectionId, item.quota])) : undefined);

/** The leaf sections of some sources, in reading order, each with its section key: the units a coverage plan is made over (the same sections the coverage view counts). */
export function leafSectionsFor(state, sources, { views = segmentationViews(state) } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  return sectionsOf(list, { chapters: chaptersFor(views, list.map(source => source.id)) }).filter(section => section.leaf).map(section => ({ ...section, key: sectionKey(section.sourceId, section.id) }));
}

/** A coverage with what the draft's plan says about each section (`weight`: importance, kind, the model's reason, the quota and why) and the plan itself (`spec`): the screens say why a section got its questions. */
export function annotateCoverage(coverage, spec) {
  if (!spec || !Array.isArray(spec.weights)) return coverage;
  const notes = specNotes(spec), rounds = Array.isArray(spec.rounds) ? spec.rounds : [];
  // A section of a round that has not run yet is not "never planned": it is waiting for its round (`scheduled`). A plan from before round states were kept (phase 3a) ran its first round and nothing else.
  // A section of a round that DID run (done, or failed) and still has no question was planned and did not come out: planned-and-failed, the plan came back short for it (`attempted`), never "no plan".
  const stateOfRound = (round, index) => round.status || (index === 0 ? 'done' : 'pending'), waitingKeys = new Set(), triedKeys = new Set();
  rounds.forEach((round, index) => { const status = stateOfRound(round, index); for (const key of round.sectionIds || []) (status === 'pending' || status === 'running' ? waitingKeys : status === 'done' || status === 'failed' ? triedKeys : new Set()).add(key); });
  let scheduled = 0, plannedFailed = coverage.plannedFailed, neverPlanned = coverage.neverPlanned;
  const sections = coverage.sections.map(section => {
    const note = notes.get(section.key), never = section.state === 'never-planned', tried = never && triedKeys.has(section.key), waiting = never && !tried && waitingKeys.has(section.key);
    if (waiting) scheduled += 1;
    if (tried) { plannedFailed += 1; neverPlanned -= 1; }
    return note || waiting || tried ? { ...section, ...(note ? { weight: note } : {}), ...(waiting ? { scheduled: true } : {}), ...(tried ? { state: 'planned-failed', reason: 'plan-short', attempted: true } : {}) } : section;
  });
  // The plan's rounds are the planned ones; the fill rounds a run appended to write the sections that did not come out again are counted apart.
  const fills = rounds.filter(round => round.fill).length;
  return { ...coverage, sections, plannedFailed, neverPlanned, scheduled, spec: { level: spec.level, goal: spec.goal, rounds: rounds.length - fills, ...(fills ? { fills } : {}), ...(spec.topup ? { topup: true } : {}), weightSource: spec.weightSource, ...(spec.weightReason ? { weightReason: spec.weightReason } : {}) } };
}

/** A coverage as the browser gets it: no planned targets (the top-up reads them on the backend). */
export const plainCoverage = coverage => ({ ...coverage, sections: coverage.sections.map(({ targets: _targets, ...section }) => section) });

/**
 * The top-up round of a draft: `{ coverage, round, request }`. `sectionIds` are the section keys the screen showed (lib/coverage.js sectionKey); without them the default round
 * (everything uncovered that fits in the generation limit). `round.error` says why a key list cannot be run.
 */
export function topUpRound(state, draft, { sectionIds, batchSize = 5, limit = ROUND_LIMIT, fit } = {}) {
  const coverage = coverageForDraft(state, draft, { targets: true });
  // Without keys a draft that kept its plan runs the next round of it (the sections of that round that still have no question: what 「为没覆盖的部分补题」 says and the run executes); a draft whose rounds are
  // all done, or that has no plan, gets the sections with no question in the order of the quotas (planned-and-failed first).
  const planned = Array.isArray(sectionIds) ? null : nextPlannedKeys(draft?.editorial?.coverageSpec, wantedUncovered(draft?.editorial?.coverageSpec, coverage));
  const keys = Array.isArray(sectionIds) ? sectionIds : planned ? planned.keys : null;
  const spec = draft?.editorial?.coverageSpec, late = new Set(Object.keys(spec?.attempts || {}).filter(key => isRepeating(spec, key)));
  // A section that failed twice was already written again from the target it failed with: the next try plans it anew from its text instead of repeating the same attempt (`replan`).
  const replan = new Set(Object.keys(spec?.attempts || {}).filter(key => needsReplan(spec, key)));
  const round = planRound(coverage, { limit, quotas: quotasOfDraft(draft), late, replan, ...(keys ? { keys, fit: fit ?? !!planned } : {}) });
  if (round.error) return { coverage, round };
  return { coverage, round, request: roundRequest(round, coverage, sourcesOfDraft(state, draft), { batchSize }), ...(planned ? { planned } : {}) };
}

/* ---------- a document ---------- */

/** The sources a question points into (its selections and its citations). */
const cardSourceIds = card => new Set([...(card?.selections || []).map(selection => selection?.sourceId), ...(card?.citations || []).map(citation => citation?.selection?.sourceId || citation?.sourceId)].filter(id => typeof id === 'string' && id));

/** Every question that points into some source, once: Map<sourceId, cards[]> over the published decks (not archived, not suspended) and the drafts that are not copies of a published deck. */
function cardsBySource(state) {
  const by = new Map();
  const add = (card, scope) => {
    if (!card || card.suspended) return;
    for (const id of cardSourceIds(card)) { if (!by.has(id)) by.set(id, []); by.get(id).push({ card, scope }); }
  };
  for (const deck of Array.isArray(state?.decks) ? state.decks : []) if (!deck.archived) for (const card of deck.cards || []) add(card, deck.id);
  for (const draft of Array.isArray(state?.drafts) ? state.drafts : []) {
    if (!draft || draft.editingDeckId || draft.editorial?.repairOfDeckId) continue;
    for (const card of draft.cards || []) add(card, draft.id);
  }
  return by;
}

const everyItem = state => groupSourcesByDocument(stampSegmentations(Array.isArray(state?.sources) ? state.sources : [], segmentationViews(state)), { documents: state?.documents });
const documentItems = state => everyItem(state).filter(item => !item.archived);

/**
 * The source records whose questions belong to a document besides its own (lib/material-mastery.js documentSourceFamily, the one definition the 资料 row's question count reads too): the older
 * versions of it, the other imports of the same recording, the recordings a merged material consists of. `family` is built once for many documents (`familyReader`).
 */
const familyReader = (state, listed = everyItem(state)) => {
  const context = { families: versionFamilies(state?.documents), listed, recordings: recordingIndex(state, listed) };
  return item => { const { ids, own } = documentSourceFamily(state, item, context); return ids.filter(id => !own.has(id)); };
};
/** The same for the document that holds some sources (the part draft's coverage is its document's, so it needs no item). */
function relatedIdsOf(state, ids) {
  if (!ids.length) return [];
  const listed = everyItem(state), item = listed.find(entry => ids.some(id => entry.sourceIds.includes(id)));
  return item ? familyReader(state, listed)(item) : [];
}

/**
 * A question that cites only records of OTHER materials of the document's set (an older version, another import of the recording, a recording the merged material consists of) has no
 * place in this material's sections by its source id. It stands where its quote stands in this material's text (lib/quote-locate.js: as written, else by its letters and digits), so the
 * figure over the CURRENT text counts it; a quote that is not found there covers nothing (it still is one of the material's questions). A question that cites a record of the material
 * itself is read as it is.
 */
function homeCards(cards, sources) {
  const own = new Set(sources.map(source => source.id)), locators = [];
  const locate = () => { if (!locators.length) for (const source of sources) locators.push({ source, find: createLocator(source.text) }); return locators; };
  return cards.map(card => {
    if ([...cardSourceIds(card)].some(id => own.has(id))) return card;
    const quotes = [...new Set([...(card.citations || []).map(citation => citation?.selection?.quote || citation?.quote), ...(card.selections || []).map(selection => selection?.quote)].filter(quote => typeof quote === 'string' && quote.trim()))];
    const citations = [];
    for (const quote of quotes) {
      let found = null, sourceId = '';
      for (const { source } of locate()) { const start = source.text.indexOf(quote); if (start >= 0) { found = { start, end: start + quote.length }; sourceId = source.id; break; } }
      if (!found) for (const { source, find } of locate()) { const place = find(quote); if (place) { found = place; sourceId = source.id; break; } }
      if (found) citations.push({ sourceId, quote, at: found });
    }
    return citations.length ? { ...card, selections: [], citations } : card;
  });
}

/**
 * The questions of the library that point into some sources (and, with `related`, into the records of the document's other versions and materials), once each (`skip`: a draft whose
 * questions the caller adds itself), and the plans of the drafts made from the sources ([{ draftId, list }]).
 */
function documentCards(state, ids, { by, skip, related = [] } = {}) {
  const own = new Set(ids), cards = [], seen = new Set(), plans = [];
  for (const id of [...ids, ...related]) for (const { card, scope } of by.get(id) || []) { const key = `${scope}|${card.id}`; if (scope !== skip && !seen.has(key)) { seen.add(key); cards.push(card); } }
  for (const draft of Array.isArray(state?.drafts) ? state.drafts : []) {
    if (!draft?.editorial?.partPlans?.length || draft.editingDeckId || draft.editorial?.repairOfDeckId) continue;
    if ((draft.editorial.generation?.sourceIds || []).some(id => own.has(id))) plans.push({ draftId: draft.id, list: draft.editorial.partPlans });
  }
  return { cards, plans };
}

function coverageOfItem(state, item, { by, byId, views, family }) {
  const ids = item.sourceIds, sources = ids.map(id => byId.get(id)).filter(source => source && typeof source.text === 'string');
  const { cards, plans } = documentCards(state, ids, { by, related: family(item) });
  return { sources, cards: homeCards(cards, sources), plans: plans.flatMap(plan => plan.list), chapters: chaptersFor(views, ids) };
}

const findItem = (items, args) => items.find(entry => (args.documentId && (entry.documentId === args.documentId || entry.key === args.documentId)) || (args.key && entry.key === args.key)
  || (args.sourceId && entry.sourceIds.includes(args.sourceId)));

/** The coverage of the document an id names (`documentId`, `key`, or any `sourceId` of it): { item, coverage } or null. */
export function coverageForDocument(state, args = {}) {
  const item = findItem(documentItems(state), args);
  if (!item) return null;
  const context = { by: cardsBySource(state), byId: sourcesById(state), views: segmentationViews(state), family: familyReader(state) }, { sources, cards, plans, chapters } = coverageOfItem(state, item, context);
  return { item, coverage: coverageOf({ sources, cards, partPlans: plans, chapters }) };
}

/* ---------- the top-up of a published deck's material: a NEW draft, the deck's next part (lib/deck-parts.js) ---------- */

/** The decks that hold a document's questions (published, not archived, not a system deck): where its next part can go, the one with the most of them first. [{ id, title, questions, total, nextPart }] */
export function documentCandidates(state, ids) {
  const own = new Set(ids);
  return (Array.isArray(state?.decks) ? state.decks : []).filter(deck => !deck.archived && !deck.systemKind)
    .map((deck, at) => ({ deck, at, questions: (deck.cards || []).filter(card => !card.suspended && [...cardSourceIds(card)].some(id => own.has(id))).length }))
    .filter(item => item.questions > 0).sort((a, b) => b.questions - a.questions || a.at - b.at)
    .map(({ deck, questions }) => ({ id: deck.id, title: deck.title, questions, total: (deck.cards || []).length, nextPart: nextPartOf(deck) }));
}

const LIVE_RUNS = new Set(['running', 'paused', 'waiting']);
/** The sections a draft of these sources is working on: the rounds not done of a run that is running, paused or waiting for the learner. A run that stopped is not working on its sections. */
function inFlightKeys(state, ids) {
  const own = new Set(ids), keys = new Set();
  for (const draft of Array.isArray(state?.drafts) ? state.drafts : []) {
    if (!draft || draft.editingDeckId || draft.editorial?.repairOfDeckId || !LIVE_RUNS.has(draft.editorial?.coverageRun?.state)) continue;
    if (!(draft.editorial.generation?.sourceIds || []).some(id => own.has(id))) continue;
    for (const round of roundList(draft.editorial.coverageSpec)) if (round.status === 'pending' || round.status === 'running') for (const key of round.sectionIds) keys.add(key);
  }
  return keys;
}

/**
 * 为没覆盖的部分补题 of a DOCUMENT whose questions were published (the 资料 row, the reader): the round a NEW draft would run now, over the document's sections that have no question (published
 * and draft questions count) and that no other draft is working on. `partOf` is the deck the draft is for (default: the deck that holds the most of the document's questions).
 * -> null (no such document) | { item, coverage, planning, candidates, chosen, inFlight, round, request?, sources, draft, canTopUp }: `coverage` is the document's (what the 资料 row says), `planning`
 * the same without the sections in flight (what the plan is made over), `draft` the draft the run starts from (no question yet).
 */
export function documentTopUp(state, args = {}, { sectionIds, limit = ROUND_LIMIT, batchSize = 5, partOf } = {}) {
  const item = findItem(documentItems(state), args);
  if (!item) return null;
  const byId = sourcesById(state), ids = item.sourceIds.filter(id => typeof byId.get(id)?.text === 'string'), sources = ids.map(id => byId.get(id));
  const candidates = documentCandidates(state, ids), chosen = partOf === undefined ? candidates[0] : candidates.find(candidate => candidate.id === partOf);
  const draft = { cards: [], editorial: { generation: { sourceIds: ids }, part: { deckId: chosen?.id || candidates[0]?.id || '-', n: chosen?.nextPart ?? 2 } } };
  const coverage = coverageForDraft(state, draft, { targets: true }), flight = inFlightKeys(state, ids);
  const planning = flight.size ? { ...coverage, sections: coverage.sections.filter(section => section.state === 'covered' || !flight.has(section.key)) } : coverage;
  const round = planRound(planning, { limit, ...(Array.isArray(sectionIds) ? { keys: sectionIds } : {}) });
  const inFlight = coverage.sections.filter(section => section.state !== 'covered' && flight.has(section.key)).length;
  return { item, coverage, planning, candidates, chosen: chosen || null, inFlight, round, sources, draft, canTopUp: candidates.length > 0 && !round.error && round.sections > 0,
    ...(round.error ? {} : { request: roundRequest(round, planning, sources, { batchSize }) }) };
}

/** The digest (lib/coverage.js coverageDigest) of every document that has a question (published or in a draft), keyed like groupSourcesByDocument: for the 资料 rows. A document with no question has no entry. */
export function materialCoverageIndex(state) {
  const by = cardsBySource(state);
  if (!by.size) return {};
  const byId = sourcesById(state), views = segmentationViews(state), listed = everyItem(state), family = familyReader(state, listed), result = {};
  for (const item of listed) {
    if (item.archived) continue;
    const related = family(item);
    if (![...item.sourceIds, ...related].some(id => by.has(id))) continue;
    const { sources, cards, plans, chapters } = coverageOfItem(state, item, { by, byId, views, family: () => related });
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
