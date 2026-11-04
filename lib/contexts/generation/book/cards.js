import { NOTES_LIMITS } from '../../../course-book.js';
import { parseJson } from '../../../generation.js';
import { normalizeTermCards } from '../../../course-book-term-cards.js';

/* The term cards of a write or repair reply (#710 S1), read as the program reads cites: nothing is trusted. A card's `item` and a relation's `item` are checklist
   aliases (c1, c2 …) mapped back to inventory ids; an alias the checklist does not have is dropped (a relation to it with it); a relation to an item is
   named by the checklist; the shape and the lengths are lib/course-book-term-cards.js's. A missing or broken list is no cards, never a failed point. */

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const aliasOf = value => String(value ?? '').trim();

/** The reply's cards as stored (inventory ids). `unit`: the unit the reply is about ({ checklist: [{ alias, id, name }] }). */
export function readCards(raw, unit) {
  const byAlias = new Map(unit.checklist.map(item => [item.alias, item])), ids = new Set(unit.checklist.map(item => item.id));
  const relation = raw => {
    if (raw.item === undefined) return { kind: raw.kind, name: raw.name };
    const target = byAlias.get(aliasOf(raw.item));
    return target ? { kind: raw.kind, item: target.id, name: target.name } : { kind: raw.kind, item: null };
  };
  const cards = (Array.isArray(raw) ? raw : []).filter(object).map(card => ({ ...card, item: byAlias.get(aliasOf(card.item))?.id ?? null,
    relations: (Array.isArray(card.relations) ? card.relations : []).filter(object).map(relation) }));
  return normalizeTermCards(cards, { limits: NOTES_LIMITS, isItem: id => ids.has(id) });
}

/** The cards as a prompt shows them again (the review, the repair): by alias, never by inventory id. */
export function cardsByAlias(cards, unit) {
  const alias = new Map(unit.checklist.map(item => [item.id, item.alias]));
  return (cards || []).filter(card => alias.has(card.item)).map(({ item, relations, ...rest }) => ({ item: alias.get(item), ...rest,
    ...(relations?.length ? { relations: relations.map(({ kind, item: target, name }) => (alias.has(target) ? { kind, item: alias.get(target) } : { kind, name })) } : {}) }));
}

/** A card pass reply (#710 S6, book/card-batches.js): {"cards": [...]} -> each entry of the batch its cards (inventory ids), or null when the reply is not that
    shape (asked once more). A card goes to the entry whose checklist holds its item, then is read by `readCards` against the whole batch's checklist, so a
    relation may name an item of another point of the batch; an item no entry holds is no card. */
export function readCardPass(text, batch) {
  let value;
  try { value = parseJson(String(text)); } catch { return null; }
  if (!object(value) || !Array.isArray(value.cards)) return null;
  return batch.entries.map(entry => {
    const own = new Set(entry.checklist.map(item => item.alias));
    return readCards(value.cards.filter(card => object(card) && own.has(aliasOf(card.item))), batch);
  });
}
