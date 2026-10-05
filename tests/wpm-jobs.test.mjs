import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 2, WP-M: PDF conversion jobs and their history are JobRows (#98 #100 #69 #71 #95 #101 #125 #126 #128).
const read = file => readFileSync(file, 'utf8');
const lacks = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} still has ${pattern}`); };
const has = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.match(text, pattern, `${file} lacks ${pattern}`); };
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { PdfConvertJobs, PdfConvertHistory, PdfDetail, historyDuration, historyAgo } from './ui/PdfConvertJob.jsx';
  export { default as PdfConversion } from './ui/PdfConversion.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const render = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };
const call = async () => ({});
const NOW = new Date(2026, 5, 15, 15, 0, 0).getTime();
const at = minutesAgo => new Date(NOW - minutesAgo * 60_000).toISOString();

const job = (extra = {}) => ({ id: 'j1', type: 'pdf-convert', route: 'cloud', filename: 'Book.pdf', status: 'running', phase: 'parse', done: 260, total: 450, chunk: { index: 2, count: 3 },
  chunks: [{ index: 1, startPage: 1, endPage: 200, pages: 200, state: 'done' }, { index: 2, startPage: 201, endPage: 400, pages: 200, state: 'parsing' }, { index: 3, startPage: 401, endPage: 450, pages: 50, state: 'planned' }],
  stage: '第 2/3 段 · 正在解析', warnings: [], note: '', startedAt: new Date(Date.now() - 90_000).toISOString(), ...extra });
// The card on a page and, beside it, the detail the 任务 console shows: what a job says in all.
const jobs = list => h(React.Fragment, null, h(m.PdfConvertJobs, { jobs: list, call, onOpenSources() {}, onOpenSettings() {} }),
  ...list.map(item => h(m.PdfDetail, { key: item.id, job: item })));
const record = (extra = {}) => ({ id: 'job-1', version: 1, filename: 'Databases.pdf', bytes: 12 * 1024 * 1024, pages: 450, pieces: 3, route: 'cloud', status: 'complete', phase: 'done',
  pagesDone: 450, attempts: 1, elapsedMs: 260_000, startedAt: at(8), finishedAt: at(3), importedPages: 448, skippedPages: 2, title: 'Databases', canRetry: false, live: false,
  document: { exists: true, title: 'Databases', sourceIds: ['s1'] }, ...extra });
const history = (records, extra = {}) => h(m.PdfConvertHistory, { call, initialRecords: records, now: NOW, ...extra });

test('a running conversion is one compact card: a dot, a named progress bar, no card-level live region (#98 #100)', () => {
  const out = render(jobs([job()]));
  assert.match(out, /<article[^>]*class="cjc"[^>]*data-state="run"/);
  assert.doesNotMatch(out.match(/<article[^>]*>/)[0], /role=/, 'the card itself is not a live region');
  assert.match(out, /role="progressbar"[^>]*aria-label="Book\.pdf 的进度"[^>]*aria-valuenow="58"/);
  assert.match(out, />58%</);
  assert.match(out, /解析文档 · 第 2\/3 段/);
  assert.match(out, />停止</);
  assert.match(out, /id="pdf-job-j1"/, 'History can still scroll to the live card');
  assert.doesNotMatch(out, /[◌✓×]/);
});

test('a failed conversion shows its reason as an alert and keeps its way on (#98)', () => {
  const out = render(jobs([job({ status: 'failed', retryable: true, errorCode: 'network', stage: '连不上 MinerU：请检查网络后重试（已完成的部分会保留）。' })]));
  assert.match(out, /data-state="fail"/);
  assert.match(out, /role="alert"[^>]*>连不上 MinerU/);
  assert.match(out, />接着做</);
  assert.match(out, /知道了/);
  assert.doesNotMatch(out, /className="warning"|class="warning"/);
  const token = render(jobs([job({ status: 'failed', retryable: true, errorCode: 'invalid-token', stage: '令牌无效' })]));
  assert.match(token, /去设置里换一个令牌/);
  const stopped = render(jobs([job({ status: 'failed', retryable: true, route: 'local', errorCode: 'server-stopped', stage: '服务停了' })]));
  assert.match(stopped, /重新启动本地服务并接着做/);
});

test('a finished conversion is jade, with the open button and a dismiss (#98)', () => {
  const out = render(jobs([job({ status: 'complete', phase: 'done', sourceIds: ['a', 'b'], finishedAt: new Date().toISOString() })]));
  assert.match(out, /data-state="done"/);
  assert.match(out, /打开资料：Book\.pdf/);
  assert.match(out, /aria-label="知道了：Book\.pdf"/);
  assert.match(out, /已存为 2 份资料/);
  const cancelled = render(jobs([job({ status: 'cancelled', stage: '已取消，已解析的段落保留。' })]));
  assert.match(cancelled, /data-state="stopped"/);
  assert.match(cancelled, /已完成的部分已保留/);
});

test('a conversion warning is counted on the card and a slow-down note is a hint in the detail (#87 #88)', () => {
  const out = render(jobs([job({ status: 'complete', phase: 'done', sourceIds: ['a'], warnings: ['本地解析可能把页眉也留在了正文里。'] }),
    job({ id: 'j2', note: 'MinerU 云端正在排队，比平时慢。这不是失败，会自动继续。' })]));
  assert.match(out, /1 条提醒/, 'the notices are counted on the card; their text is in the console log');
  assert.match(out, /sh-hint[^>]*>MinerU 云端正在排队/);
});

test('the done windows carry an icon, not a text check mark (#98)', () => {
  const out = render(jobs([job({ route: 'local', phase: 'local', chunk: { index: 2, count: 3 } })]));
  assert.match(out, /<ol[^>]*class="sh-job__steps pdf-chunks"/);
  assert.match(out, /<li class="is-done"><svg[^>]*aria-hidden="true"[^>]*>(?:(?!<\/li>).)*<\/svg><span class="sh-visually-hidden">已完成 <\/span>第 1 段 · 第 1–200 页/s);
  assert.match(out, /<li class="is-current"[^>]*>第 2 段 · 第 201–400 页/);
  assert.doesNotMatch(out, /✓/);
});

test('the job card keeps no private timer, glyph, duration or progress bar (#98 #101 #125 #126 #128)', () => {
  lacks('ui/PdfConvertJob.jsx', /setInterval|clearInterval/, /const spent =/, /const active =/, /export function historyDuration/, /export function historyAgo/,
    /audio-bar|audio-progress|audio-chip|audio-steps/, /['"`](?:◌|✓|×)|\{'!'\}|\? '!'/, /role="status"/, /\['running', 'queued'\]\.includes/, /\['queued', 'running', 'cancelling'\]/);
  has('ui/PdfConvertJob.jsx', /CompactJobCard/, /JobRow/, /useNow/, /usePolling/, /isActiveJob/, /formatDuration/, /formatAgo/, /Badge/, /InlineConfirm/);
  has('ui/PdfConversion.jsx', /ProgressBar/, /Badge/);
  lacks('ui/PdfConversion.jsx', /audio-bar|audio-chip/);
});

test('the history keeps its wording and shows status and route as badges (#95)', () => {
  assert.equal(m.historyDuration(260_000), '4 分 20 秒');
  assert.equal(m.historyAgo(at(3), NOW), '3 分钟前');
  const out = render(history([record(), record({ id: 'job-2', status: 'failed', canRetry: true, pagesDone: 200, finishedAt: at(60), failure: { stage: 'parse', piece: 2, reason: '没能转换这一段' } })]));
  assert.match(out, /<span class="sh-badge[^"]*"[^>]*data-tone="info"[^>]*>云端<\/span>/);
  assert.match(out, /<span class="sh-badge[^"]*"[^>]*data-tone="success"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?已完成<\/span>/s);
  assert.match(out, /<span class="sh-badge[^"]*"[^>]*data-tone="error"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?没有完成<\/span>/s);
  assert.match(out, /class="sh-job sh-job--complete[^"]*pdf-history__row/);
  assert.match(out, /class="sh-job sh-job--failed[^"]*pdf-history__row/);
  assert.match(out, /在「云端解析」阶段（第 2 段）没能完成/);
  assert.match(out, /没能转换这一段/);
  assert.doesNotMatch(out, /audio-chip|[◌✓×]/);
  assert.match(out, /<button[^>]*aria-label="打开「Databases」"/);
});

test('clearing the history is an InlineConfirm that gives focus back to its button (#69 #71)', () => {
  const out = render(history([record(), record({ id: 'job-2' })], { initialConfirmClear: true }));
  assert.match(out, /role="group"[^>]*aria-labelledby/);
  assert.doesNotMatch(out, /alertdialog|pdf-history__confirm/);
  assert.match(out, /清空这 2 条解析记录？/);
  assert.match(out, /已导入的资料不会被删除/);
  assert.ok(out.indexOf('>取消<') < out.indexOf('>确认清空<'), 'cancel before confirm');
  has('ui/PdfConvertJob.jsx', /returnFocusRef/);
  lacks('ui/mineru.css', /pdf-history__confirm|audio-chip--bad|audio-chip--warn/);
});

test('the PDF reading progress is a ProgressBar, not a borrowed audio bar (#101)', () => {
  const out = render(h(m.PdfConversion, { available: true, file: { name: 'Lecture.pdf', size: 1000 }, call, courses: [], initialPlan: { pages: 5, bytes: 1000 } }));
  assert.doesNotMatch(out, /audio-bar/);
});
