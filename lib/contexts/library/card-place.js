// @ts-check
/* 题目出处 (Issue #1197): read-only lookup of where one question sits in its course's materials, chapters, and review book.
   Pure, no I/O, no model call, never writes state (never calls openCourseBook). */
import { courseOf } from '../../focus.js';
import { courseOutlineIndex, layoutOf, rowsForIndex } from '../../course-outline.js';
import { currentCourseOutline } from '../../course-outline-book.js';
import { bookKey } from '../../course-outline-book-view.js';
import { genFile, recordOf } from '../../course-book-files.js';
import { currentCourseNotes } from '../../course-book.js';
import { leafOfCard } from '../../course-book-qa.js';

const EMPTY = Object.freeze({ course: null, document: null, chapter: null, leaf: null });
const CHAPTER_NODE_KEY = /#\d+$/;

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
export function cardPlace(state, args = {}, { root = '', now = Date.now() } = {}) {
  const resolved = resolveDeckAndCard(state, args);
  if (!resolved) return { ...EMPTY };
  const course = courseOf(resolved.deck, state);
  if (typeof course !== 'string') return { ...EMPTY };

  const index = courseOutlineIndex(state, { course }, { root, now });
  const layout = layoutOf(index);
  const entry = index.cards.get(`${resolved.deck.id}|${resolved.card.id}`);
  const nodeKeys = entry ? [...entry.nodes] : [];
  // Prefer chapter rows (#<index> over #rest or document-level); multiple nodes keep first-citation order.
  const chosenKey = nodeKeys.find(key => CHAPTER_NODE_KEY.test(key)) ?? nodeKeys[0] ?? null;

  let document = null;
  let chapter = null;
  if (chosenKey) {
    const hashAt = chosenKey.indexOf('#');
    const docKey = index.docOf.get(chosenKey) ?? (hashAt >= 0 ? chosenKey.slice(0, hashAt) : chosenKey);
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
  const outlineRecord = currentCourseOutline(state.sources, course);
  const bookRecord = recordOf(state, course);
  if (outlineRecord && bookRecord?.bookDoc?.manifest?.nodes) {
    const rows = rowsForIndex(state, course, index, layout);
    const matchedLeaf = leafOfCard(state, course, bookRecord.bookDoc, { deckId: resolved.deck.id, cardId: resolved.card.id }, rows);
    if (matchedLeaf) {
      const notes = currentCourseNotes(state.sources, course);
      const unbuilt = !!(notes && !(notes.courseNotes?.leaves || []).some(item => item.id === matchedLeaf.id && item.body));
      const genText = String(bookRecord.bookDoc.files?.[genFile(matchedLeaf.id)]?.text ?? '').trim();
      leaf = {
        key: bookKey(matchedLeaf.id),
        title: matchedLeaf.title,
        built: genText.length > 0 && !unbuilt,
      };
    }
  }

  return { course, document, chapter, leaf };
}
