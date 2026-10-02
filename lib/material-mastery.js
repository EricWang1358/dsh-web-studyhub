/* 资料掌握度 (material mastery): how well the questions linked to some pages, a chapter or a whole document are known.
   Pure, no I/O; the backend (the snapshot's `materialMastery`, `materials.pages.cards`) and the reader share it.

   Nothing new is measured. A page's mastery is DERIVED from the review state of the cards that cite it: each card has the
   level the dashboard gives it (lib/mastery.js cardLevel: new / weak / learning / familiar / mastered, from the SM-2
   interval and the last grade), and the percentage is the dashboard's own weighting of those levels. So it rises when a
   linked card is answered well and its review interval grows, and it can never disagree with the deck mastery shown on the
   dashboard for the same cards. Reading time, clicks and page views never count.

   "No questions" is its own state (percent null), not 0%: an unlearned page (its questions all new) is 0%. The states:
     none       the pages have no question yet                     (还没出题)
     unlearned  every linked question is still new                 (未学)
     learning   some were answered, the whole is below 60%         (学习中)
     familiar   at least 60%, or 80% with a weak question left     (熟悉)
     mastered   at least 80% and no weak question (the dashboard's "done")  (已掌握)
   Suspended cards and archived decks are left out (like the dashboard); a card of a parked course (lib/course-active.js)
   counts too and is flagged `inactive`, so a view can say so. */
import { cardLevel, latestOutcomes, isDue, LEVELS, LEVEL_WEIGHT, DONE_MASTERY } from './mastery.js';
import { groupSourcesByDocument } from './source-groups.js';
import { segmentationViews, stampSegmentations } from './document-outline.js';
import { courseActivityRules } from './course-active.js';

export const MATERIAL_STATES = Object.freeze(['none', 'unlearned', 'learning', 'familiar', 'mastered']);
export const FAMILIAR_AT = 60;

/**
 * The summary of linked cards: items `{ level, due?, inactive? }` (one per card). `percent` is null when there are none.
 * @returns {{ total, counts: {new,weak,learning,familiar,mastered}, due, weak, fresh, inactive, percent, state }}
 */
export function summarizeLinked(items = []) {
  const counts = Object.fromEntries(LEVELS.map(level => [level, 0]));
  let weight = 0, due = 0, inactive = 0;
  for (const item of items) {
    const level = LEVELS.includes(item.level) ? item.level : 'new';
    counts[level]++; weight += LEVEL_WEIGHT[level];
    if (level !== 'new' && item.due) due++;
    if (item.inactive) inactive++;
  }
  const total = items.length;
  if (!total) return { total: 0, counts, due: 0, weak: 0, fresh: 0, inactive: 0, percent: null, state: 'none' };
  const percent = Math.round(weight / total * 100);
  const state = counts.new === total ? 'unlearned'
    : percent >= DONE_MASTERY && !counts.weak ? 'mastered' : percent >= FAMILIAR_AT ? 'familiar' : 'learning';
  return { total, counts, due, weak: counts.weak, fresh: counts.new, inactive, percent, state };
}

/** "5 道题 · 2 道到期 · 1 道薄弱 · 1 道新题": only what is there; `words` supplies the language ({ questions, due, weak, fresh }: n => text). */
export function dueNewWeakLine(summary, words) {
  if (!summary?.total) return '';
  return [words.questions(summary.total), summary.due > 0 && words.due(summary.due), summary.weak > 0 && words.weak(summary.weak),
    summary.fresh > 0 && words.fresh(summary.fresh)].filter(Boolean).join(' · ');
}

const refKey = (deckId, cardId) => `${deckId}|${cardId}`;

/**
 * Every card that cites a source, by source id: `bySource` Map<sourceId, links>, a link per (card, source):
 * `{ deckId, cardId, level, due, inactive, start, end }` where `start`/`end` are where the card points into the source text
 * (its selection, else where its quote first stands; null when unknown). `levels` Map<"deckId|cardId", level>.
 * Suspended cards and archived decks are left out.
 */
export function linkedCardIndex(state, { now = Date.now() } = {}) {
  const sources = new Map((Array.isArray(state?.sources) ? state.sources : []).map(source => [source.id, source]));
  const outcome = latestOutcomes(Array.isArray(state?.attempts) ? state.attempts : []), rules = courseActivityRules(state || {});
  const bySource = new Map(), levels = new Map();
  for (const deck of Array.isArray(state?.decks) ? state.decks : []) {
    if (deck.archived) continue;
    const inactive = !rules.deckActive(deck);
    for (const card of deck.cards || []) {
      if (card.suspended) continue;
      const level = cardLevel(card, outcome(deck.id, card.id)), due = level !== 'new' && isDue(card, now);
      levels.set(refKey(deck.id, card.id), level);
      const places = new Map(), place = (sourceId, start, end) => {
        if (typeof sourceId !== 'string' || !sourceId) return;
        const known = places.get(sourceId);
        if (!known || (known.start === null && Number.isInteger(start))) places.set(sourceId, { start: Number.isInteger(start) ? start : null, end: Number.isInteger(end) ? end : null });
      };
      for (const selection of card.selections || []) place(selection?.sourceId, selection?.start, selection?.end);
      for (const citation of card.citations || []) {
        if (!citation) continue;
        if (citation.selection) place(citation.selection.sourceId || citation.sourceId, citation.selection.start, citation.selection.end);
        else {
          const text = sources.get(citation.sourceId)?.text, at = text && citation.quote ? String(text).indexOf(citation.quote) : -1;
          place(citation.sourceId, at >= 0 ? at : null, at >= 0 ? at + citation.quote.length : null);
        }
      }
      for (const [sourceId, { start, end }] of places) {
        if (!bySource.has(sourceId)) bySource.set(sourceId, []);
        bySource.get(sourceId).push({ deckId: deck.id, cardId: card.id, level, due, inactive, start, end });
      }
    }
  }
  return { bySource, levels };
}

/** The cards that point into any of `sourceIds`, one entry per card (a card on two pages counts once), with their summary. */
export function documentCards(index, sourceIds) {
  const cards = new Map();
  for (const sourceId of sourceIds || []) for (const link of index.bySource.get(sourceId) || []) {
    const key = refKey(link.deckId, link.cardId);
    if (!cards.has(key)) cards.set(key, { deckId: link.deckId, cardId: link.cardId, level: link.level, due: link.due, inactive: link.inactive, links: [] });
    cards.get(key).links.push({ sourceId, start: link.start, end: link.end });
  }
  const list = [...cards.values()];
  return { cards: list, summary: summarizeLinked(list) };
}

/**
 * Which chapter of a document (an item of groupSourcesByDocument) a place belongs to: the chapter's `index`, or null.
 * The learner's chapters (a kept outline applied; `item.segmentation`) follow the position: the last chapter that starts at or
 * before it (a card with no known offset is on the page, which belongs to the chapter that starts it). A converted book's
 * chapters are whole pages.
 */
export function chapterIndexOf(item, sourceId, offset) {
  const chapters = item?.chapters || [];
  if (!chapters.length) return null;
  if (!item.segmentation) return chapters.find(chapter => chapter.sourceIds?.includes(sourceId))?.index ?? null;
  const at = item.sourceIds.indexOf(sourceId);
  if (at < 0) return null;
  const where = Number.isInteger(offset) ? offset : 0;
  let owner = null;
  for (const chapter of chapters) {
    if (chapter.front || chapter.startSourceId === undefined) continue;
    const start = item.sourceIds.indexOf(chapter.startSourceId);
    if (start >= 0 && (start < at || (start === at && (chapter.startOffset || 0) <= where))) owner = chapter;
  }
  return owner ? owner.index : chapters.find(chapter => chapter.front)?.index ?? null;
}

/**
 * The mastery of every document that has a question, for the 资料 page: `{ [item.key]: { document, pages: { [sourceId]: summary },
 * chapters: { [chapter.index]: summary } } }` keyed like groupSourcesByDocument. A page, chapter or document with no question
 * has no entry (the row says 还没出题). The chapters are read through the one accessor, so a kept segmentation counts.
 */
export function materialMasteryIndex(state, { now = Date.now() } = {}) {
  const index = linkedCardIndex(state, { now });
  if (!index.bySource.size) return {};
  const sources = stampSegmentations(Array.isArray(state.sources) ? state.sources : [], segmentationViews(state));
  const result = {};
  for (const item of groupSourcesByDocument(sources)) {
    if (!item.sourceIds.some(id => index.bySource.has(id))) continue;
    const document = new Map(), chapters = new Map(), pages = {};
    for (const sourceId of item.sourceIds) {
      const links = index.bySource.get(sourceId);
      if (!links) continue;
      pages[sourceId] = summarizeLinked(links);
      for (const link of links) {
        const key = refKey(link.deckId, link.cardId);
        if (!document.has(key)) document.set(key, link);
        const chapter = chapterIndexOf(item, sourceId, link.start);
        if (chapter === null) continue;
        if (!chapters.has(chapter)) chapters.set(chapter, new Map());
        if (!chapters.get(chapter).has(key)) chapters.get(chapter).set(key, link);
      }
    }
    result[item.key] = { document: summarizeLinked([...document.values()]), pages,
      chapters: Object.fromEntries([...chapters].map(([chapter, links]) => [chapter, summarizeLinked([...links.values()])])) };
  }
  return result;
}

const memo = { root: undefined, revision: undefined, minute: -1, value: null };
/** The snapshot's `materialMastery`, computed once per library revision and minute (due dates move with time), not per poll. */
export function materialMasteryOf(state, { root = '', now = Date.now() } = {}) {
  const minute = Math.floor(now / 60000), revision = state?.revision;
  if (memo.value && memo.root === root && memo.revision === revision && revision !== undefined && memo.minute === minute) return memo.value;
  const value = materialMasteryIndex(state, { now });
  Object.assign(memo, { root, revision, minute, value });
  return value;
}

const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max)}…` : text; };

/** The selection of `card` that points into `sourceId`: the stored one, else one made of the cited quote (no context). */
function selectionInto(card, sourceId) {
  const stored = [...(card.selections || []), ...(card.citations || []).map(citation => citation?.selection)]
    .find(selection => selection?.sourceId === sourceId && selection.quote);
  if (stored) return stored;
  const cited = (card.citations || []).find(citation => citation?.sourceId === sourceId && citation.quote);
  return cited ? { sourceId, quote: cited.quote, prefix: '', suffix: '' } : null;
}

/**
 * `materials.pages.cards`: the cards that point into a document (or into some of its pages), for the reader.
 * args: `documentId` or `sourceId` (any page of it) and optionally `sourceIds` to narrow to some pages.
 * -> { status: 'ok' | 'missing', documentId, key, sourceIds, cards: [{ deckId, deckTitle, course, cardId, kind, sourceQa, prompt, level, due,
 *      inactive, links: [{ sourceId, start, end, selection? }] }], summary, inactiveCourses }
 * A card on two pages is one entry with two links. Cards of parked courses are listed and flagged `inactive`: the learner
 * is reading this document, so they are offered, and said to be parked.
 */
export function pagesCardsView(state, args = {}, { now = Date.now() } = {}) {
  const items = groupSourcesByDocument(stampSegmentations(Array.isArray(state?.sources) ? state.sources : [], segmentationViews(state)));
  const anchor = args.sourceId || (Array.isArray(args.sourceIds) ? args.sourceIds[0] : undefined);
  const item = args.documentId ? items.find(entry => entry.documentId === args.documentId || entry.key === args.documentId || `source-${anchor}` === args.documentId)
    : items.find(entry => entry.sourceIds.includes(anchor));
  if (!item) return { status: 'missing', cards: [], summary: summarizeLinked([]), inactiveCourses: [], sourceIds: [] };
  const pages = Array.isArray(args.sourceIds) && args.sourceIds.length ? args.sourceIds.filter(id => item.sourceIds.includes(id)) : item.sourceIds;
  const { cards, summary } = documentCards(linkedCardIndex(state, { now }), pages);
  const decks = new Map((state.decks || []).map(deck => [deck.id, deck])), rules = courseActivityRules(state);
  const courses = new Set();
  const view = cards.map(entry => {
    const deck = decks.get(entry.deckId), card = deck.cards.find(candidate => candidate.id === entry.cardId), course = rules.nameOfDeck(deck) || '';
    if (entry.inactive) courses.add(course);
    return { deckId: deck.id, deckTitle: deck.title, course, cardId: card.id, kind: card.kind, sourceQa: card.sourceQa === true, prompt: clip(card.prompt, 300),
      level: entry.level, due: entry.due, inactive: entry.inactive,
      links: entry.links.map(link => { const selection = selectionInto(card, link.sourceId); return { sourceId: link.sourceId, start: link.start, end: link.end, ...(selection ? { selection } : {}) }; }) };
  });
  return { status: 'ok', documentId: item.documentId, key: item.key, sourceIds: [...item.sourceIds], cards: view, summary, inactiveCourses: [...courses] };
}
