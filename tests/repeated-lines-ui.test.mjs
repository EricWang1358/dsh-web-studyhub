import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* Where the converter reports what it did (the 解析历史 row, the conversion's console detail, the import list), a converted book that left out lines
   repeated on most of its pages says how many and shows one, with 恢复 to put them back. */

const { PdfConvertHistory, PdfDetail, RepeatedNote, itemDetail, setUiLanguage } = await loadUi(`
  export { PdfConvertHistory, PdfDetail } from './ui/PdfConvertJob.jsx';
  export { RepeatedNote } from './ui/RepeatedNote.jsx';
  export { itemDetail } from './ui/ImportHub.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const han = /[㐀-鿿]/;
const repeated = { count: 240, lines: [{ text: '考研培训班 咨询电话 400-123-4567', pages: 120 }, { text: '- 1 -', pages: 120 }] };
const NOW = Date.UTC(2026, 10, 5, 8);
const record = document => ({ id: 'job-1', version: 1, filename: '讲义.pdf', pages: 120, route: 'local', tier: 'basic', status: 'complete', phase: 'done', pagesDone: 120,
  attempts: 1, elapsedMs: 60_000, startedAt: new Date(NOW - 120_000).toISOString(), finishedAt: new Date(NOW - 60_000).toISOString(), importedPages: 120, skippedPages: 0,
  documentId: 'document-a-json', title: '讲义', canRetry: false, live: false, document: { exists: true, title: '讲义', pages: 120, sourceIds: ['s1'], ...document } });

test('the note says how many lines went and shows one, with 恢复; nothing without a count or a document', () => {
  const html = render(h(RepeatedNote, { documentId: 'document-a-json', repeated }));
  assert.match(html, /去掉了 240 行每页都重复的内容（如「考研培训班 咨询电话 400-123-4567」）/);
  assert.match(html, />恢复</);
  assert.match(html, /data-repeated-note/);
  const english = render(h(RepeatedNote, { documentId: 'document-a-json', repeated }), 'en');
  assert.match(english, /Removed 240 lines repeated on most pages/);
  assert.match(english, />Restore</);
  assert.doesNotMatch(english.replace(/考研培训班 咨询电话 400-123-4567/, ''), han);
  assert.equal(render(h(RepeatedNote, { documentId: 'document-a-json', repeated: { count: 0, lines: [] } })), '');
  assert.equal(render(h(RepeatedNote, { repeated })), '');
});

test('a long line is shown cut short', () => {
  const html = render(h(RepeatedNote, { documentId: 'd', repeated: { count: 3, lines: [{ text: '很长的一行'.repeat(20), pages: 3 }] } }));
  assert.match(html, /…」/);
  assert.ok(html.length < 1200);
});

test('the 解析历史 row of a conversion that left lines out says so; a row without says nothing', () => {
  const html = render(h(PdfConvertHistory, { initialRecords: [record({ repeated })], now: NOW }));
  assert.match(html, /去掉了 240 行每页都重复的内容/);
  const plain = render(h(PdfConvertHistory, { initialRecords: [record({})], now: NOW }));
  assert.doesNotMatch(plain, /data-repeated-note/);
});

test('the conversion\'s console detail says so once it is complete', () => {
  const job = { id: 'job-1', status: 'complete', route: 'local', converter: 'mineru', documentId: 'document-a-json', repeated, sourceIds: ['s1'] };
  assert.match(render(h(PdfDetail, { job })), /去掉了 240 行每页都重复的内容/);
  assert.doesNotMatch(render(h(PdfDetail, { job: { ...job, status: 'running', phase: 'local' } })), /data-repeated-note/);
});

test('the import list says it for a converted book imported directly', () => {
  const item = { status: 'done', kind: 'document', result: { kind: 'document', format: 'pdf', converted: 'mineru', sourceIds: ['a', 'b'], documentId: 'document-a-json', repeated } };
  setUiLanguage('zh');
  assert.match(itemDetail(item), /去掉了 240 行每页都重复的内容/);
  assert.doesNotMatch(itemDetail({ ...item, result: { ...item.result, repeated: undefined } }), /重复/);
});
