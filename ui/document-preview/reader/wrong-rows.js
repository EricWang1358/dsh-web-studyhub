/* 错题 of the reader: which rows of the 错题与待巩固 page (call 'wrongbook', ui/wrongbook-model.js) are questions of this document, and where each leads.
   The page's own records are filtered, nothing is stored: a card belongs to the document when materials.pages.cards lists it (practice/useReadingLoop.js
   `cards`), and it belongs to the chapter that is drawn when the entry its passage is in is one of the drawn ones. Pure, no DOM. */
import { cardKey } from '../practice/practice-range.js';

const PAGE = 100, MAX_PAGES = 10;

/** The 待巩固 rows (view 'weak', every course, parked ones too) whose `deckId|cardId` is in `keys`, newest miss first as the page lists them. Stops once all are found or the list ends. */
export async function readWrongBook({ call, keys, pageSize = PAGE, maxPages = MAX_PAGES }) {
  const found = [], wanted = new Set(keys);
  for (let at = 0; at < maxPages && wanted.size; at += 1) {
    const answer = await call('wrongbook', { course: '*', includeInactive: true, view: 'weak', offset: at * pageSize, limit: pageSize });
    const items = answer?.items || [];
    for (const item of items) { const key = cardKey(item); if (wanted.delete(key)) found.push(item); }
    if (items.length < pageSize || (at + 1) * pageSize >= (answer?.total ?? 0)) break;
  }
  return found;
}

/**
 * The rows for one document: items (wrongbook's), cards (the document's linked questions), entryOf(key) (the outline entry a card's passage is in, or null),
 * drawn (the ids of the entries of the chapter that is drawn; null when the document is not read by chapters). -> { here, rest, total }: rows
 * { key, deckId, cardId, item, entryId }; `here` is the drawn chapter's (or all of them without chapters), `rest` the rest of the book.
 */
export function wrongRowsOf({ items = [], cards = [], entryOf = () => null, drawn = null }) {
  const known = new Set(cards.map(cardKey)), here = [], rest = [];
  for (const item of items) {
    const key = cardKey(item);
    if (!known.has(key)) continue;
    const entryId = entryOf(key) ?? null, row = { key, deckId: item.deckId, cardId: item.cardId, item, entryId };
    (!drawn || (entryId !== null && drawn.has(entryId)) ? here : rest).push(row);
  }
  return { here, rest, total: here.length + rest.length };
}
