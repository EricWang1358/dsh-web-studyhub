/* 课程总纲 (course outline), step 1: where every question of a course stands in the course's materials. Pure, no I/O; read by lib/course-outline.js.

   The course's documents are the materials filed under the course (lib/source-courses.js sourcesWithCourses: explicit courses, else the ones the
   citing decks give). An uncategorised material (no course, also none inferred), a material of another course and an archived one are not, even
   when a question of the course cites them (owner decision, PR #398): the learner files the material under the course to see its questions here.
   A question is placed by the one rule the coverage figure uses (lib/card-places.js cardPlaceList: its selection, else the place a plan verified,
   else where its quote stands, also when written a little differently, lib/quote-locate.js). A place belongs to every document whose source family
   holds it (lib/material-mastery.js documentSourceFamily: older versions, the same recording, the parts of a merged one); inside a document with
   chapters it is in the chapter that holds its offset (chapterIndexOf). A question citing an older version or another material of the family is
   found again by its quote in the document's own text; one that is not found there is in the document's "not in a chapter" row (`rest`).
   A question no document holds is 未归位, with why: `none` (it cites nothing), `uncategorised` (it cites a material filed under no course: filing it
   under this course places the question), `elsewhere` (another course's or an archived material), `missing` (the material is gone).
   The questions are those of the course's decks (lib/focus.js decksInCourse: not archived, not suspended); drafts of the course are placed the
   same way and only counted. */
import { cardLevel, latestOutcomes, isDue } from './mastery.js';
import { decksInCourse, courseOf } from './focus.js';
import { sourcesWithCourses, knownCourseNames } from './source-courses.js';
import { courseScope } from './course-tree.js';
import { groupSourcesByDocument } from './source-groups.js';
import { segmentationViews, stampSegmentations } from './document-outline.js';
import { courseActivityRules } from './course-active.js';
import { cardPlaceList } from './card-places.js';
import { createLocator } from './quote-locate.js';
import { documentSourceFamily, versionFamilies, recordingIndex, chapterIndexOf } from './material-mastery.js';
import { cleanDeckTitle } from './deck-title.js';

export const UNPLACED_KEY = 'unplaced';
export const refKey = (deckId, cardId) => `${deckId}|${cardId}`;
/** The key of a chapter row (`index`), and of the row of a document's questions that no chapter holds. */
export const chapterKey = (documentKey, index) => `${documentKey}#${index}`;
export const restKey = documentKey => `${documentKey}#rest`;

const PROMPT_MAX = 140;
const shortPrompt = prompt => { const text = String(prompt ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿').replace(/\s+/g, ' ').trim(); return text.length > PROMPT_MAX ? `${text.slice(0, PROMPT_MAX)}…` : text; };
const quotesOf = card => [...new Set([...(card.citations || []).map(citation => citation?.selection?.quote || citation?.quote), ...(card.selections || []).map(selection => selection?.quote)]
  .filter(quote => typeof quote === 'string' && quote.trim()))];

/** The course's documents, for each source id the documents whose family holds it (`owners`), and the uncategorised materials by source id (`loose`). */
function courseDocuments(state, course) {
  const within = courseScope(course, knownCourseNames(state));
  const sources = stampSegmentations(sourcesWithCourses(state), segmentationViews(state));
  const listed = groupSourcesByDocument(sources, { documents: state.documents });
  const context = { families: versionFamilies(state.documents), listed, recordings: recordingIndex(state, listed) };
  const own = item => (item.courses.length ? item.courses.some(within) : within.all || within.uncategorised);
  const candidates = listed.filter(item => !item.archived && own(item)), owners = new Map(), loose = new Map();
  for (const item of candidates) for (const id of documentSourceFamily(state, item, context).ids) {
    if (!owners.has(id)) owners.set(id, []);
    owners.get(id).push(item);
  }
  for (const item of listed) if (!item.archived && !item.courses.length && !own(item)) for (const id of documentSourceFamily(state, item, context).ids) if (!loose.has(id)) loose.set(id, item);
  return { candidates, owners, loose };
}

/** Where a place stands in a document: its node key and its reading position ([page, offset]). */
function nodeOf(item, sourceId, start) {
  const at = item.sourceIds.indexOf(sourceId), order = [at, Number.isInteger(start) ? start : -1];
  if (!item.chapters?.length) return { node: item.key, order };
  const chapter = chapterIndexOf(item, sourceId, start);
  return { node: chapter === null ? restKey(item.key) : chapterKey(item.key, chapter), order };
}

/**
 * The placement of one course (optionally one deck of it): `{ course, decks, cards: Map<ref, entry>, nodes: Map<node, Map<ref, order>>,
 * docOf: Map<node, document key>, documents, draftNodes: Map<node, Set<ref>>, draftCards, looseCited: Map<document key, { key, title }> }`. An entry is `{ deckId, cardId, deckTitle, prompt,
 * level, due, inactive, rank, nodes: Set, reason? }`; `rank` is the deck's place in the course and the card's in the deck.
 */
export function buildOutlineIndex(state, { course, deckId, now = Date.now() } = {}) {
  const { candidates, owners, loose } = courseDocuments(state, course), looseCited = new Map();
  const byId = new Map((Array.isArray(state.sources) ? state.sources : []).map(source => [source.id, source]));
  const locators = new Map();
  const locate = id => { let found = locators.get(id); if (!found) locators.set(id, found = createLocator(byId.get(id)?.text)); return found; };
  const allDecks = decksInCourse(state, course), decks = allDecks.filter(deck => !deckId || deck.id === deckId);
  const outcome = latestOutcomes(Array.isArray(state.attempts) ? state.attempts : []), rules = courseActivityRules(state);
  const nodes = new Map(), docOf = new Map(), cards = new Map(), draftNodes = new Map(), used = new Set();
  const join = (map, node, ref, value) => { if (!map.has(node)) map.set(node, new Map()); if (!map.get(node).has(ref)) map.get(node).set(ref, value); };

  // Every document a card's places reach, and its node in each; a place in another version or material of the family is found again by the quote.
  const placeCard = (card, ref, onNode) => {
    const places = cardPlaceList(card, byId, locate);
    // Why it has no row, the cause the learner can fix first: an uncategorised material, then another course's (or an archived) one, then a deleted one.
    const RANK = { none: 0, missing: 1, elsewhere: 2, uncategorised: 3 };
    let reason = places.length ? 'missing' : 'none';
    const because = next => { if (RANK[next] > RANK[reason]) reason = next; };
    const reached = new Map(), filedNowhere = new Map();
    for (const place of places) {
      if (!byId.has(place.sourceId)) continue;
      const items = owners.get(place.sourceId);
      if (!items) {
        const item = loose.get(place.sourceId);
        if (item) { because('uncategorised'); filedNowhere.set(item.key, { key: item.key, title: item.title }); } else because('elsewhere');
        continue;
      }
      for (const item of items) {
        if (item.sourceIds.includes(place.sourceId)) { const { node, order } = nodeOf(item, place.sourceId, place.start); reached.set(node, { item, order }); continue; }
        let found = null;
        for (const quote of quotesOf(card)) {
          for (const id of item.sourceIds) { const at = locate(id)(quote); if (at) { found = nodeOf(item, id, at.start); break; } }
          if (found) break;
        }
        const { node, order } = found || { node: item.chapters?.length ? restKey(item.key) : item.key, order: [item.sourceIds.length, -1] };
        if (!reached.has(node)) reached.set(node, { item, order });
      }
    }
    for (const [node, { item, order }] of reached) { docOf.set(node, item.key); used.add(item.key); onNode(node, ref, order); }
    // The uncategorised materials 未归位 questions cite: the page names them, so the learner knows which ones to file under the course.
    if (!reached.size && onNode.published) for (const [key, value] of filedNowhere) looseCited.set(key, value);
    return reached.size ? null : reason;
  };

  decks.forEach((deck, deckRank) => {
    const inactive = !rules.deckActive(deck), deckTitle = cleanDeckTitle(deck.title);
    (deck.cards || []).forEach((card, cardRank) => {
      if (!card || card.suspended) return;
      const ref = refKey(deck.id, card.id), level = cardLevel(card, outcome(deck.id, card.id));
      const entry = { deckId: deck.id, cardId: card.id, deckTitle, prompt: shortPrompt(card.prompt), level, due: level !== 'new' && isDue(card, now), inactive, rank: [deckRank, cardRank], nodes: new Set() };
      cards.set(ref, entry);
      const reason = placeCard(card, ref, Object.assign((node, key, order) => { entry.nodes.add(node); join(nodes, node, key, order); }, { published: true }));
      if (reason) entry.reason = reason;
    });
  });
  const within = courseScope(course, knownCourseNames(state));
  let draftCards = 0;
  for (const draft of Array.isArray(state.drafts) ? state.drafts : []) {
    if (!draft || draft.editingDeckId || draft.editorial?.repairOfDeckId || deckId || !within(courseOf(draft, state))) continue;
    for (const card of draft.cards || []) {
      if (!card || card.suspended) continue;
      draftCards += 1;
      placeCard(card, refKey(draft.id, card.id), (node, key) => { if (!draftNodes.has(node)) draftNodes.set(node, new Set()); draftNodes.get(node).add(key); });
    }
  }
  // A document of the course is listed even without a question (还没出题); with a deck chosen, only where it has questions.
  const documents = candidates.filter(item => used.has(item.key) || !deckId);
  return { course, decks: allDecks.map(deck => ({ id: deck.id, title: cleanDeckTitle(deck.title), total: (deck.cards || []).filter(card => card && !card.suspended).length })),
    cards, nodes, docOf, documents, draftNodes, draftCards, looseCited };
}
