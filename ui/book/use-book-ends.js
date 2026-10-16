import React, { useCallback, useMemo } from 'react';
import PointEnd from './PointEnd.jsx';
import { endState } from './point-end.js';
import { routeOf } from './route.js';
import { tocMarks } from './toc-marks.js';
import { pointMistakes } from '../../lib/book-flip.js';

/* 复习全书, where the learner is and where a point leads (docs/review-book.md "Where you are"): the one order of ← / →, ‹ › and the end buttons (ui/book/route.js),
   each point's end button (ui/book/PointEnd.jsx) and what the 目录 marks (今天 and its rows, 读完 of the book, the mark of every row). */

const titleOf = step => (step ? [step.node.number, step.node.title].filter(Boolean).join(' ') : '');

/** steps, toc (ui/book/model.js tocEntries), book, plan (ui/book/use-book-actions.js useBookCrunch), where (ui/book/use-book-place.js), handlers (练 5 道),
    openMock() (出一套模拟卷…).
    -> { route, endOf(node), step(delta), today: { entries, count, done, flip } | null, marks, read, points } */
export function useBookEnds({ steps, toc, book, plan, where, handlers, openMock }) {
  const todayIds = plan.today?.ids;
  const route = useMemo(() => routeOf(steps, todayIds, where.current), [steps, todayIds, where.current]);
  const { mark, ready, read, seen } = plan, flip = !!plan.today?.flip, goIndex = where.goIndex, practice = handlers.practice;
  // ← → and ‹ ›: by the page's one order.
  const step = useCallback(delta => { const index = delta > 0 ? route.next : route.prev; if (index !== null) goIndex(index); }, [route, goIndex]);
  const endOf = useCallback(node => {
    const index = steps.findIndex(item => item.hid === node.hid);
    if (index < 0 || node.hid === 'unplaced') return null;
    const own = routeOf(steps, todayIds, index);
    const state = endState({ ready, flip, done: read.has(node.hid), seen: seen.has(node.hid), questions: node.questionTotal > 0, lastToday: own.kind === 'today' && own.last,
      hasNext: own.next !== null });
    const onAct = async (id, element) => {
      if (id === 'practice') { await practice(node.hid, 5, node.hid, element); return; }
      if (id === 'mock') { openMock(); return; }
      if (id !== 'next' && !(await mark(node.hid, id === 'seen' ? 'seen' : 'read', true))) return;
      if (own.next !== null) goIndex(own.next);
    };
    return React.createElement(PointEnd, { key: node.hid, state, next: titleOf(steps[own.next]), bridge: node.bridge?.out || '', onAct });
  }, [steps, todayIds, ready, flip, read, seen, mark, practice, goIndex, openMock]);
  // The 目录: today's rows in the plan's order (flat), and the mark of every row.
  const mistakes = useMemo(() => (book?.status === 'ok' ? pointMistakes(book) : new Map()), [book]);
  const marks = useMemo(() => tocMarks(book, mistakes, read), [book, mistakes, read]);
  const today = useMemo(() => {
    if (!plan.today) return null;
    const byId = new Map(toc.map(entry => [entry.id, entry]));
    return { ...plan.today, entries: plan.today.ids.map(id => byId.get(id)).filter(Boolean).map(entry => ({ ...entry, level: 2 })) };
  }, [plan.today, toc]);
  const points = steps.filter(item => item.hid !== 'unplaced').length;
  return { route, endOf, step, today, marks, read: steps.filter(item => read.has(item.hid)).length, points };
}
