/* "做这几页的题": which questions a range of the reader holds. Pure, no DOM: the reader (practice/useReadingLoop.js) works out
   where each question points into what is drawn and hands the answer to these functions; they turn it into the options of
   the control (this page / this chapter / what was just read), the questions and their counts, and the outline meters.

   `cards` are the entries of materials.pages.cards: { deckId, cardId, level, due, inactive, links: [{ sourceId, start, end, selection? }] }.
   `outline` is the reader's structured outline (structureOutline: id, level, parent, ...). An entry's questions are its own and those of the
   sections below it, so a chapter's meter is the whole chapter's. A question that points at several places counts once in any range. */
import { summarizeLinked } from '../../../lib/material-summary.js';

export const cardKey = card => `${card.deckId}|${card.cardId}`;
const VISIT_LIMIT = 40;

/**
 * Place every question in the entries its links land in. `placeOf(link)` gives an entry id or null.
 * -> { assigned: Map<entryId, Map<key, card>>, unplaced: cards no link of which could be placed }
 */
export function assignCards(cards, placeOf) {
  const assigned = new Map(), unplaced = [];
  for (const card of cards || []) {
    const entries = new Set();
    for (const link of card.links || []) { const id = placeOf(link); if (id !== null && id !== undefined) entries.add(id); }
    if (!entries.size) { unplaced.push(card); continue; }
    for (const id of entries) {
      if (!assigned.has(id)) assigned.set(id, new Map());
      assigned.get(id).set(cardKey(card), card);
    }
  }
  return { assigned, unplaced };
}

/** The last index in 0..count-1 for which `atOrBefore(index)` holds, where it holds for a prefix only (binary search); -1 when for none. */
export function lastAtOrBefore(count, atOrBefore) {
  let low = 0, high = count - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (atOrBefore(middle)) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

/** The ids of an entry and of the entries below it (those that follow it with a deeper level). */
export function subtreeIds(outline, id) {
  const at = outline.findIndex(item => item.id === id), ids = new Set();
  if (at < 0) return ids;
  ids.add(id);
  for (let index = at + 1; index < outline.length && outline[index].level > outline[at].level; index += 1) ids.add(outline[index].id);
  return ids;
}

/** Map<entryId, summary> for every entry with at least one question in it or below it. */
export function entrySummaries(outline, assigned) {
  const parents = new Map(outline.map(item => [item.id, item.parent ?? null])), pools = new Map();
  for (const [id, cards] of assigned) {
    if (!parents.has(id)) continue;
    for (let at = id; at !== null && at !== undefined; at = parents.get(at)) {
      if (!pools.has(at)) pools.set(at, new Map());
      for (const [key, card] of cards) pools.get(at).set(key, card);
    }
  }
  return new Map([...pools].map(([id, cards]) => [id, summarizeLinked([...cards.values()])]));
}

/** The questions of a set of entries, once each, and their summary. */
export function rangeCards(ids, assigned) {
  const cards = new Map();
  for (const id of ids || []) for (const [key, card] of assigned.get(id) || []) if (!cards.has(key)) cards.set(key, card);
  const list = [...cards.values()];
  return { cards: list, summary: summarizeLinked(list) };
}

/** What review.start takes as a scope. */
export const refsOf = cards => cards.map(({ deckId, cardId }) => ({ deckId, cardId }));

/**
 * The ids of the chapter around an entry, or null when there is none worth offering. A converted book's chapters are page
 * ranges (`chapterPages`: { from, to }); a kept segmentation names the level of the chapters (`chapterLevel`); otherwise the
 * chapter is the top section the entry sits in.
 */
export function chapterEntryIds(outline, activeId, { chapterLevel, chapterPages } = {}) {
  const here = outline.find(item => item.id === activeId);
  if (!here) return null;
  let ids;
  if (chapterPages) ids = outline.filter(item => item.page >= chapterPages.from && item.page <= chapterPages.to).map(item => item.id);
  else {
    const byId = new Map(outline.map(item => [item.id, item]));
    let top = here;
    if (chapterLevel) while (top.level > chapterLevel && top.parent != null && byId.has(top.parent)) top = byId.get(top.parent);
    else while (top.parent != null && byId.has(top.parent)) top = byId.get(top.parent);
    ids = outline.filter(item => subtreeIds(outline, top.id).has(item.id)).map(item => item.id);
  }
  return ids.length > 1 && ids.includes(activeId) ? ids : null;
}

/** The pages (or sections) reached, in the order they were reached; a return to one moves it to the end. */
export function recordVisit(list, id, max = VISIT_LIMIT) {
  if (id === null || id === undefined) return list;
  return [...list.filter(item => item !== id), id].slice(-max);
}

const same = (a, b) => a.size === b.size && [...a].every(id => b.has(id));

/** How many of some questions were written from another version of the document (`otherVersion`, set by materials.pages.cards). */
export const olderCount = cards => (cards || []).filter(card => card.otherVersion).length;

/** What a whole-document set holds beyond the version being read: { olderCards, sameRecordingCards, partCards } (`otherVersion`, `otherMaterial`). */
export const inclusions = cards => ({ olderCards: olderCount(cards), sameRecordingCards: (cards || []).filter(card => card.otherMaterial === 'same').length,
  partCards: (cards || []).filter(card => card.otherMaterial === 'part').length });

/**
 * The options of the range chooser, each { kind, ids, count, cards, summary }:
 *  here      the current entry (a page, or a section with its sub-sections)
 *  chapter   `chapter` (ids from chapterEntryIds), when it holds more than "here"
 *  recent    the entries visited in this session (`visited`, ids), when there are at least two and they are not just "here"/"chapter"
 *  document  the whole document, only when no entry could hold the questions (no outline), or when more questions exist than any option holds;
 *            it counts EVERY question of the document (the 资料 row's set), also those of older versions that no section of the text being read
 *            can hold: `olderCards` (another version of the document), `sameRecordingCards` (another material of the same recording) and
 *            `partCards` (a material of a recording this merged one contains) say how many (the other options only hold what is placed in the visible version)
 * `all` are every question of the document (for the whole-document option).
 * With `draftAssigned` / `draftAll` (the questions still in drafts, placed like the published ones: `{ deckId: <draft id>, cardId, links }`),
 * every option also carries `draftCards` (the draft questions of its range, once each) and `draftIds` (the drafts they are in).
 */
export function rangeOptions({ outline, activeId, visited = [], assigned, chapter = null, all = [], draftAssigned, draftAll = [] }) {
  const options = [];
  const make = (kind, ids) => ({ kind, ids, count: ids.size, ...rangeCards(ids, assigned) });
  const withDrafts = option => {
    if (!draftAssigned) return option;
    const list = option.ids ? rangeCards(option.ids, draftAssigned).cards : draftAll;
    return { ...option, draftCards: list.length, draftIds: [...new Set(list.map(card => card.deckId))] };
  };
  if (!outline.length) {
    const list = all.length ? all : [...assigned.values()].flatMap(map => [...map.values()]);
    return [withDrafts({ kind: 'document', ids: null, count: 0, cards: list, summary: summarizeLinked(list), ...inclusions(list) })];
  }
  const current = outline.some(item => item.id === activeId) ? activeId : outline[0].id;
  const here = make('here', subtreeIds(outline, current));
  options.push(here);
  const chapterIds = chapter ? new Set(chapter) : null;
  if (chapterIds && !same(chapterIds, here.ids)) options.push(make('chapter', chapterIds));
  const seen = new Set();
  for (const id of visited) for (const inside of subtreeIds(outline, id)) seen.add(inside);
  const known = visited.filter(id => outline.some(item => item.id === id));
  if (known.length >= 2 && !same(seen, here.ids) && !(chapterIds && same(seen, chapterIds))) options.push({ ...make('recent', seen), count: known.length });
  const largest = Math.max(...options.map(option => option.summary.total));
  const drafted = options.map(withDrafts), largestDrafts = Math.max(0, ...drafted.map(option => option.draftCards || 0));
  if (all.length > largest || draftAll.length > largestDrafts) drafted.push(withDrafts({ kind: 'document', ids: null, count: 0, cards: all, summary: summarizeLinked(all), ...inclusions(all) }));
  return drafted;
}

/** The first of an option's drafts that still exists (one may have been published or deleted since), or null: the draft the reader opens. */
export function draftToOpen(draftIds, drafts) {
  const known = new Map((drafts || []).map(draft => [draft.id, draft]));
  for (const id of draftIds || []) if (known.has(id)) return known.get(id);
  return null;
}

/** The sources an option covers, in reading order (for 为这几页出题): the pages of the entries, else the whole document. */
export function sourceIdsOf(ids, { sections = [], documentSourceIds = [] } = {}) {
  if (!ids) return [...documentSourceIds];
  const found = [...new Set(sections.filter(section => ids.has(section.id) && section.sourceId).map(section => section.sourceId))];
  return found.length ? found : [...documentSourceIds];
}
