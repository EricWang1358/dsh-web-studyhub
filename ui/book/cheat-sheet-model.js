import { termIndexes } from '../../lib/course-book-card-index.js';
import { codeOf } from '../../lib/course-book-lookup.js';

/* The data of the review book's 速查表 (#710 S5), made by the program from the book as the page has it (course.book.open's answer): no call, nothing stored.
   One dense page for an open-book exam: the answer templates and the signal matrix (S4), the comparisons of easily confused concepts (S3), the formulas
   and the numbered term cards by chapter (S1/S2), each pointing back to the point of the book that teaches it. The view, the print and the exported .html
   are all drawn from this one answer (ui/book/cheat-sheet-html.js). Pure, no React.

   cheatSheet(book) -> null | { language, title, chapters, kit, confusables, formulas, counts }
     place:       { hid, code (H12), number, title } a point of the book. A chapter whose points are all `unbuilt` (course.book.open's mark of 未生成) is left out of every part.
     chapters:    [{ hid, number, title, cards: [{ code, name, alt?, plain?, pitch?, relations: [{ kind, name, code? }], place, page?, material? }] }], only chapters with cards.
     kit:         null | { types: [{ code, name, signals, asks, template, fills: [{ ref, fill }], anchors, places }] } (book.examKit, its points named as places).
     confusables: [{ id, names, items: [code], rows: [{ aspect, cells }] }] from book.confusables, which is read here, where it enters: a pair or a row
                  that does not hold the shape below is left out, never the sheet refused. Shape: [{ id, items: [K codes], names: [..], rows: [{ aspect:
                  'what' | 'when' | 'difference' | 'mistake', cells: [one text per name] }] }].
     formulas:    [{ term, gist, code?, place, page?, material? }] the glossary's formulas in reading order (lib/course-book-card-index.js).
     counts:      { cards, types, confusables, formulas }. */

export const ASPECTS = Object.freeze(['what', 'when', 'difference', 'mistake']);
/** The most pairs read from a book. */
const MAX_PAIRS = 400;

const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));
const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const list = value => (Array.isArray(value) ? value : []);

/** The comparisons as the sheet draws them: each cell a text, as many cells as names; a pair with no usable row is left out. */
export function readConfusables(raw) {
  const seen = new Set();
  return list(raw).slice(0, MAX_PAIRS).flatMap(pair => {
    const id = text(pair?.id), names = list(pair?.names).map(text), items = list(pair?.items).map(text);
    if (!id || seen.has(id) || names.length < 2 || names.some(name => !name) || items.some(code => !code)) return [];
    const rows = list(pair.rows).flatMap(row => {
      const cells = list(row?.cells).map(text);
      return ASPECTS.includes(row?.aspect) && cells.length === names.length && cells.some(Boolean) ? [{ aspect: row.aspect, cells }] : [];
    });
    if (!rows.length) return [];
    seen.add(id);
    return [{ id, names, items, rows }];
  });
}

/** The 速查表 of an open book (see the top of this file); null when the book is not open or has nothing to put on it. */
export function cheatSheet(book) {
  if (book?.status !== 'ok') return null;
  const language = ['en', 'zh'].includes(book.language) ? book.language : 'zh';
  // A chapter not built yet (未生成, #708: none of its points has an explanation) is not on the sheet: its points are no place of a template or a formula.
  const built = (book.nodes || []).filter(node => !leavesOf([node]).every(leaf => leaf.unbuilt));
  const places = new Map(leavesOf(built).map(leaf => [leaf.hid, { hid: leaf.hid, code: codeOf(leaf.hid), number: leaf.number ?? '', title: leaf.title ?? '' }]));
  const glossary = list(book.glossary), byItem = new Map(glossary.filter(entry => entry.item).map(entry => [entry.item, entry]));
  const chapters = built.map(node => ({ hid: node.hid, number: node.number ?? '', title: node.title ?? '',
    cards: (node.leaf ? [node] : leavesOf(node.children)).flatMap(leaf => (leaf.cards || []).map(card => {
      const entry = byItem.get(card.item);
      return { code: card.code, name: card.name, ...(card.alt ? { alt: card.alt } : {}), ...(card.plain ? { plain: card.plain } : {}), ...(card.pitch ? { pitch: card.pitch } : {}),
        relations: (card.relations || []).filter(relation => relation.name).map(relation => ({ kind: relation.kind, name: relation.name, ...(relation.code ? { code: relation.code } : {}) })),
        place: places.get(leaf.hid), ...(Number.isInteger(entry?.page) ? { page: entry.page } : {}), ...(entry?.material ? { material: entry.material } : {}) };
    })) })).filter(chapter => chapter.cards.length);
  const kit = book.examKit?.types?.length ? { types: book.examKit.types.map(type => ({ code: type.code, name: type.name, signals: type.signals || [], asks: type.asks || '',
    template: type.template, fills: type.fills || [], anchors: type.anchors || [], places: (type.hids || []).filter(hid => places.has(hid)).map(hid => places.get(hid)) })) } : null;
  const formulas = termIndexes({ nodes: book.nodes, glossary, language }).formulas.filter(entry => places.has(entry.hid)).map(entry => ({ term: entry.term, gist: entry.gist ?? '',
    ...(entry.code ? { code: entry.code } : {}), place: places.get(entry.hid), ...(Number.isInteger(entry.page) ? { page: entry.page } : {}), ...(entry.material ? { material: entry.material } : {}) }));
  const confusables = readConfusables(book.confusables);
  const counts = { cards: chapters.reduce((sum, chapter) => sum + chapter.cards.length, 0), types: kit?.types.length ?? 0, confusables: confusables.length, formulas: formulas.length };
  if (!counts.cards && !counts.types && !counts.confusables && !counts.formulas) return null;
  return { language, title: book.title ?? '', chapters, kit, confusables, formulas, counts };
}
