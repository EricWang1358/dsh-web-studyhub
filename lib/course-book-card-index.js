/* The indexes of the review book's 术语卡 (#710 S2), made by the program from the book as viewed (no call): the glossary's A–Z with each card's code and each
   card's other name or abbreviation as a second entry pointing to the same card; the cards by chapter; and the formula page, every formula item the book
   covers with its point and page, in reading order. The lookup page shows them (lib/course-book-lookup.js). Pure, browser-safe. */

/** The order of terms in the book's language: the glossary's and the indexes' one order. */
export const termOrder = language => new Intl.Collator(language === 'en' ? 'en' : 'zh-Hans-CN', { sensitivity: 'base', numeric: true });

const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));

/**
 * @param nodes the book's nodes with numbered cards (lib/course-book-card-numbers.js); `glossary` [{ term, item?, gist, kind, hid, material, page? }].
 * @returns { glossary: the A–Z [{ …entry, code? } | { term (an other name), see (the card's name), code, hid }], chapters: [{ hid, number, title, cards: [{ code, name, hid }] }],
 *            formulas: [{ …glossary entry, code? }] }
 */
export function termIndexes({ nodes, glossary = [], language }) {
  const cards = leavesOf(nodes).flatMap(leaf => leaf.cards || []), byItem = new Map(cards.map(card => [card.item, card]));
  const order = new Map(leavesOf(nodes).map((leaf, at) => [leaf.hid, at])), compare = termOrder(language).compare;
  const coded = entry => { const card = entry.item && byItem.get(entry.item); return card ? { ...entry, code: card.code } : entry; };
  const listed = new Set(glossary.map(entry => entry.item).filter(Boolean));
  const own = cards.filter(card => !listed.has(card.item)).map(card => ({ term: card.name, item: card.item, gist: card.plain ?? '', kind: '', hid: card.hid, code: card.code }));
  const others = cards.filter(card => card.alt).map(card => ({ term: card.alt, see: card.name, hid: card.hid, code: card.code }));
  const all = [...glossary.map(coded), ...own, ...others].sort((a, b) => compare(a.term, b.term) || (a.see ? 1 : 0) - (b.see ? 1 : 0));
  const chapters = (nodes || []).map(node => ({ hid: node.hid, number: node.number ?? '', title: node.title,
    cards: (node.leaf ? [node] : leavesOf(node.children)).flatMap(leaf => leaf.cards || []).map(card => ({ code: card.code, name: card.name, hid: card.hid })) }))
    .filter(chapter => chapter.cards.length);
  const formulas = glossary.filter(entry => entry.kind === 'formula').map(coded)
    .sort((a, b) => (order.get(a.hid) ?? Infinity) - (order.get(b.hid) ?? Infinity) || compare(a.term, b.term));
  return { glossary: all, chapters, formulas };
}
