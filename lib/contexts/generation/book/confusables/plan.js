import { withCardNumbers } from '../../../../course-book-card-numbers.js';
import { CONFUSABLE_LIMITS, confusablePairs, pairKey } from '../../../../course-book-confusables.js';
import { leafCards } from '../../../../course-book-term-cards.js';
import { CONFUSABLE_PAIRS, CONFUSABLE_VERSION } from '../constants.js';
import { short16 } from '../sources.js';

/* What the confusable pairs of one build have to do, decided by the program before any call (#710 S3). The pairs are those of the cards the points now hold
   (lib/course-book-confusables.js confusablePairs, on the cards numbered as the book will show them), at most CONFUSABLE_LIMITS.pairs, in book order. Each pair
   has a `print`: both cards' words and the book's language. A saved comparison with the same print is kept, no call; every other pair is asked, CONFUSABLE_PAIRS
   to a call, a call standing where its first pair does. Pure. */

const wordsOf = card => [card.name, card.alt ?? '', card.plain ?? '', card.pitch ?? ''];

/**
 * @param items the build's work items (book/work.js), each with its body as it will be saved; `previous`: the saved comparisons (courseNotes.confusables)
 * @returns { pairs: [{ key, kind, items: [item, item], a, b, print }] (a, b: the numbered cards), kept: Map(key -> saved comparison),
 *   batches: [{ number, key, pairs: [{ …pair, alias }] }] }
 */
export function planConfusables(items, { language, previous = [] } = {}) {
  const nodes = withCardNumbers((items || []).map(item => ({ hid: item.id, leaf: true, children: [], cards: leafCards(item.body) })));
  const book = language === 'en' ? 'en' : 'zh', saved = new Map((previous || []).map(entry => [pairKey(entry.items[0], entry.items[1]), entry]));
  const pairs = confusablePairs(nodes).slice(0, CONFUSABLE_LIMITS.pairs).map(({ key, kind, a, b }) => ({ key, kind, items: [a.item, b.item], a, b,
    print: short16(['confusable', CONFUSABLE_VERSION, book, wordsOf(a), wordsOf(b)]) }));
  const kept = new Map(pairs.filter(pair => saved.get(pair.key)?.print === pair.print).map(pair => [pair.key, saved.get(pair.key)]));
  const asked = pairs.filter(pair => !kept.has(pair.key)), batches = [];
  for (let at = 0; at < asked.length; at += CONFUSABLE_PAIRS) {
    const group = asked.slice(at, at + CONFUSABLE_PAIRS);
    batches.push({ number: batches.length + 1, key: `cb:confusables:${short16(group.map(pair => pair.print))}`,
      pairs: group.map((pair, k) => ({ ...pair, alias: `p${k + 1}` })) });
  }
  return { pairs, kept, batches };
}

/** The comparisons to save: for every pair of the plan the saved one that was kept, else the rows just written (`written`: Map(key -> rows)); a pair with neither is left out. */
export function assembleConfusables(plan, written) {
  return plan.pairs.flatMap(pair => {
    const rows = plan.kept.get(pair.key)?.rows ?? written.get(pair.key);
    return rows ? [{ items: pair.items, print: pair.print, rows }] : [];
  });
}
