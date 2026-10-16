/* 复习全书, which point comes before and after the one being read (docs/review-book.md "Where you are"). ONE rule for ← / →, the bar's ‹ › and a point's end
   button: on a point of today's list (the 期末一周 plan's day) they follow today's order, and after today's last point the book's order; on any other point
   the book's order. The bar says which order it is: 「今天 2/4」 or 「知识点 5/16」. Pure, no React, no DOM. */

/** steps: ui/book/reading.js bookSteps (未归位 last when it holds text); today: the heading ids of today's points in the plan's order ([] outside the 期末一周);
    at: the index of the step being read.
    -> { kind: 'today' | 'book', at (1-based; 0 on 未归位, which has no count), total, prev, next (step indexes, null at an end), last (today's last point) } */
export function routeOf(steps, today, at) {
  const step = steps[at] ?? null, counted = steps.filter(item => item.hid !== 'unplaced').length;
  const book = { prev: at > 0 ? at - 1 : null, next: at >= 0 && at < steps.length - 1 ? at + 1 : null };
  const order = (Array.isArray(today) ? today : []).map(id => steps.findIndex(item => item.hid === id)).filter(index => index >= 0);
  const k = step ? order.indexOf(at) : -1;
  if (k < 0) return { kind: 'book', at: step && step.hid !== 'unplaced' ? at + 1 : 0, total: counted, ...book, last: false };
  return { kind: 'today', at: k + 1, total: order.length, prev: k > 0 ? order[k - 1] : book.prev, next: k < order.length - 1 ? order[k + 1] : book.next, last: k === order.length - 1 };
}
