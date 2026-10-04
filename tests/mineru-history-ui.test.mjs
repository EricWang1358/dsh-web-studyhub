import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The 解析历史 section: one row per conversion (cloud and local), grouped by day, newest first, with the result and the one next step. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as MineruRoute } from './ui/MineruRoute.jsx';
  export { PdfConvertHistory, historyDuration, historyAgo } from './ui/PdfConvertJob.jsx';
  export { groupHistoryByDay, HISTORY_PAGE, historyRefreshKey } from './ui/mineru-flow.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { MineruRoute, PdfConvertHistory, historyDuration, historyAgo, groupHistoryByDay, HISTORY_PAGE, historyRefreshKey, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const call = async () => ({});

const NOW = new Date(2026, 5, 15, 15, 0, 0).getTime();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const MB = 1024 * 1024;
let n = 0;
const record = (extra = {}) => ({ id: `job-${String(++n).padStart(4, '0')}`, version: 1, filename: 'Databases.pdf', bytes: 12 * MB, pages: 450, pieces: 3, route: 'cloud', status: 'complete', phase: 'done',
  pagesDone: 450, attempts: 1, elapsedMs: 260_000, startedAt: at(8), finishedAt: at(3), importedPages: 448, skippedPages: 2, documentId: 'document-a-json', title: 'Databases',
  canRetry: false, live: false, document: { exists: true, title: 'Databases', sourceIds: ['s1', 's2'] }, ...extra });
const failed = (extra = {}) => record({ status: 'failed', phase: 'parse', finishedAt: at(60), startedAt: at(70), elapsedMs: 600_000, pagesDone: 200, documentId: undefined, importedPages: undefined, document: undefined,
  failure: { stage: 'parse', piece: 2, reason: 'MinerU 没能转换这一段文件（可能是文件受保护或内容异常）。' }, canRetry: true, ...extra });
const view = (records, extra = {}) => h(PdfConvertHistory, { call, initialRecords: records, now: NOW, ...extra });

/* ---------- helpers ---------- */

test('durations read like a person says them, and a missing one is never made up', () => {
  setUiLanguage('zh');
  assert.equal(historyDuration(260_000), '4 分 20 秒');
  assert.equal(historyDuration(45_000), '45 秒');
  assert.equal(historyDuration(60_000), '1 分钟');
  assert.equal(historyDuration(3_900_000), '1 小时 5 分');
  assert.equal(historyDuration(0), '不到 1 秒');
  assert.equal(historyDuration(undefined), '');
  assert.equal(historyDuration(NaN), '');
  setUiLanguage('en');
  assert.equal(historyDuration(260_000), '4 min 20 sec');
  assert.equal(historyDuration(3_900_000), '1 h 5 min');
  setUiLanguage('zh');
});

test('"when" is relative within a day and a date after that', () => {
  setUiLanguage('zh');
  assert.equal(historyAgo(at(0), NOW), '刚刚');
  assert.equal(historyAgo(at(3), NOW), '3 分钟前');
  assert.equal(historyAgo(at(125), NOW), '2 小时前');
  assert.equal(historyAgo(at(1), NOW), '1 分钟前');
  assert.equal(historyAgo(at(60), NOW), '1 小时前');
  assert.match(historyAgo(at(60 * 24 * 3), NOW), /\d/);
  assert.doesNotMatch(historyAgo(at(60 * 24 * 3), NOW), /前/);
  assert.equal(historyAgo(undefined, NOW), '');
  setUiLanguage('en');
  assert.equal(historyAgo(at(3), NOW), '3 minutes ago');
  assert.equal(historyAgo(at(125), NOW), '2 hours ago');
  assert.equal(historyAgo(at(1), NOW), '1 minute ago');
  assert.equal(historyAgo(at(60), NOW), '1 hour ago');
  setUiLanguage('zh');
});

test('rows are grouped by day, newest first, and a record without a start time is not lost', () => {
  const today = record({ startedAt: at(30) }), early = record({ startedAt: at(90) }), yesterday = record({ startedAt: at(60 * 24) }), old = record({ startedAt: at(60 * 24 * 9) });
  const groups = groupHistoryByDay([old, early, yesterday, today], NOW);
  assert.deepEqual(groups.map(group => group.rows.map(row => row.id)), [[today.id, early.id], [yesterday.id], [old.id]]);
  assert.deepEqual(groups.map(group => group.when), ['today', 'yesterday', 'date']);
  assert.equal(groupHistoryByDay([record({ startedAt: undefined })], NOW).length, 1);
  assert.deepEqual(groupHistoryByDay([], NOW), []);
  assert.equal(HISTORY_PAGE, 10);
});

test('the list refreshes when a conversion job changes state, not on every tick of progress', () => {
  const job = (extra = {}) => ({ id: 'a', type: 'pdf-convert', status: 'running', phase: 'parse', done: 10, ...extra });
  assert.equal(historyRefreshKey([job()]), historyRefreshKey([job({ done: 50 })]));
  assert.notEqual(historyRefreshKey([job()]), historyRefreshKey([job({ status: 'complete' })]));
  assert.notEqual(historyRefreshKey([job()]), historyRefreshKey([job(), job({ id: 'b' })]));
  assert.equal(historyRefreshKey([{ id: 'x', type: 'audio-import', status: 'running' }]), historyRefreshKey([]));
  assert.equal(historyRefreshKey(undefined), historyRefreshKey([]));
});

/* ---------- the section ---------- */

test('empty: it says what will appear here, and offers nothing to clear', () => {
  const html = render(view([]));
  assert.match(html, /解析历史/);
  assert.match(html, /还没有解析记录/);
  assert.match(html, /文件名、解析工具、耗时和结果/);
  assert.match(html, /不保存文档内容/);
  assert.doesNotMatch(html, /清空历史/);
});

test('a finished row: file name, size and pages, the route, the status, when and how long, the result, and a way to open it', () => {
  const html = render(view([record()]));
  assert.match(html, /Databases\.pdf/);
  assert.match(html, /12 MB · 450 页/);
  assert.match(html, /sh-badge[^>]*data-tone="info"[^>]*>云端</);
  assert.match(html, /已完成/);
  assert.match(html, /3 分钟前 · 用时 4 分 20 秒/);
  assert.match(html, /已导入为「Databases」· 共 448 页/);
  assert.match(html, />打开资料</);
  assert.match(html, /删除记录/);
  assert.match(html, /清空历史/);
  assert.match(html, /今天/);
  assert.match(html, /不会删除已导入的资料/);
});

test('a local row names the tier; a document that was deleted says so and has nothing to open', () => {
  const html = render(view([record({ route: 'local', tier: 'basic', document: { exists: false, sourceIds: [] } })]));
  assert.match(html, /本地 · basic/);
  assert.match(html, /已导入的资料已被删除/);
  assert.doesNotMatch(html, />打开资料</);
});

test('a failed row: the stage and the reason in plain words, and a retry that does not redo finished pieces', () => {
  const html = render(view([failed()]));
  assert.match(html, /没有完成/);
  assert.match(html, /在「云端解析」阶段（第 2 段）没能完成/);
  assert.match(html, /MinerU 没能转换这一段文件/);
  assert.match(html, /已解析 200\/450 页/);
  assert.match(html, />接着做（不重复已完成的段落）</);
  assert.match(html, /用时 10 分钟/);
});

test('a failed row that cannot resume says why and how to go on', () => {
  const html = render(view([failed({ canRetry: false })]));
  assert.doesNotMatch(html, />接着做/);
  assert.match(html, /临时文件已清理/);
  assert.match(html, /重新选择这份 PDF/);
});

test('an interrupted row has no end and no duration, and offers 接着做 only when it can', () => {
  const resumable = render(view([record({ status: 'interrupted', finishedAt: undefined, elapsedMs: 0, documentId: undefined, document: undefined, canRetry: true, pagesDone: 200 })]));
  assert.match(resumable, /被中断/);
  assert.match(resumable, /上次没有做完/);
  assert.match(resumable, />接着做</);
  assert.doesNotMatch(resumable, /用时/);
  const gone = render(view([record({ status: 'interrupted', finishedAt: undefined, elapsedMs: 0, documentId: undefined, document: undefined, canRetry: false })]));
  assert.doesNotMatch(gone, />接着做</);
  assert.match(gone, /重新选择这份 PDF/);
});

test('a cancelled row says what was kept; a running row links to its live card and cannot be deleted', () => {
  const cancelled = render(view([record({ status: 'cancelled', documentId: undefined, document: undefined, importedPages: undefined })]));
  assert.match(cancelled, /已取消/);
  assert.match(cancelled, /已解析好的段落会保留/);
  const running = render(view([record({ status: 'running', phase: 'parse', finishedAt: undefined, elapsedMs: 0, documentId: undefined, document: undefined, live: true, pagesDone: 100 })]));
  assert.match(running, /进行中/);
  assert.match(running, />查看进度</);
  assert.match(running, /已解析 100\/450 页/);
  assert.doesNotMatch(running, />删除记录</);
  assert.doesNotMatch(running, /清空历史/, 'nothing that can be cleared');
});

test('more than ten rows: ten are shown, the rest behind "显示更多"', () => {
  const many = Array.from({ length: 23 }, (_, index) => record({ filename: `Book-${index}.pdf`, startedAt: at(index + 1) }));
  const html = render(view(many));
  assert.equal((html.match(/pdf-history__row/g) || []).length, 10);
  assert.match(html, /显示更多（还有 13 条）/);
  const all = render(view(many, { initialShown: 30 }));
  assert.equal((all.match(/pdf-history__row/g) || []).length, 23);
  assert.doesNotMatch(all, /显示更多/);
});

test('clearing asks first, and says the imported material stays', () => {
  const html = render(view([record(), failed()], { initialConfirmClear: true }));
  assert.match(html, /清空这 2 条解析记录？/);
  assert.match(html, /已导入的资料不会被删除/);
  assert.match(html, />确认清空</);
  assert.match(html, />取消</);
});

test('every action is a real button with a name that says which file it is for (keyboard and screen readers)', () => {
  const html = render(view([record(), failed({ filename: 'Notes.pdf' })]));
  assert.match(html, /<button[^>]*aria-label="删除「Databases\.pdf」的记录"/);
  assert.match(html, /<button[^>]*aria-label="打开「Databases」"/);
  assert.match(html, /<button[^>]*aria-label="接着解析「Notes\.pdf」"/);
  assert.doesNotMatch(html, /<div[^>]*onclick/i);
  assert.match(html, /<section[^>]*aria-label="解析历史"/);
  assert.match(html, /<ul[^>]*pdf-history__list/);
});

test('the rows reuse the conversion job card markup, so one component per action', () => {
  const html = render(view([record(), failed()]));
  assert.match(html, /class="sh-job sh-job--complete[^"]*pdf-history__row/);
  assert.match(html, /class="sh-job sh-job--failed[^"]*pdf-history__row/);
});

test('where the owner looks: the MinerU panel opened from "用 MinerU 解析" has the history, and it does not depend on a PDF being chosen', () => {
  const route = render(h(MineruRoute, { call, onFile() {}, initialSettings: { token: { set: false }, acknowledged: false }, initialLocal: { state: 'not-installed', next: 'install' },
    initialHistory: [record()], historyNow: NOW }));
  assert.match(route, /解析历史/);
  assert.match(route, /Databases\.pdf/);
  const none = render(h(MineruRoute, { call, onFile() {}, initialSettings: { token: { set: false }, acknowledged: false }, initialLocal: { state: 'not-installed', next: 'install' }, initialHistory: [], historyNow: NOW }));
  assert.match(none, /还没有解析记录/);
  const compact = render(h(MineruRoute, { call, compact: true, onFile() {}, initialSettings: { token: { set: false }, acknowledged: false }, initialLocal: { state: 'not-installed', next: 'install' } }));
  assert.doesNotMatch(compact, /解析历史/, 'the compact card inside the large-document advice stays small');
});

/* ---------- English ---------- */

test('English: no Chinese outside file names and titles, in any state of the history', () => {
  const states = [view([]), view([record(), failed(), record({ route: 'local', tier: 'basic' })]),
    view([record({ status: 'interrupted', finishedAt: undefined, elapsedMs: 0, documentId: undefined, document: undefined, canRetry: true })]),
    view([record({ status: 'interrupted', finishedAt: undefined, elapsedMs: 0, documentId: undefined, document: undefined, canRetry: false })]),
    view([failed({ canRetry: false })]), view([record({ status: 'cancelled', documentId: undefined, document: undefined })]),
    view([record({ status: 'running', phase: 'parse', finishedAt: undefined, live: true, documentId: undefined, document: undefined })]),
    view([record({ document: { exists: false, sourceIds: [] } })]), view([record()], { initialConfirmClear: true }),
    view(Array.from({ length: 14 }, (_, index) => record({ startedAt: at(index * 700) }))),
    h(MineruRoute, { call, onFile() {}, initialSettings: { token: { set: true }, acknowledged: true }, initialLocal: { state: 'ready', tier: 'basic' }, initialHistory: [record(), failed()], historyNow: NOW })];
  for (const element of states) {
    // The reason texts of a failure come from the backend already in the learner's language (lib/application-messages-en.js); a file name stays as it is.
    const html = render(element, 'en').replace(/MinerU 没能转换这一段文件（可能是文件受保护或内容异常）。/g, 'MinerU could not convert this piece (the file may be protected or its content unusual).');
    assert.doesNotMatch(html, han);
  }
  const english = render(view([record(), failed()]), 'en');
  assert.match(english, /Conversion history/);
  assert.match(english, /Imported as “Databases” · 448 pages/);
  assert.match(english, /3 minutes ago · took 4 min 20 sec/);
  assert.match(english, /Did not finish at the “Cloud conversion” stage \(piece 2\)/);
  assert.match(english, /Open the material/);
  assert.match(english, /Resume \(finished pieces are not redone\)/);
  assert.match(english, /Clear history/);
});
