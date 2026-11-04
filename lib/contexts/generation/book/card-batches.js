import { createHash } from 'node:crypto';
import { CARD_PASS } from './constants.js';

/* What the card pass (#710 S6) asks, decided by the program: the units of the book that have a written text, cover must items of their point's checklist and
   have no term cards yet (a book written before cards existed, or a write reply that gave none). A unit that has cards is never asked again, so an unchanged
   book costs no call. The units are put in batches in reading order, each one call, sized by CARD_PASS; within a batch the points are k1, k2 … and the
   items c1, c2 … (one alias one item, so a card may relate to an item of another point of the batch). Pure. */

const short = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/**
 * The units to card. `items`: the build's work items (book/work.js), each with its current checklist and its body as it will be saved; `point`: only that
 * point (filling the gaps of one point).
 * @returns [{ item, at (the unit's index in the body), title, path, part?, text, checklist: [{ id, kind, name, gist? }] }]
 */
export function cardEntries(items, { point = null } = {}) {
  const entries = [];
  for (const item of items) {
    const units = item.body?.units;
    if ((point && item.id !== point) || !Array.isArray(units)) continue;
    const musts = (item.checklist || []).filter(entry => entry.priority === 'must');
    units.forEach((unit, at) => {
      if (!unit.text || unit.cards?.length) return;
      const checklist = musts.filter(entry => unit.covered.includes(entry.id))
        .map(({ id, kind, name, gist }) => ({ id, kind, name, ...(gist ? { gist } : {}) }));
      const part = units.length > 1 ? { part: `${at + 1} of ${units.length}` } : {};
      if (checklist.length) entries.push({ item, at, title: item.title, path: item.path || [], ...part, text: unit.text, checklist });
    });
  }
  return entries;
}

/** The entries in batches of at most `budget` (CARD_PASS): [{ number, entries: [{ …entry, alias, checklist: [{ …item, alias }] }], checklist: [{ alias, id, name }], key }]. */
export function cardBatches(entries, budget = CARD_PASS) {
  const groups = [];
  let current = [], items = 0, chars = 0;
  for (const entry of entries) {
    const full = current.length >= budget.units || items + entry.checklist.length > budget.items || chars + entry.text.length > budget.chars;
    if (current.length && full) { groups.push(current); current = []; items = 0; chars = 0; }
    current.push(entry); items += entry.checklist.length; chars += entry.text.length;
  }
  if (current.length) groups.push(current);
  return groups.map((group, at) => {
    let n = 0;
    const own = group.map((entry, k) => ({ ...entry, alias: `k${k + 1}`, checklist: entry.checklist.map(item => ({ ...item, alias: `c${++n}` })) }));
    return { number: at + 1, entries: own, checklist: own.flatMap(entry => entry.checklist.map(({ alias, id, name }) => ({ alias, id, name }))),
      key: `cb:cards:${short(own.map(entry => [entry.item.id, entry.at, short(entry.text), entry.checklist.map(item => item.id)]))}` };
  });
}
