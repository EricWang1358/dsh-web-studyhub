/* 本节题目 of the reader (#1013): which questions of the section (or chapter) on screen the panel lists, in what order, and the line under its heading
   (错题 n · 追问 n · 批注 n). Pure, no DOM: the reading loop (practice/useReadingLoop.js) has already placed every question and every 批注 under the outline
   entry its passage is in; these functions only pick and count. The answering itself is an ordinary review run (ui/review/InlineRun.jsx). */
import { cardKey, rangeCards } from './practice-range.js';

/** How many questions a reader panel lists (本节题目 and 错题): the rest are on the practice page or on 错题与待巩固. */
export const SHOWN_MAX = 30;

/** The ranges the panel offers, from the reading loop's own options: 本节 (`here`) and 本章 (`chapter`, only when it holds more than 本节). */
export const sectionRanges = options => (options || []).filter(option => option.kind === 'here' || option.kind === 'chapter');

/** The range shown: the one chosen while it is offered, else 本节 when it has a question, else 本章 when it has one, else 本节. Null when none is offered. */
export function shownRange(ranges, choice) {
  const chosen = choice && ranges.find(option => option.kind === choice);
  if (chosen) return chosen;
  const here = ranges.find(option => option.kind === 'here'), chapter = ranges.find(option => option.kind === 'chapter');
  if (here?.cards.length) return here;
  if (chapter?.cards.length) return chapter;
  return here || chapter || null;
}

/**
 * The questions of a range in the order of the text: by the outline position of the entry each is placed in (`entryOf(key)`, `order`: entry id -> index),
 * then by where its first passage starts. -> { cards (all), shown (at most `max`), rest (how many more) }.
 */
export function questionsOf(option, { entryOf = () => null, order = new Map(), max = SHOWN_MAX } = {}) {
  const cards = (option?.cards || []).map((card, at) => ({ card, at, rank: order.get(entryOf(cardKey(card))) ?? Number.MAX_SAFE_INTEGER, start: card.links?.[0]?.start ?? 0 }))
    .sort((a, b) => a.rank - b.rank || a.start - b.start || a.at - b.at).map(entry => entry.card);
  return { cards, shown: cards.slice(0, max), rest: Math.max(0, cards.length - max) };
}

/** A key that names a range's questions, whatever order they were listed in: what the 追问 of a range are kept under (with the library version). */
export const rangeKey = cards => (cards || []).map(cardKey).sort().join(',');

/** The 追问 kept on the questions of a range (course.outline.qa items of kind 'card', read for those questions). */
export const followupsOf = items => (items || []).filter(item => item?.kind === 'card');

/**
 * The line under the heading: { wrong, followups, notes }.
 * cards: the range's questions; wrongKeys: the `deckId|cardId` keys the 错题与待巩固 page lists for this material (a Set); followups: followupsOf(...) of
 * the range; ids / noteAssigned: the range's entry ids and the loop's placement of the 批注 (one per passage), so a 批注 counts where its passage is.
 */
export function sectionStats({ cards = [], wrongKeys = null, followups = [], ids = null, noteAssigned = null }) {
  const wrong = wrongKeys ? cards.filter(card => wrongKeys.has(cardKey(card))).length : 0;
  const notes = ids && noteAssigned ? rangeCards(ids, noteAssigned).cards.length : 0;
  return { wrong, followups: followups.length, notes };
}

/** The 批注 of a material as the loop places them: one entry per passage (annotation/model annotationLinks), each with its passage as its one link. */
export const notePlaces = links => (links || []).filter(link => link?.selection?.sourceId).map(link => ({ deckId: 'note', cardId: link.cardId,
  links: [{ sourceId: link.selection.sourceId, start: link.selection.start, end: link.selection.end, selection: link.selection }] }));
/** What the placement of those 批注 depends on: the same key, the same places (a re-read of the annotations walks nothing again); none: ''. */
export const noteKey = places => places.map(place => [place.cardId, ...place.links.map(item => `${item.sourceId}:${item.start}-${item.end}:${item.selection?.quote ?? ''}`)].join('|')).join('\n');
