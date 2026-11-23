// @ts-check
/* 题目出处 (Issue #1197): read-only lookup of where one question sits in its course's materials, chapters, and review book.
   Pure, no I/O, no model call, never writes state (never calls openCourseBook). */
import { courseOf } from '../../focus.js';
import { layoutOf, rowsForIndex } from '../../course-outline.js';
import { courseDocuments, nodeOf, refKey, restKey } from '../../course-outline-index.js';
import { cardPlaceList } from '../../card-places.js';
import { createLocator } from '../../quote-locate.js';
import { currentCourseOutline } from '../../course-outline-book.js';
import { bookKey } from '../../course-outline-book-view.js';
import { genFile, recordOf } from '../../course-book-files.js';
import { currentCourseNotes } from '../../course-book.js';
import { leafOfCard, resolveBookCourse } from '../../course-book-qa.js';

const EMPTY = Object.freeze({ course: null, document: null, chapter: null, leaf: null });
const CHAPTER_NODE_KEY = /#\d+$/;

const quotesOf = card => [...new Set([...(card.citations || []).map(citation => citation?.selection?.quote || citation?.quote), ...(card.selections || []).map(selection => selection?.quote)]
  .filter(quote => typeof quote === 'string' && quote.trim()))];

const sourceIndexCache = new WeakMap();
function sourcesByIdOf(sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (Object.isFrozen(list)) {
    const hit = sourceIndexCache.get(list);
    if (hit) return hit;
    const built = {
      byId: new Map(list.map(source => [source.id, source])),
      allExplicitCourses: list.every(source => Array.isArray(source?.courses)),
    };
    sourceIndexCache.set(list, built);
    return built;
  }
  return {
    byId: new Map(list.map(source => [source.id, source])),
    allExplicitCourses: false,
  };
}

const courseDocsCache = new WeakMap();
const MAX_COURSE_DOCS_PER_SOURCES = 24;
/** Cache courseDocuments + layout across quiz turns while sources/documents/courses stay identical (answer writes only change decks/attempts/runs). */
function cachedCourseDocuments(state, course, allExplicitCourses) {
  const sources = state?.sources;
  const documents = state?.documents;
  const courses = state?.courses;
  const cacheable = Array.isArray(sources) && Object.isFrozen(sources)
    && (documents === undefined || Object.isFrozen(documents))
    && (courses === undefined || Object.isFrozen(courses));
  if (cacheable) {
    let byCourse = courseDocsCache.get(sources);
    if (!byCourse) courseDocsCache.set(sources, byCourse = new Map());
    const hit = byCourse.get(course);
    if (hit && hit.documents === documents && hit.courses === courses
      && (allExplicitCourses || (hit.decks === state.decks && hit.drafts === state.drafts))) {
      return hit.value;
    }
    const value = courseDocuments(state, course);
    if (byCourse.size >= MAX_COURSE_DOCS_PER_SOURCES) byCourse.delete(byCourse.keys().next().value);
    byCourse.set(course, { documents, courses, decks: state.decks, drafts: state.drafts, value });
    return value;
  }
  return courseDocuments(state, course);
}

/**
 * @param {Record<string, any>} state
 * @param {{ deckId?: string, cardId?: string }} [args]
 */
function resolveDeckAndCard(state, args = {}) {
  const { deckId, cardId } = args || {};
  if (typeof cardId !== 'string' || !cardId) return null;
  const decks = Array.isArray(state?.decks) ? state.decks : [];
  if (typeof deckId === 'string' && deckId) {
    const exactDeck = decks.find(deck => deck && !deck.archived && !deck.systemKind && deck.id === deckId)
      || decks.find(deck => deck && deck.id === deckId);
    const exactCard = exactDeck?.cards?.find(card => card?.id === cardId);
    if (exactDeck && exactCard) return { deck: exactDeck, card: exactCard };
  }
  for (const deck of decks) {
    if (!deck || deck.archived || deck.systemKind) continue;
    const card = deck.cards?.find(item => item?.id === cardId);
    if (card) return { deck, card };
  }
  for (const deck of decks) {
    if (!deck) continue;
    const card = deck.cards?.find(item => item?.id === cardId);
    if (card) return { deck, card };
  }
  return null;
}

/**
 * Locate one question inside its course's outline documents/chapters and (if built) review-book leaf.
 * Read-only: never mutates state or calls openCourseBook.
 * @param {Record<string, any>} state
 * @param {{ deckId?: string, cardId?: string }} [args]
 * @param {{ root?: string, now?: number }} [options]
 */
export function cardPlace(state, args = {}, { root: _root = '', now: _now = Date.now() } = {}) {
  const resolved = resolveDeckAndCard(state, args);
  if (!resolved) return { ...EMPTY };
  const course = courseOf(resolved.deck, state);
  if (typeof course !== 'string') return { ...EMPTY };

  const { byId, allExplicitCourses } = sourcesByIdOf(state.sources);
  const { candidates, owners } = cachedCourseDocuments(state, course, allExplicitCourses);
  const locators = new Map();
  const locate = id => { let found = locators.get(id); if (!found) locators.set(id, found = createLocator(byId.get(id)?.text)); return found; };

  const ref = refKey(resolved.deck.id, resolved.card.id);
  const places = cardPlaceList(resolved.card, byId, locate);
  const reached = new Map();
  for (const place of places) {
    if (!byId.has(place.sourceId)) continue;
    const items = owners.get(place.sourceId);
    if (!items) continue;
    for (const item of items) {
      if (item.sourceIds.includes(place.sourceId)) {
        const { node, order } = nodeOf(item, place.sourceId, place.start);
        reached.set(node, { item, order });
        continue;
      }
      let found = null;
      for (const quote of quotesOf(resolved.card)) {
        for (const id of item.sourceIds) {
          const at = locate(id)(quote);
          if (at) { found = nodeOf(item, id, at.start); break; }
        }
        if (found) break;
      }
      const { node, order } = found || { node: item.chapters?.length ? restKey(item.key) : item.key, order: [item.sourceIds.length, -1] };
      if (!reached.has(node)) reached.set(node, { item, order });
    }
  }

  const nodes = new Map(), docOf = new Map(), entryNodes = new Set();
  for (const [node, { item, order }] of reached) {
    docOf.set(node, item.key);
    entryNodes.add(node);
    nodes.set(node, new Map([[ref, order]]));
  }
  const singleIndex = {
    course,
    documents: candidates,
    allDocuments: candidates,
    cards: new Map([[ref, { deckId: resolved.deck.id, cardId: resolved.card.id, nodes: entryNodes, ...(entryNodes.size ? {} : { reason: 'unplaced' }) }]]),
    nodes,
    docOf,
    draftNodes: new Map(),
    draftAt: new Map(),
    places: new Map([[ref, places]]),
  };
  const layout = layoutOf(singleIndex);
  const nodeKeys = [...entryNodes];
  // Prefer chapter rows (#<index> over #rest or document-level); multiple nodes keep first-citation order.
  const chosenKey = nodeKeys.find(key => CHAPTER_NODE_KEY.test(key)) ?? nodeKeys[0] ?? null;

  let document = null;
  let chapter = null;
  if (chosenKey) {
    const hashAt = chosenKey.indexOf('#');
    const docKey = docOf.get(chosenKey) ?? (hashAt >= 0 ? chosenKey.slice(0, hashAt) : chosenKey);
    const docRow = docKey ? layout.get(docKey) : null;
    if (docRow?.kind === 'document') {
      document = { key: docRow.key, title: docRow.item.title };
    }
    const chosenRow = layout.get(chosenKey);
    if (chosenRow?.kind === 'chapter' && !chosenRow.front && chosenRow.title) {
      chapter = { key: chosenRow.key, title: chosenRow.title };
    }
  }

  let leaf = null;
  const bookCourse = resolveBookCourse(state, course);
  const outlineRecord = currentCourseOutline(state.sources, bookCourse);
  const bookRecord = recordOf(state, bookCourse);
  if (outlineRecord && bookRecord?.bookDoc?.manifest?.nodes) {
    const rows = rowsForIndex(state, bookCourse, singleIndex, layout);
    const matchedLeaf = leafOfCard(state, bookCourse, bookRecord.bookDoc, { deckId: resolved.deck.id, cardId: resolved.card.id }, rows);
    if (matchedLeaf) {
      const notes = currentCourseNotes(state.sources, bookCourse);
      const unbuilt = !!(notes && !(notes.courseNotes?.leaves || []).some(item => item.id === matchedLeaf.id && item.body));
      const genText = String(bookRecord.bookDoc.files?.[genFile(matchedLeaf.id)]?.text ?? '').trim();
      leaf = {
        key: bookKey(matchedLeaf.id),
        title: matchedLeaf.title,
        built: genText.length > 0 && !unbuilt,
        ...(bookCourse !== course ? { course: bookCourse } : {}),
      };
    }
  }

  return { course, document, chapter, leaf };
}
