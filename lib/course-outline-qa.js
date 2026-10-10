/* 复习全书 「本节问答」: `course.outline.qa`, the questions and answers kept about some rows of the 总纲 (a knowledge point, its anchors), read on demand by
   the book page (never in the snapshot). Pure, no I/O.

   course.outline.qa { course?, keys?: [row key], cards?: [{ deckId, cardId }] }
   -> { status: 'ok' | 'empty', course, items: [item], cards: { total, read, capped, limit } }
   The rows' questions (lib/course-outline.js courseRowsOf, the placement of course.outline) and the cards named, once each, at most QA_CARD_LIMIT of them in
   reading order (`capped` says more were there). Three kinds of item, one shape { kind, question, answer, at, place, openRef }:
   - 'card': a 追问 kept on a question (card.followups), only those of the card's current wording (lib/followup.js currentFollowups); also `prompt`
     (the question it is about) and `followupId`; openRef { deckId, cardId }.
   - 'qa-card': a 问答卡 (card.sourceQa: a question asked in the reader and kept as an ordinary card); the card's prompt and answer; openRef { deckId, cardId }.
   - 'passage': a 批注 of the reader (lib/contexts/materials/annotation-operations.js) whose source and offsets are inside the rows' places (the chapter that
     holds the offset, chapterIndexOf, as a question is placed) and whose passage is still the stored text (the hash matches); `id`, `parentId` (a follow-up
     inside the 批注 names the one it follows); openRef { sourceId, start, end, quote } (the reader at the passage).
   `place` is { sourceId, start, end, quote, title } (title: the material's), null when unknown. Items are in reading order (material, page, offset), then by
   `at`. A card without 追问 that is not a 问答卡 gives no item: it is practised, not asked about. */
import { currentCourse } from './focus.js';
import { currentFollowups } from './followup.js';
import { textHash } from './annotation.js';
import { cardPlaceList } from './card-places.js';
import { createLocator } from './quote-locate.js';
import { courseRowsOf, UNPLACED_KEY } from './course-outline.js';
import { nodeOf } from './course-outline-index.js';

/** The most cards one answer reads (a knowledge point of a textbook holds far fewer). */
export const QA_CARD_LIMIT = 200;
const ANSWER_MAX = 4000;
const clip = (value, max) => { const text = typeof value === 'string' ? value : ''; return text.length > max ? `${text.slice(0, max)}…` : text; };
const strings = (value, max) => (Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, max) : []);
const FAR = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
const before = (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2] || String(a.item.at ?? '').localeCompare(String(b.item.at ?? ''));

/** Every 批注 the library keeps: on a stored document's versions and on the first source of a document without a record; the same item once. */
function annotationItems(state) {
  const seen = new Map();
  const add = record => { for (const item of Array.isArray(record?.items) ? record.items : []) if (item?.id && !seen.has(item.id)) seen.set(item.id, item); };
  for (const source of Array.isArray(state.sources) ? state.sources : []) add(source?.annotations);
  for (const document of Array.isArray(state.documents) ? state.documents : []) for (const version of document?.versions || []) add(version?.annotations);
  return [...seen.values()];
}

/** `course.outline.qa` (see the top of this file). */
export function courseOutlineQa(state, args = {}, { root = '', now = Date.now() } = {}) {
  const course = args.course === undefined ? currentCourse(state) : args.course;
  if (course !== null && typeof course !== 'string') throw new Error('course.outline.qa: course must be a course name, an empty string (uncategorised) or *');
  const empty = { status: 'empty', course: course ?? null, items: [], cards: { total: 0, read: 0, capped: false, limit: QA_CARD_LIMIT } };
  if (course === null || course === undefined) return empty;
  const { index, rowOf, entriesOf } = courseRowsOf(state, course, { root, now });
  const rows = strings(args.keys, 100).map(rowOf).filter(Boolean), nodes = new Set();
  for (const row of rows) if (row !== UNPLACED_KEY) for (const node of row.nodes || []) nodes.add(node);
  const docAt = new Map(index.allDocuments.map((item, at) => [item.key, at]));
  // The questions, once each, with where they stand in the rows (the first of their places there).
  const chosen = new Map();
  const orderIn = entry => {
    let best = FAR;
    for (const node of entry.nodes) {
      const order = nodes.has(node) ? index.nodes.get(node)?.get(`${entry.deckId}|${entry.cardId}`) : null;
      const at = [docAt.get(index.docOf.get(node)) ?? FAR[0], ...(order || FAR.slice(1))];
      if (order && (at[0] - best[0] || at[1] - best[1] || at[2] - best[2]) < 0) best = at;
    }
    return best;
  };
  for (const row of rows) for (const entry of entriesOf(row)) chosen.set(`${entry.deckId}|${entry.cardId}`, entry);
  for (const ref of Array.isArray(args.cards) ? args.cards.slice(0, 2000) : []) { const entry = index.cards.get(`${ref?.deckId}|${ref?.cardId}`); if (entry) chosen.set(`${entry.deckId}|${entry.cardId}`, entry); }
  const ordered = [...chosen.values()].map(entry => ({ entry, order: orderIn(entry) }))
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2] || a.entry.rank[0] - b.entry.rank[0] || a.entry.rank[1] - b.entry.rank[1]);
  const read = ordered.slice(0, QA_CARD_LIMIT);

  const byId = new Map((Array.isArray(state.sources) ? state.sources : []).map(source => [source.id, source]));
  const decks = new Map((Array.isArray(state.decks) ? state.decks : []).map(deck => [deck.id, deck]));
  const locators = new Map(), locate = id => { let found = locators.get(id); if (!found) locators.set(id, found = createLocator(byId.get(id)?.text)); return found; };
  const titleOf = sourceId => index.allDocuments.find(item => item.sourceIds.includes(sourceId))?.title ?? byId.get(sourceId)?.title ?? '';
  const out = [];
  for (const { entry, order } of read) {
    const card = (decks.get(entry.deckId)?.cards || []).find(item => item?.id === entry.cardId);
    if (!card) continue;
    const quotes = [...(card.selections || []), ...(card.citations || [])].map(item => item?.selection?.quote || item?.quote).filter(quote => typeof quote === 'string');
    const first = cardPlaceList(card, byId, locate).find(place => byId.has(place.sourceId));
    const place = first ? { sourceId: first.sourceId, start: first.start, end: first.end, quote: clip(quotes[0], 300), title: titleOf(first.sourceId) } : null;
    const openRef = { deckId: entry.deckId, cardId: entry.cardId };
    if (card.sourceQa === true) out.push({ order, item: { kind: 'qa-card', question: clip(card.prompt, 1000), answer: clip(card.answer, ANSWER_MAX), at: card.createdAt ?? null, place, openRef } });
    for (const followup of currentFollowups(card)) out.push({ order, item: { kind: 'card', question: clip(followup.question, 1000), answer: clip(followup.answer, ANSWER_MAX), at: followup.at ?? null,
      place, openRef, prompt: clip(card.prompt, 300), followupId: followup.id } });
  }
  // The 批注 inside the rows' places: on a source of a document of the course, in a chapter (or the document) the rows hold, the passage unchanged.
  if (nodes.size) for (const note of annotationItems(state)) {
    const source = byId.get(note.sourceId);
    if (!source || !Number.isInteger(note.start) || !Number.isInteger(note.end) || typeof source.text !== 'string' || textHash(source.text.slice(note.start, note.end)) !== note.hash) continue;
    const holder = index.allDocuments.find(item => item.sourceIds.includes(note.sourceId) && nodes.has(nodeOf(item, note.sourceId, note.start).node));
    if (!holder) continue;
    const quote = clip(note.quote || source.text.slice(note.start, note.end), 300);
    out.push({ order: [docAt.get(holder.key), holder.sourceIds.indexOf(note.sourceId), note.start], item: { kind: 'passage', question: clip(note.label || note.question, 1000),
      answer: clip(note.answer, ANSWER_MAX), at: note.at ?? null, place: { sourceId: note.sourceId, start: note.start, end: note.end, quote, title: holder.title },
      openRef: { sourceId: note.sourceId, start: note.start, end: note.end, quote }, id: note.id, parentId: note.parentId ?? null } });
  }
  out.sort(before);
  return { status: 'ok', course, items: out.map(({ item }) => item), cards: { total: chosen.size, read: read.length, capped: chosen.size > QA_CARD_LIMIT, limit: QA_CARD_LIMIT } };
}
