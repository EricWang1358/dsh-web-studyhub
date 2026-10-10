/* 复习全书 M6 on the page (static zh and en): the 「查找」 view draws the lookup (目录 with codes, 按题型 with steps / formulas / mistakes, 按概念,
   易错点), each code a button to its heading, an empty part says how it fills; the export dialog offers 含 / 不含答案册 and the page limit; the
   limit is compared quietly. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { exportBook } from './helpers/course-book-export-book.mjs';
import { bookLookup } from '../lib/course-book-lookup.js';

const ui = await loadUi(`
  export { default as BookLookup } from './ui/book/BookLookup.jsx';
  export { default as BookExport, budgetText } from './ui/book/BookExport.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {};
const services = { call: () => new Promise(() => {}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('查找: 目录 with codes, 按题型 as the 速查表, 按概念, 易错点; codes are buttons to their headings', () => {
  const book = exportBook(), lookup = bookLookup(book, book);
  const html = render(h(ui.BookLookup, { lookup, onGo: noop }));
  const text = textOf(html);
  for (const part of ['目录', '按题型', '按概念', '易错点（按知识点）', '答题顺序', '检查顺序 · 公式', '最常见错误 · 必须交代的代价', '题干信号：', '代价：多一台服务器的费用。', '问过：为什么串联要相乘？',
    '易错：把串联的可用性相加']) assert.ok(text.includes(part), part);
  assert.match(html, /data-book-code="h2"[^>]*>H2</);
  assert.match(html, /data-book-code="h9"[^>]*>H9</, 'a typed heading is in the 目录 too');
  assert.match(html, /<code>A = MTBF \/ \(MTBF \+ MTTR\)<\/code>/);
  const empty = textOf(render(h(ui.BookLookup, { lookup: bookLookup({ ...book, nodes: [], unplaced: { title: '未归位', text: '' } }, { caseTypes: [], answerCards: [] }), onGo: noop })));
  assert.match(empty, /还没有分析题答案卡/);
  assert.match(empty, /还没有概念/);
  assert.match(empty, /还没有易错点/);
  english(() => {
    const en = textOf(render(h(ui.BookLookup, { lookup, onGo: noop })));
    for (const part of ['Contents', 'By question type', 'By concept', 'Mistakes by point', 'Answer order', 'Steps · formulas', 'Common mistakes · the cost to state', 'Asked: ']) assert.ok(en.includes(part), part);
  });
});

test('导出: 含 / 不含答案册, the page limit; the limit is compared quietly', () => {
  const text = textOf(render(h(ui.BookExport, { course: 'SA', pageLimit: 30, onClose: noop })));
  for (const part of ['导出复习全书', '不含答案册', '含答案册', '正在准备导出…', '页数上限', '下载 Markdown', '分文件导出…']) assert.ok(text.includes(part), part);
  assert.deepEqual(ui.budgetText(32, 30), { tone: 'warning', text: '超出上限 2 页' });
  assert.deepEqual(ui.budgetText(12, 30), { tone: 'success', text: '在上限 30 页以内' });
  assert.equal(ui.budgetText(12, undefined), null);
  english(() => {
    const en = textOf(render(h(ui.BookExport, { course: 'SA', onClose: noop })));
    for (const part of ['Export the review book', 'Without the answer key', 'With the answer key', 'Page limit', 'Download Markdown', 'Export as files…']) assert.ok(en.includes(part), part);
    assert.equal(ui.budgetText(32, 30).text, '2 pages over the limit');
  });
});
