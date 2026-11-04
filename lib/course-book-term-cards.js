/* 术语卡 (term cards) of the review book (#710 S1): one card per checklist item a point's text explains, made in the same write call as the text. Stored on the
   unit it was written with, `units[].cards`: [{ item (inventory id), name (the book's language), alt? (the other language's name or an abbreviation), plain
   (one plain sentence), pitch (one exam-ready sentence), relations?: [{ kind: related | opposite | parallel | part, item?, name }] }]. A relation names its
   target always; `item` when the target is an item of the checklist. Never numbered here: the number (K001…) is given when the book is viewed
   (lib/course-book-card-numbers.js). Cards are optional: a body without them is as before. Pure, browser-safe. */

export const RELATION_KINDS = Object.freeze(['related', 'opposite', 'parallel', 'part']);

const line = (value, max) => { const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function relationsOf(raw, own, { limits, isItem }) {
  const seen = new Set(), out = [];
  for (const relation of (Array.isArray(raw) ? raw : []).filter(object)) {
    const item = isItem(relation.item) ? relation.item : null, name = line(relation.name, limits.termName);
    if (!RELATION_KINDS.includes(relation.kind) || !name || item === own || (relation.item !== undefined && !item)) continue;
    const key = `${relation.kind}\u0000${item ?? name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: relation.kind, ...(item ? { item } : {}), name });
  }
  return out.slice(0, limits.termRelations);
}

/**
 * The cards as kept: `isItem(id)` says which items may have a card (the checklist when a reply is read, any inventory id in a record); one card an item, the
 * first; a card needs a name and a plain or a pitch line; lengths capped by `limits` (NOTES_LIMITS). Never throws.
 */
export function normalizeTermCards(raw, { limits, isItem }) {
  const seen = new Set(), cards = [];
  for (const card of (Array.isArray(raw) ? raw : []).filter(object)) {
    if (cards.length >= limits.termCards) break;
    const { item } = card;
    if (!isItem(item) || seen.has(item)) continue;
    const name = line(card.name, limits.termName), plain = line(card.plain, limits.termPlain), pitch = line(card.pitch, limits.termPitch);
    if (!name || (!plain && !pitch)) continue;
    seen.add(item);
    const alt = line(card.alt, limits.termName), relations = relationsOf(card.relations, item, { limits, isItem });
    cards.push({ item, name, ...(alt && alt.toLowerCase() !== name.toLowerCase() ? { alt } : {}), ...(plain ? { plain } : {}), ...(pitch ? { pitch } : {}),
      ...(relations.length ? { relations } : {}) });
  }
  return cards;
}

/** The cards of a point's body in reading order (its units' in turn), one an item; a body of another form has none. */
export function leafCards(body) {
  const seen = new Set();
  return (Array.isArray(body?.units) ? body.units : []).flatMap(unit => unit.cards || []).filter(card => !seen.has(card.item) && seen.add(card.item));
}
