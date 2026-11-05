import { planParts } from '../../lib/contexts/generation/book/plan-parts.js';

/* The parts of the 复习全书 a course's 定制方案 asks for (深度定制 S2), as the book page offers them. Which parts a plan makes is decided once, in
   lib/contexts/generation/book/plan-parts.js planParts (no plan, or a plan that makes no book: every part); here only the views the program makes with no call:
     formulas    the formula page of the 速查页
     index       the A–Z (生词与概念) and the 术语卡 by chapter of the 速查页
     cheatSheet  更多 › 速查表 and its download in 导出…
   A part left out is not offered (the book keeps what it has); ticked again in 「你的定制」, it is there on the next render, no build needed. Pure. */

/** The parts the page offers: null (every part) or the Set of the plan's parts. `course`: the course record (its `custom`). */
export const bookParts = course => planParts(course?.custom ?? null);

/** Does the page offer this part? */
export const showsPart = (parts, id) => !parts || parts.has(id);

/** The 速查页 (lib/course-book-lookup.js bookLookup's answer) without the parts the plan leaves out; the same object when it leaves none out. */
export function plannedLookup(lookup, parts) {
  if (!lookup || (showsPart(parts, 'formulas') && showsPart(parts, 'index'))) return lookup;
  return { ...lookup, ...(showsPart(parts, 'formulas') ? {} : { formulas: [] }), ...(showsPart(parts, 'index') ? {} : { glossary: [], cardChapters: [] }) };
}
