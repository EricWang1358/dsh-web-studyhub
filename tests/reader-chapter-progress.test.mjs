/* #1014, the pure parts: when a chapter counts as read, what the library calls it, which key turns the chapter, and the linked questions of the
   chapter on screen in the order of the text. The browser side is tests/reader-chapter-progress-browser.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterRefs, chapterStep, drainReads, outlineChapterMarks, queueRead, scrollProgress } from '../ui/document-preview/reader/chapter-reads.js';
import { chapterGroups, inReadingOrder } from '../ui/document-preview/links/link-scope.js';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

test('with a kept AI outline, the first entry inside each chapter carries that chapter\'s ✓ (gate review of #1021, 2)', () => {
  const chapters = [{ id: 'chapter-0', sourceIds: ['p1', 'p2', 'p3'] }, { id: 'chapter-1', sourceIds: ['p4', 'p5'] }, { id: 'chapter-2', sourceIds: ['p6'] }];
  const items = [{ id: 'ai-0', sourceId: 'p1' }, { id: 'ai-1', sourceId: 'p2' }, { id: 'ai-2' }, { id: 'ai-3', sourceId: 'p5' }, { id: 'ai-4', sourceId: 'p4' }, { id: 'ai-5', sourceId: 'p9' }];
  assert.deepEqual([...outlineChapterMarks(items, chapters)], [['ai-0', 'chapter-0'], ['ai-3', 'chapter-1']], 'one entry per chapter, the first listed; a chapter with no entry has none');
  // The automatic outline: its chapter rows are the chapters themselves.
  assert.deepEqual([...outlineChapterMarks([{ id: 'chapter-0', kind: 'chapter' }, { id: 'h-1', kind: 'page', sourceId: 'p1' }], chapters)], [['chapter-0', 'chapter-0']]);
  assert.equal(outlineChapterMarks(null, chapters).size, 0);
});

test('queued reads keep the chapter and material they were made under, also after the chapter list changed (gate review of #1021, 3)', () => {
  const r1 = { sourceId: 'p1', revision: 'r1' }, r2 = { sourceId: 'p1', revision: 'r2' };
  const before = [{ id: 'chapter-0', title: 'One', startPage: 1, endPage: 20 }, { id: 'chapter-1', title: 'Two', startPage: 21, endPage: 40 }];
  // An outline applied (or a new revision loaded): chapter-0 is now another range, chapter-1 is gone.
  const after = [{ id: 'chapter-0', title: 'Part A', startPage: 1, endPage: 10 }, { id: 'chapter-2', title: 'Part B', startPage: 11, endPage: 40 }];
  const queue = new Map();
  queueRead(queue, { target: r1, chapters: before, id: 'chapter-1', value: true });
  queueRead(queue, { target: r1, chapters: before, id: 'chapter-0', value: false });
  queueRead(queue, { target: r2, chapters: after, id: 'chapter-2', value: true });
  queueRead(queue, { target: r2, chapters: after, id: 'chapter-9', value: true }); // not a chapter of that list: nothing to keep
  const groups = drainReads(queue);
  assert.equal(queue.size, 0, 'drained');
  assert.deepEqual(groups.map(group => ({ target: group.target, chapters: group.chapters.map(chapter => chapter.id), read: group.read, unread: group.unread })), [
    { target: r1, chapters: ['chapter-0', 'chapter-1'], read: [before[1]], unread: [before[0]] },
    { target: r2, chapters: ['chapter-0', 'chapter-2'], read: [after[1]], unread: [] },
  ], 'each save names the chapter as it was when it was read, under its own material and revision');
  // A save that failed goes back in the queue, unless the learner changed the same chapter since.
  queueRead(queue, { target: r1, chapters: before, id: 'chapter-1', value: false });
  for (const entry of groups[0].entries) if (!queue.has(entry.key)) queue.set(entry.key, entry);
  assert.deepEqual(drainReads(queue).map(group => [group.read.map(chapter => chapter.id), group.unread]), [[[], [before[1], before[0]]]],
    'unread goes as the chapter as it was shown (re-review L1), not its id alone');
});

test('a chapter is read once scrolled 90% through; one that fits on the screen is seen whole', async () => {
  assert.equal(scrollProgress({ scrollTop: 899, clientHeight: 100, scrollHeight: 1100 }), 0.899);
  assert.equal(scrollProgress({ scrollTop: 900, clientHeight: 100, scrollHeight: 1100 }), 0.9);
  assert.equal(scrollProgress({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 }), 1);
  assert.equal(scrollProgress({ scrollTop: 5000, clientHeight: 100, scrollHeight: 1100 }), 1);
  assert.equal(scrollProgress({}), 1);

  const ui = await loadInteractiveUi(`
    export { useChapterReads } from './ui/document-preview/reader/useChapterReads.js';
  `);
  const makeTarget = (extra = {}) => {
    const listeners = new Map();
    return {
      ...extra,
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      emit(type, event = {}) {
        for (const fn of [...(listeners.get(type) || [])]) fn(event);
      },
    };
  };

  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  let rafSeq = 0;
  const rafQueue = new Map();
  globalThis.requestAnimationFrame = (cb) => {
    const id = ++rafSeq;
    rafQueue.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafQueue.delete(id);
  };
  const flushRaf = () => {
    const batch = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of batch) cb();
  };

  try {
    await withBrowserGlobals(async () => {
      const area = makeTarget({ scrollTop: 0, clientHeight: 100, scrollHeight: 1100 });
      const frame = makeTarget();
      const scroller = { current: area };
      const root = { current: frame };
      const target = { sourceId: 'p1', revision: 'r1' };
      const chapters = [
        { id: 'chapter-0', title: 'Intro', startPage: 1, endPage: 10 },
        { id: 'chapter-1', title: 'Body', startPage: 11, endPage: 20 },
      ];
      const saves = [];
      const call = async (method, payload) => {
        if (method === 'materials.reading.get') return { read: [] };
        if (method === 'materials.reading.save') {
          saves.push(payload);
          return { ok: true };
        }
        return {};
      };

      const hook = ui.mountHook(
        (props) => ui.exports.useChapterReads(props),
        { call, target, chapters, current: chapters[0], scroller, root, watching: true },
      );
      try {
        await hook.flush(4);
        assert.equal(hook.current.ready, true);
        assert.equal(hook.current.read.has('chapter-0'), false);

        // Without user input (touched === false), scrolling past 90% does not mark the chapter read.
        area.scrollTop = 950;
        await hook.act(() => {
          area.emit('scroll');
          flushRaf();
        });
        assert.equal(hook.current.read.has('chapter-0'), false, 'programmatic scroll without user input must not mark chapter read');

        // After user input (wheel), 0.899 (< 0.9) is still unread.
        area.scrollTop = 899;
        await hook.act(() => {
          frame.emit('wheel');
          flushRaf();
        });
        assert.equal(hook.current.read.has('chapter-0'), false, '0.899 progress must not mark chapter read');

        await hook.act(() => {
          area.emit('scroll');
          flushRaf();
        });
        assert.equal(hook.current.read.has('chapter-0'), false, 'scroll at 0.899 stays unread');

        // Reaching exact 0.900 (>= 0.9) after user input marks the chapter read immediately on screen, without saving yet.
        area.scrollTop = 900;
        await hook.act(() => {
          area.emit('scroll');
          flushRaf();
        });
        assert.equal(hook.current.read.has('chapter-0'), true, '0.900 progress after user input marks chapter read');
        assert.equal(hook.current.count, 1);
        assert.equal(saves.length, 0, 'reads are flushed on chapter change/unmount/hide, never while scrolling');

        // Unmounting flushes materials.reading.save with the read chapter ref.
        hook.unmount();
        assert.equal(saves.length, 1);
        assert.deepEqual(saves[0], {
          sourceId: 'p1',
          revision: 'r1',
          chapters,
          read: [chapters[0]],
          unread: [],
        });
      } finally {
        hook.unmount();
      }
    });
  } finally {
    if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = prevRaf;
    if (prevCancelRaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = prevCancelRaf;
  }
});

test('the library names a chapter by its id, title and pages only', () => {
  assert.deepEqual(chapterRefs([{ id: 'chapter-1', index: 1, title: 'Supply', startPage: 21, endPage: 40, sectionIds: ['a'], sourceIds: ['b'], block: false },
    { id: 'block-0', title: '', startPage: 1, endPage: 20 }]), [{ id: 'chapter-1', title: 'Supply', startPage: 21, endPage: 40 }, { id: 'block-0', title: '', startPage: 1, endPage: 20 }]);
});

test('[ and ] turn the chapter, never with a modifier or while typing', () => {
  const key = (key, extra = {}) => ({ key, code: '', target: { closest: () => null }, ...extra });
  assert.equal(chapterStep(key('[')), -1);
  assert.equal(chapterStep(key(']')), 1);
  assert.equal(chapterStep(key('Process', { code: 'BracketRight' })), 1, 'an input method that renames the key');
  assert.equal(chapterStep(key('{', { code: 'BracketLeft', shiftKey: true })), 0, 'Shift+[ is another key');
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(chapterStep(key(']', { [modifier]: true })), 0, modifier);
  assert.equal(chapterStep(key(']', { target: { closest: selector => (selector.includes('input') ? {} : null) } })), 0, 'typing in a field');
  assert.equal(chapterStep(key('p')), 0);
});

test('本章 keeps the passages of the chapter on screen, in the order of the text; 全书 keeps all of them in that order', () => {
  const group = (number, sourceId, start) => ({ number, selection: { sourceId, start } });
  const groups = [group(1, 'p3', 40), group(2, 'p1', 90), group(3, 'p3', 5), group(4, 'p9', 0), group(5, 'p1', 10)];
  const order = new Map([['p1', 0], ['p3', 2], ['p9', 8]]);
  assert.deepEqual(chapterGroups(groups, { sourceIds: new Set(['p1', 'p3']), order }).map(item => item.number), [5, 2, 3, 1]);
  assert.deepEqual(inReadingOrder(groups, order).map(item => item.number), [5, 2, 3, 1, 4]);
  assert.deepEqual(chapterGroups(groups, { order }).map(item => item.number), [5, 2, 3, 1, 4], 'no chapters: everything');
  assert.deepEqual(chapterGroups([group(1, 'x', undefined), group(2, 'p1', 3)], { order }).map(item => item.number), [2, 1], 'an unknown place goes last');
});
