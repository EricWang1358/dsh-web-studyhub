/* The reader's right-click menu, its strokes and the 待出题 list as plain data (ui/document-preview/marks/model.js): what the menu offers over a
   selection, which marks are drawn and how, and the ONE ordinary question run a list of waiting passages becomes. No DOM, no model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const { batchFocus, batchRequest, drawnMarks, explainQuestion, marksAt, MARK_HIGHLIGHTS, paintMarks, queueOf, selectionMenu, annotationLinks, setUiLanguage } = await loadUi(
  `export * from './ui/document-preview/marks/model.js'; export { annotationLinks } from './ui/document-preview/annotation/model.js'; export { setUiLanguage } from './ui/i18n.js';`);
setUiLanguage('zh');

const mark = (style, quote, start, extra = {}) => ({ id: `${style}|s1|${start}`, key: `s1|${start}|${start + quote.length}`, style, status: 'resolved',
  selection: { sourceId: extra.sourceId || 's1', start, end: start + quote.length, quote, prefix: '', suffix: '' }, ...extra });

test('the menu offers copy first, each stroke or its 去掉, the 待出题 toggle and AI 词解', () => {
  const ids = items => items.map(item => item.id);
  assert.deepEqual(ids(selectionMenu()), ['copy', 'mark:underline', 'mark:bold', 'mark:highlight', 'mark:queue', 'explain']);
  const here = [mark('underline', 'latency and availability', 10), mark('queue', 'latency and availability', 10)];
  assert.deepEqual(ids(selectionMenu({ here })), ['copy', 'unmark:underline', 'mark:bold', 'mark:highlight', 'unmark:queue', 'explain', 'unmark:all']);
  const full = selectionMenu({ queueFull: true }).find(item => item.id === 'mark:queue');
  assert.equal(full.disabled, true); assert.ok(full.tip);
  assert.ok(!ids(selectionMenu({ explain: 'unavailable' })).includes('explain'), 'no 词解 where the reader cannot ask');
  assert.match(selectionMenu({ explain: 'no-model' }).find(item => item.id === 'explain').tip, /模型/);
  assert.ok(selectionMenu({ canMark: false }).filter(item => item.id !== 'copy').every(item => item.disabled), 'only copy works where nothing can be kept');
});

test('a selection inside a marked passage finds that mark; a different passage does not', () => {
  const items = [mark('bold', 'latency and availability', 10), mark('underline', 'read model', 80)];
  assert.deepEqual(marksAt(items, { sourceId: 's1', quote: 'and avail', start: 18, end: 27 }).map(item => item.style), ['bold']);
  assert.deepEqual(marksAt(items, { sourceId: 's1', quote: 'read model' }).map(item => item.style), ['underline'], 'without offsets the words decide');
  assert.deepEqual(marksAt(items, { sourceId: 's2', quote: 'read model' }), []);
  assert.deepEqual(marksAt(items, null), []);
});

test('resolved strokes and waiting passages are drawn, stale ones are not; a pending 词解 is drawn while it is written', () => {
  const items = [mark('underline', 'a', 1), mark('queue', 'b', 5), mark('bold', 'c', 9, { status: 'stale' })];
  const drawn = drawnMarks(items, [{ selection: { sourceId: 's1', quote: 'd', start: 12, end: 13 } }]);
  assert.deepEqual(drawn.map(item => item.style), ['underline', 'queue', 'pending']);
  assert.deepEqual(queueOf(items).map(item => item.selection.quote), ['b']);
});

test('marks are painted by style into their own highlights, cleared together, and nothing breaks without the API', () => {
  const registry = new Map();
  class Highlight { constructor(...ranges) { this.ranges = ranges; } }
  const clear = paintMarks([{ group: { style: 'underline' }, range: 'r1' }, { group: { style: 'underline' }, range: 'r2' }, { group: { style: 'highlight' }, range: 'r3' }], { registry, Highlight });
  assert.deepEqual(registry.get(MARK_HIGHLIGHTS.underline).ranges, ['r1', 'r2']);
  assert.deepEqual(registry.get(MARK_HIGHLIGHTS.highlight).ranges, ['r3']);
  assert.ok(registry.get(MARK_HIGHLIGHTS.underline).priority > registry.get(MARK_HIGHLIGHTS.highlight).priority, 'a stroke shows over a highlighter');
  assert.ok(!registry.has(MARK_HIGHLIGHTS.bold));
  clear();
  assert.equal(registry.size, 0);
  assert.doesNotThrow(() => paintMarks([{ group: { style: 'bold' }, range: 'r' }], { registry: null, Highlight: null })());
});

test('一次性出题 is one ordinary run: the passages\' sources only, a focus naming each passage, a count per passage, no going on by itself', () => {
  const queue = [mark('queue', 'latency and availability', 10), mark('queue', 'read model', 80, { sourceId: 's2' }), mark('queue', 'write model', 120, { sourceId: 's2' })];
  const request = batchRequest({ queue, perPassage: 2, settings: { generation: { kinds: ['quiz'], difficulty: 'mixed' } }, title: 'Notes', course: 'SWE' });
  assert.deepEqual(request.sourceIds, ['s1', 's2']);
  assert.equal(request.count, 6);
  assert.equal(request.autoComplete, false);
  assert.equal(request.course, 'SWE');
  assert.match(request.title, /Notes · 待出题 3 段/);
  assert.match(request.focus, /3 段原文/); assert.match(request.focus, /每段约 2 题/);
  assert.match(request.focus, /1\. 「latency and availability」/); assert.match(request.focus, /3\. 「write model」/);
  assert.ok(!('customCount' in request), 'the typed count goes out as count, as the 出题 page sends it');
  assert.equal(batchRequest({ queue: queue.slice(0, 1) }).count, 1, 'one question per passage by default');
  assert.ok(!('course' in batchRequest({ queue })), 'no course: the backend files the run under the material’s own course, never 未分类');
  assert.match(batchFocus([mark('queue', 'x'.repeat(900), 0)]), /…」/, 'a long passage is clipped in the focus');
});

test('a 词解 asks in plain words about the selected term, and its kept answer is marked as one', () => {
  assert.match(explainQuestion('CQRS'), /通俗、具体.*「CQRS」/);
  const links = annotationLinks([{ id: 'e1', key: 's1|0|4', parentId: null, question: 'q', answer: 'Reads and writes use different models.', kind: 'explain', status: 'resolved',
    selection: { sourceId: 's1', start: 0, end: 4, quote: 'CQRS' } }]);
  assert.equal(links[0].explain, true);
  assert.equal(links[0].answer, 'Reads and writes use different models.');
});
