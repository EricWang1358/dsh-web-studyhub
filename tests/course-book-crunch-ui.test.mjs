/* 期末一周 on the page (static zh and en, docs/plans/review-book.md M7): a day of the plan says what kind of day it is and why, lists its points with
   去读 / 练 5 道 / 读完了 (learn) or 翻看 (a 翻看 day), 翻看全书 and the mock paper; 翻看 lists every point in the plan's order with its 易错点 open and its
   讲解 folded (not drawn), 已看 and the progress; every reason code has a line in both languages. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { exportBook } from './helpers/course-book-export-book.mjs';

const ui = await loadUi(`
  export { default as CrunchDay } from './ui/book/CrunchDay.jsx';
  export { default as BookFlip } from './ui/book/BookFlip.jsx';
  export { default as CrunchCard } from './ui/book/CrunchCard.jsx';
  export { default as MockPaper } from './ui/book/MockPaper.jsx';
  export { reasonText, leftOutText, dayKind } from './ui/book/crunch-words.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {};
const services = { call: () => new Promise(() => {}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const han = /[㐀-鿿]/;

const POINTS = [{ id: 'h2', key: 'bk:a', code: 'H2', title: 'Availability', questions: 12, tested: 2, weak: 3, pitfalls: 2 },
  { id: 'h3', key: 'bk:p', code: 'H3', title: 'Performance', questions: 0, tested: 0, weak: 0, pitfalls: 0 }];
const LEARN = { date: '2026-10-11', offset: 0, mode: 'learn', mock: false, points: ['h2', 'h3'], done: ['h2'], minutes: 40, reason: { code: 'learn', count: 2, tested: 1, weak: 1, minutes: 40 } };
const FLIP = { date: '2026-10-17', offset: 0, mode: 'flip', mock: true, points: ['h2', 'h3'], done: [], minutes: 9, reason: { code: 'flip-mock', count: 2, pitfalls: 2 } };

test('a learn day: what it is, why, its points with 去读 and 练 5 道, 读完了 for a point without questions, the mock paper', () => {
  const html = render(h(ui.CrunchDay, { course: 'SA', daysLeft: 7, day: LEARN, points: POINTS, onRead: noop, onPractice: noop, onMarkRead: noop, onMockStarted: noop }));
  const text = textOf(html);
  for (const part of ['学习日', '距考试 7 天', '先学考得多又薄弱的 2 节（1 节样卷考过）：每节读完练 5 道，约 40 分钟。', 'H2 Availability', '12 道题 · 样卷考过 2 份 · 3 题薄弱 · 2 条易错点',
    '只读，没有题', '去读', '练 5 道', '读完了', '已完成', '用这些知识点出一套模拟卷']) assert.ok(text.includes(part), part);
  assert.equal((html.match(/>练 5 道</g) || []).length, 1, '练 5 道 only for the point with questions');
  assert.doesNotMatch(text, /翻看全书/, 'a learn day has no 翻看全书');
  english(() => {
    const en = textOf(render(h(ui.CrunchDay, { course: 'SA', daysLeft: 7, day: LEARN, points: POINTS, onRead: noop, onPractice: noop, onMarkRead: noop })));
    for (const part of ['Study day', 'Exam in 7 days', 'Read', 'Practise 5', 'Read it', 'Make a mock paper from these points', 'Tested in 2 sample papers']) assert.ok(en.includes(part), part);
    assert.ok(!han.test(en.replace(/Availability|Performance/g, '')), en);
  });
});

test('the last 翻看 day: 翻看 for each point, 翻看全书, the mock paper; at most `max` points, then 还有 N 节', () => {
  const text = textOf(render(h(ui.CrunchDay, { course: 'SA', daysLeft: 1, day: FLIP, points: POINTS, max: 1, onRead: noop, onFlip: noop, onMore: noop })));
  for (const part of ['翻看日 · 模拟卷', '距考试 1 天', '考前最后一天：翻看剩下的 2 节，再做一套模拟卷。', '翻看', '翻看全书', '还有 1 节', '用这些知识点出一套模拟卷']) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /练 5 道|Performance/);
  english(() => assert.ok(textOf(render(h(ui.CrunchDay, { course: 'SA', daysLeft: 0, day: FLIP, points: POINTS, onFlip: noop }))).includes('Look over the book')));
});

test('every reason code has a line in both languages; what a mock paper leaves out is named by kind', () => {
  const reasons = [{ code: 'learn', count: 3, tested: 1, minutes: 50 }, { code: 'learn-size', count: 3, minutes: 50 }, { code: 'learn-over', count: 9, minutes: 300, capacity: 180 },
    { code: 'learn-free' }, { code: 'flip', count: 4, pitfalls: 6 }, { code: 'flip-mock', count: 4 }, { code: 'exam-today', count: 8 }, { code: 'off' }, { code: 'done', count: 2 }];
  for (const reason of reasons) {
    assert.ok(ui.reasonText(reason).length > 4, reason.code);
    english(() => { const line = ui.reasonText(reason); assert.ok(line.length > 4 && !han.test(line), `${reason.code}: ${line}`); });
  }
  assert.equal(ui.reasonText({ code: 'nothing' }), '');
  assert.equal(ui.leftOutText({ open: 1, flashcard: 17, cloze: 0 }), '开放 1 道、闪卡 17 道');
  english(() => assert.equal(ui.leftOutText({ open: 1, flashcard: 17 }), 'Open: 1, Flashcard: 17'));
  assert.equal(ui.dayKind({ mode: 'off' }), '休息');
});

test('翻看: every point in the plan\'s order, its 易错点 open, its 讲解 folded and not drawn, 已看 and the progress', () => {
  const book = exportBook();
  const crunch = { status: 'ok', plan: { today: { ...FLIP, points: ['h2'] }, order: { flip: ['h3', 'h2'] } },
    points: [{ ...POINTS[0], seen: '2026-10-16' }, { ...POINTS[1], seen: null }] };
  const html = render(h(ui.BookFlip, { book, crunch, course: 'SA', handlers: {}, onMark: noop, onGo: noop, onMockStarted: noop }));
  const text = textOf(html);
  for (const part of ['已看 1 / 2 个', '考前最后一天', '出卷范围：今天的 1 个知识点', '问过：为什么串联要相乘？', '易错：把串联的可用性相加', '这个知识点还没有记下的易错点。', '讲解', '已看', '选进模拟卷',
    '在书里看这个知识点', '今天']) assert.ok(text.includes(part), part);
  assert.ok(html.indexOf('data-flip-point="h3"') < html.indexOf('data-flip-point="h2"'), 'the plan\'s order');
  assert.match(html, /data-flip-point="h2" data-seen="true"/);
  assert.doesNotMatch(text, /串联时 A = A1 x A2|An AI paragraph/, 'the 讲解 is folded: not drawn');
  // Without a plan: the book's order, the whole book for the mock paper.
  const plain = textOf(render(h(ui.BookFlip, { book, crunch: null, course: 'SA', handlers: {}, onMark: noop, onGo: noop })));
  assert.ok(plain.includes('已看 0 / 2 个') && plain.includes('出卷范围：全书 2 个知识点'));
  english(() => {
    const en = textOf(render(h(ui.BookFlip, { book, crunch, course: 'SA', handlers: {}, onMark: noop, onGo: noop })));
    for (const part of ['Looked over 1 / 2 points', 'Asked: ', 'Pitfall: ', 'No mistakes noted for this point yet.', 'Into the mock paper', 'See this point in the book']) assert.ok(en.includes(part), part);
  });
});

test('the home card shows nothing while no course has an exam within its window; the mock button waits for a click', () => {
  assert.equal(render(h(ui.CrunchCard, { data: { courses: [{ name: 'SA', exam: { date: '2099-01-01' } }], settings: {} }, onOpenBook: noop, onPractice: noop, onExamRun: noop })), '');
  assert.equal(render(h(ui.CrunchCard, { data: { courses: [{ name: 'SA' }] }, onOpenBook: noop, onPractice: noop, onExamRun: noop })), '');
  const button = render(h(ui.MockPaper, { course: 'SA', pointIds: ['h2'], onStarted: noop }));
  assert.match(button, /data-usage="book\.mock"/);
  assert.match(textOf(button), /^用这些知识点出一套模拟卷$/);
});
