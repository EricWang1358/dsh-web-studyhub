/* 深度定制 S1, the two quiet entries to the 定制 interview (skills/study-custom): 「深度定制这本书」 on the row of a document of CUSTOM_BOOK_PAGES pages or more
   (the 解析历史 and the import list, once the document is in), and 「深度定制…」 in the review book's 更多 menu, always. The threshold is one named constant
   in one place; the finder lists both entries. Static markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { anchorsInSource, sourceFiles } from './helpers/tour-anchors.mjs';

const ui = await loadUi(`
  export { CUSTOM_BOOK_PAGES, offersCustom, customOfferOf } from './ui/custom-entry.js';
  export { moreItems } from './ui/book/BookMore.jsx';
  export { PdfConvertHistory } from './ui/PdfConvertJob.jsx';
  export { FINDER_ENTRIES } from './ui/finder/entries.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const NOW = new Date(2026, 5, 15, 15, 0, 0).getTime();
const at = minutes => new Date(NOW - minutes * 60_000).toISOString();
const record = (pages, extra = {}) => ({ id: `job-${pages}`, version: 1, filename: 'Databases.pdf', bytes: 1 << 20, pages, pieces: 1, route: 'local', tier: 'basic', status: 'complete', phase: 'done',
  pagesDone: pages, attempts: 1, elapsedMs: 60_000, startedAt: at(8), finishedAt: at(3), importedPages: pages, skippedPages: 0, documentId: 'document-a-json', title: 'Databases',
  canRetry: false, live: false, document: { exists: true, title: 'Databases', pages, sourceIds: ['s1'] }, ...extra });
const history = (records, language = 'zh') => { ui.setUiLanguage(language); try { return renderToStaticMarkup(h(ui.PdfConvertHistory, { initialRecords: records, now: NOW })); } finally { ui.setUiLanguage('zh'); } };

test('one constant, 150 pages: the offer is for a document of that many pages or more', () => {
  assert.equal(ui.CUSTOM_BOOK_PAGES, 150);
  assert.equal(ui.offersCustom(149), false);
  assert.equal(ui.offersCustom(150), true);
  assert.equal(ui.offersCustom(512), true);
  for (const bad of [undefined, null, NaN, '300', -1]) assert.equal(ui.offersCustom(bad), false, String(bad));
});

test('the import list offers it for a finished paged document of 150 pages or more, with what the hand-off needs; not below, not for pasted text, not for decks', () => {
  const big = { kind: 'document', format: 'pdf', title: 'Databases', documentId: 'document-a-json', pages: 150, sourceIds: ['s1'], courses: ['DB'] };
  assert.deepEqual(ui.customOfferOf(big), { course: 'DB', document: 'document-a-json', pages: 150 });
  assert.equal(ui.customOfferOf({ ...big, pages: 149 }), null);
  assert.equal(ui.customOfferOf({ ...big, format: 'text', pages: 300 }), null, 'a pasted text has no pages to speak of');
  assert.equal(ui.customOfferOf({ ...big, documentId: undefined }), null, 'nothing to name the document by');
  assert.equal(ui.customOfferOf({ kind: 'deck', count: 400 }), null);
  assert.deepEqual(ui.customOfferOf({ ...big, courses: [] }), { course: '', document: 'document-a-json', pages: 150 });
  assert.equal(ui.customOfferOf(null), null);
});

test('解析历史: a finished conversion of 150 pages or more has 深度定制这本书 on its row; 149 pages, a failed one or one whose document is gone has not', () => {
  const big = history([record(150)]);
  assert.match(big, /data-hand-off="custom\.start"/);
  assert.match(big, />深度定制这本书</);
  assert.doesNotMatch(history([record(149)]), /custom\.start/);
  assert.doesNotMatch(history([record(300, { status: 'failed', document: undefined })]), /custom\.start/);
  assert.doesNotMatch(history([record(300, { document: { exists: false, title: 'Databases', pages: 0, sourceIds: [] } })]), /custom\.start/);
  assert.match(history([record(150)], 'en'), />Customize this book in depth</);
});

test('更多 of the review book: 深度定制… is always there, in the 整本书 group, before 发给主会话', () => {
  const items = ui.moreItems({});
  const custom = items.find(item => item.id === 'custom');
  assert.ok(custom, 'always');
  assert.equal(custom.label, '深度定制…');
  const group = items.slice(items.findIndex(item => item.heading && item.label === '整本书'), items.findIndex(item => item.heading && item.label === '期末一周'));
  assert.ok(group.includes(custom), 'under 整本书');
  assert.equal(items.findIndex(item => item.id === 'custom') + 1, items.findIndex(item => item.id === 'chat'), 'right before 发给主会话');
  assert.equal(ui.moreItems({ unplaced: true }).some(item => item.id === 'custom'), true, 'also on 未归位: it is about the course, not the point');
});

test('the finder lists both entries, and the English is in the catalogue', async () => {
  const byId = new Map(ui.FINDER_ENTRIES.map(entry => [entry.id, entry]));
  const anchors = await anchorsInSource();
  for (const id of ['custom-book-menu', 'custom-book-import']) {
    const entry = byId.get(id);
    assert.ok(entry, id);
    assert.equal(entry.kind, 'feature');
    assert.ok(entry.aliases.includes('深度定制'), `${id}: found by the name of the feature`);
    assert.ok(entry.anchors.some(anchor => anchors.has(anchor)), `${id}: an anchor the UI renders`);
  }
  assert.deepEqual(byId.get('custom-book-menu').path, ['复习全书', '更多', '深度定制…']);
  assert.equal(byId.get('custom-book-import').path.at(-1), '深度定制这本书');
  assert.ok(byId.get('custom-book-import').what.includes(`${ui.CUSTOM_BOOK_PAGES} 页`), 'the sentence says the same page count as the constant');
});

test('the threshold lives in one place: no other source file spells the number as a page limit for the offer', async () => {
  const holders = [];
  for (const file of await sourceFiles('ui')) {
    const text = await readFile(file, 'utf8');
    if (/CUSTOM_BOOK_PAGES\s*=/.test(text)) holders.push(file.replaceAll('\\', '/'));
  }
  assert.deepEqual(holders, ['ui/custom-entry.js']);
  const locales = await readdir('ui/locales');
  assert.ok(locales.includes('en.custom.json'), 'the English of the new strings has a catalogue');
  const english = JSON.parse(await readFile(join('ui/locales', 'en.custom.json'), 'utf8'));
  for (const key of ['深度定制这本书', '深度定制…']) assert.ok(english[key], key);
});
