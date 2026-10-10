/* 翻看 (docs/plans/review-book.md M7): the 易错点 of each point of the review book, what the learner once did not understand, read from the book as it is
   now (never stored). Pure, browser-safe: the page's 翻看 view and the plan (lib/course-book-crunch.js, which counts them) read the same list.

   pointMistakes(book) -> Map<hid, [{ kind: 'asked' | 'pitfall' | 'explained', text, deckId?, cardId? }]>
     asked:     a follow-up put into the book (「加入复习全书」, the sh:qa blocks of any of the point's files: the question that was asked);
     pitfall:   an answer card's 易错检查 (the cards of the point's questions, course.book.open's `answerCards`);
     explained: a 弄懂 block of the point's own file (lib/course-book-ai-text.js, mode explain or follow): the words that were explained, or the follow-up.
   The first two are the 查找页's 易错点 (lib/course-book-lookup.js), in its words and order; a point without any has no entry. */
import { bookLookup } from './course-book-lookup.js';
import { aiBlocks } from './course-book-ai-text.js';

const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => { const value = squash(text); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));

export function pointMistakes(book) {
  const out = new Map();
  if (book?.status !== 'ok') return out;
  const lookup = bookLookup(book, { caseTypes: [], answerCards: book.answerCards || [] });
  for (const place of lookup?.mistakes || []) if (place.hid !== 'unplaced') out.set(place.hid, place.items.map(item => ({ ...item })));
  for (const leaf of leavesOf(book.nodes)) {
    const explained = aiBlocks(leaf.mine).filter(block => block.mode === 'explain' || block.mode === 'follow')
      .map(block => ({ kind: 'explained', text: clip(block.mode === 'follow' && block.ask ? block.ask : block.about, 200) })).filter(item => item.text);
    if (!explained.length) continue;
    const items = out.get(leaf.hid) || [], seen = new Set(items.map(item => `${item.kind}\u0000${item.text}`));
    for (const item of explained) if (!seen.has(`${item.kind}\u0000${item.text}`)) { seen.add(`${item.kind}\u0000${item.text}`); items.push(item); }
    out.set(leaf.hid, items);
  }
  return out;
}
