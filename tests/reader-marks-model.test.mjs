/* The reader's right-click menu, its strokes and the 待出题 list as plain data (ui/document-preview/marks/model.js): what the menu offers over a
   selection, which marks are drawn and how, and the ONE ordinary question run a list of waiting passages becomes. No DOM, no model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadUi } from './helpers/ui-module.mjs';

const { batchFocus, batchRequest, drawnMarks, explainQuestion, formatCitedQuote, marksAt, MARK_HIGHLIGHTS, overlappingQueueIndex, paintMarks, queueOf, selectionMenu, selectionStatsText, annotationLinks, setUiLanguage } = await loadUi(
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

test('#15 overlappingQueueIndex flags high span overlap (>=70%) or included long quotes on the same source', () => {
  const queue = [
    mark('queue', 'alpha beta gamma delta', 100),
    mark('queue', 'spaced repetition improves memory retention over weeks', 200, { sourceId: 's2' }),
  ];
  assert.equal(overlappingQueueIndex([], { sourceId: 's1', quote: 'anything', start: 0, end: 8 }), -1);
  assert.equal(overlappingQueueIndex(queue, { sourceId: 's1', quote: '' }), -1);
  assert.equal(overlappingQueueIndex(queue, { sourceId: 's1', quote: 'beta gamma', start: 106, end: 116 }), 0, 'shorter span 100% covered');
  assert.equal(overlappingQueueIndex(queue, { sourceId: 's1', quote: 'partial', start: 118, end: 138 }), -1, '4/20 = 20% < 70%');
  assert.equal(overlappingQueueIndex(queue, { sourceId: 's2', quote: 'alpha beta gamma delta', start: 100, end: 122 }), -1, 'different sourceId is not a duplicate');
  assert.equal(overlappingQueueIndex(queue, { sourceId: 's2', quote: 'spaced repetition improves' }), 1, 'normalized inclusion >= 12 chars without spans');
  assert.equal(overlappingQueueIndex(queue, { sourceId: 's2', quote: 'short' }), -1, '< 12 chars without overlapping span does not warn');
});

test('#58 & #11 selectionMenu adds copy-cite with stats and question-note when allowed, and formats cited quotes', () => {
  assert.equal(formatCitedQuote({ quote: 'Read models differ.', title: 'DDIA', page: 12 }), 'Read models differ.\n\n——《DDIA》第 12 页');
  assert.equal(formatCitedQuote({ quote: 'Slide point', title: 'CS101', page: 3, slides: true }), 'Slide point\n\n——《CS101》第 3 张');
  assert.equal(formatCitedQuote({ quote: 'Plain quote' }), 'Plain quote');
  assert.equal(formatCitedQuote({ quote: '   ' }), '');

  assert.equal(selectionStatsText('Read model separation'), '3 词 · 19 字符');
  assert.equal(selectionStatsText('读写分离模型'), '6 字');

  const withQuote = selectionMenu({ quote: 'Read model separation', canQuestionNote: true });
  assert.equal(withQuote[0].id, 'copy');
  assert.deepEqual(withQuote[1], { id: 'copy-cite', label: '带出处复制', icon: 'copy', hint: '3 词 · 19 字符' });
  assert.deepEqual(withQuote[2], { id: 'question-note', label: '记入本题笔记', icon: 'note' });
  assert.ok(!selectionMenu({ quote: 'abc', canQuestionNote: false }).some(item => item.id === 'question-note'));

  const enFragment = JSON.parse(readFileSync(new URL('../ui/locales/en.polish-reader.json', import.meta.url), 'utf8'));
  assert.equal(enFragment['{0} 词 · {1} 字符'], '{0} words · {1} chars');
  assert.equal(enFragment['带出处复制'], 'Copy with citation');
  assert.equal(enFragment['记入本题笔记'], 'Add to question note');
});
