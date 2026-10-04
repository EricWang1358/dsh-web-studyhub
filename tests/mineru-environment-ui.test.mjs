import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The 运行环境 block of a conversion, on the live card and on the history rows (one component), and the window list that wraps inside the card. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { PdfConvertJobs, PdfConvertHistory } from './ui/PdfConvertJob.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { PdfConvertJobs, PdfConvertHistory, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const call = async () => ({});
const MB = 1024 * 1024;

const localEnv = { kind: 'local', mineruVersion: '4.0.10', tier: 'standard', model: 'MinerU2.5-Pro-2605-1.2B-GGUF', modelsPath: 'C:\\Users\\student\\.mineru\\models', modelsRealPath: 'E:\\mineru-models\\models', windows: { kind: 'fixed', pages: 50 } };
const cloudEnv = { kind: 'cloud', modelVersion: 'vlm', language: 'ch', maxPages: 200, maxBytes: 180 * MB, bookBytes: 96 * MB };
const now = Date.now();
const windows = count => Array.from({ length: count }, (_, i) => ({ index: i + 1, startPage: i * 50 + 1, endPage: i * 50 + 50, pages: 50, state: i < 2 ? 'done' : 'planned' }));
const job = (extra = {}) => ({ id: `j-${Math.random()}`, type: 'pdf-convert', route: 'local', tier: 'standard', filename: 'Operating Systems.pdf', status: 'running', phase: 'local', done: 100, total: 562,
  chunk: { index: 3, count: 12 }, chunks: windows(12), stage: '第 3/12 段 · 正在本地解析', warnings: [], note: '', startedAt: new Date(now - 90_000).toISOString(), env: localEnv,
  service: { state: 'running', basis: 'window', at: new Date(now - 20_000).toISOString() }, ...extra });
const jobs = list => h(PdfConvertJobs, { call, jobs: list });

/* ---------- the live card ---------- */

test('a local run says what does the work: the version, the tier and what it means, the model, the window size', () => {
  const html = render(jobs([job()]));
  assert.match(html, /运行环境/);
  assert.match(html, /本地 mineru 4\.0\.10 · standard 档（版面理解更好，稍慢）/);
  assert.match(html, /模型：MinerU2\.5-Pro-2605-1\.2B-GGUF/);
  assert.match(html, /每次 50 页，一段做完才前进/);
  assert.match(html, /class="pdf-env"/);
});

test('the basic tier has its own plain meaning, and a tier it does not know is just named', () => {
  assert.match(render(jobs([job({ env: { ...localEnv, tier: 'basic', model: 'MinerU-4_models_onnx' } })])), /basic 档（速度较快）/);
  const other = render(jobs([job({ env: { ...localEnv, tier: 'advanced' } })]));
  assert.match(other, /advanced 档/);
  assert.doesNotMatch(other, /advanced 档（/);
});

test('where the models live is in a folder disclosure, with where a link really points; nothing when the folder is not known', () => {
  const html = render(jobs([job()]));
  assert.match(html, /<details[^>]*pdf-env__where/);
  assert.match(html, /模型位置/);
  assert.match(html, /C:\\Users\\student\\\.mineru\\models/);
  assert.match(html, /它是一个链接，实际在：E:\\mineru-models\\models/);
  const plain = render(jobs([job({ env: { ...localEnv, modelsRealPath: undefined } })]));
  assert.doesNotMatch(plain, /它是一个链接/);
  const unknown = render(jobs([job({ env: { kind: 'local', mineruVersion: '4.0.10', tier: 'basic' } })]));
  assert.doesNotMatch(unknown, /模型位置/);
  assert.doesNotMatch(unknown, /模型：/);
});

test('a device is named only when the CLI reported one', () => {
  assert.doesNotMatch(render(jobs([job()])), /设备/);
  assert.match(render(jobs([job({ env: { ...localEnv, device: 'cuda' } })])), /设备：cuda/);
});

test('the service state is a live dot and one honest sentence: up, stopped, or not known', () => {
  const up = render(jobs([job()]));
  assert.match(up, /<li[^>]*class="pdf-env__service"[^>]*data-state="running"/);
  assert.match(up, /<span[^>]*class="pdf-env__dot"[^>]*aria-hidden="true"/);
  assert.match(up, /本地服务运行中/);
  assert.match(up, /20 秒前确认|刚刚确认|1 分钟前确认/);
  const stopped = render(jobs([job({ service: { state: 'stopped', basis: 'window', at: new Date(now).toISOString() } })]));
  assert.match(stopped, /data-state="stopped"/);
  assert.match(stopped, /本地服务已停止/);
  assert.match(stopped, /pdf-env__warning/);
  const unknown = render(jobs([job({ service: { state: 'unknown', basis: 'none', at: new Date(now).toISOString() } })]));
  assert.match(unknown, /data-state="unknown"/);
  assert.match(unknown, /无法确认本地服务是否在运行/);
});

test('a failed run with a stopped service names it, and offers the restart that already exists', () => {
  const html = render(jobs([job({ status: 'failed', retryable: true, errorCode: 'server-stopped', service: { state: 'stopped', basis: 'window', at: new Date(now).toISOString() },
    stage: '本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。', finishedAt: new Date(now).toISOString() })]));
  assert.match(html, /本地服务已停止/);
  assert.match(html, />重新启动本地服务并接着做</);
  assert.match(html, /点「重新启动本地服务并接着做」/);
});

test('a cloud run says what does the work: MinerU, the model version, the language, the saved token (never shown), the piece limits', () => {
  const html = render(jobs([job({ route: 'cloud', tier: undefined, env: cloudEnv, service: undefined, phase: 'parse', stage: '第 2/3 段 · 正在解析', chunks: windows(3) })]));
  assert.match(html, /云端 MinerU · vlm 模型/);
  assert.match(html, /识别语言：ch/);
  assert.match(html, /使用你保存的令牌（令牌不会显示）/);
  assert.match(html, /每段不超过 200 页 \/ 180 MB · 本书 96 MB/);
  assert.doesNotMatch(html, /本地服务|模型位置|data-state/);
});

test('a job from before the environment was kept has no block, and nothing is made up', () => {
  const html = render(jobs([job({ env: undefined, service: undefined })]));
  assert.doesNotMatch(html, /运行环境/);
});

/* ---------- the window list ---------- */

test('up to eight windows are listed inside the card, each with its pages and its state', () => {
  const html = render(jobs([job({ chunks: windows(6), chunk: { index: 3, count: 6 } })]));
  assert.match(html, /<ol[^>]*class="sh-job__steps pdf-chunks"/);
  assert.match(html, /<li class="is-done"><svg[^>]*>.*?<\/svg><span class="sh-visually-hidden">已完成 <\/span>第 1 段 · 第 1–50 页/);
  assert.match(html, /<li class="is-current"[^>]*>第 3 段 · 第 101–150 页/);
  assert.match(html, /<li class="">第 4 段 · 第 151–200 页|<li>第 4 段 · 第 151–200 页/);
  assert.doesNotMatch(html, /展开各段/);
});

test('more than eight windows collapse to "第 i / N 段" with a toggle, and open to the same list', () => {
  const closed = render(jobs([job()]));
  assert.match(closed, /第 3\/12 段/);
  assert.match(closed, /已完成 2 段/);
  assert.match(closed, /<button[^>]*aria-expanded="false"[^>]*>展开各段</);
  assert.doesNotMatch(closed, /<ol[^>]*pdf-chunks/);
  const opened = render(h(PdfConvertJobs, { call, jobs: [job()], expandChunks: true }));
  assert.match(opened, /<button[^>]*aria-expanded="true"[^>]*>收起各段</);
  assert.equal((opened.match(/第 \d+ 段 · 第 [\d–]+ 页/g) || []).length, 12);
});

test('a finished conversion keeps no window list, as before', () => {
  const html = render(jobs([job({ status: 'complete', phase: 'done', sourceIds: ['a'], finishedAt: new Date(now).toISOString() })]));
  assert.doesNotMatch(html, /<ol[^>]*pdf-chunks|展开各段/);
});

/* ---------- the history rows ---------- */

const record = (extra = {}) => ({ id: 'job-0001', version: 1, filename: 'Operating Systems.pdf', bytes: 96 * MB, pages: 562, pieces: 12, route: 'local', tier: 'standard', status: 'complete', phase: 'done',
  pagesDone: 562, attempts: 1, elapsedMs: 900_000, startedAt: new Date(now - 3_600_000).toISOString(), finishedAt: new Date(now - 2_700_000).toISOString(), importedPages: 560, skippedPages: 2,
  documentId: 'd', title: 'Operating Systems', canRetry: false, live: false, document: { exists: true, title: 'Operating Systems', pages: 560, sourceIds: ['s1'] },
  env: { kind: 'local', mineruVersion: '4.0.10', tier: 'standard', model: 'MinerU2.5-Pro-2605-1.2B-GGUF', windows: { kind: 'fixed', pages: 50 } }, ...extra });
const history = (records, extra = {}) => h(PdfConvertHistory, { call, initialRecords: records, now, ...extra });

test('a history row says what ran it: the same block, collapsed, with no folder and no live service state', () => {
  const html = render(history([record()]));
  assert.match(html, /<details[^>]*class="pdf-env-details"/);
  assert.match(html, /运行环境/);
  assert.match(html, /本地 mineru 4\.0\.10 · standard 档（版面理解更好，稍慢）/);
  assert.match(html, /模型：MinerU2\.5-Pro-2605-1\.2B-GGUF/);
  assert.match(html, /每次 50 页，一段做完才前进/);
  assert.doesNotMatch(html, /模型位置|pdf-env__service|C:\\/);
});

test('a row that failed because the service was stopped says so, from the record', () => {
  const html = render(history([record({ status: 'failed', finishedAt: undefined, failure: { stage: 'local', code: 'server-stopped', reason: '本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。' }, canRetry: true })]));
  assert.match(html, /失败时本地服务已停止/);
});

test('a cloud row has the cloud environment', () => {
  const html = render(history([record({ route: 'cloud', tier: undefined, env: { kind: 'cloud', modelVersion: 'vlm', language: 'ch', maxPages: 200, maxBytes: 180 * MB, bookBytes: 96 * MB } })]));
  assert.match(html, /云端 MinerU · vlm 模型/);
  assert.match(html, /每段不超过 200 页 \/ 180 MB/);
});

test('a record without an environment (made before it was kept) shows no block', () => {
  assert.doesNotMatch(render(history([record({ env: undefined })])), /运行环境/);
});

/* ---------- English ---------- */

test('English: no Chinese in any state of the environment block or the window list', () => {
  const stopped = { state: 'stopped', basis: 'window', at: new Date(now).toISOString() };
  const list = [
    jobs([job()]), jobs([job({ env: { ...localEnv, device: 'cuda' } })]), jobs([job({ env: { ...localEnv, tier: 'basic' } })]), jobs([job({ env: { ...localEnv, tier: 'advanced', modelsRealPath: undefined } })]),
    jobs([job({ service: stopped })]), jobs([job({ service: { state: 'unknown', basis: 'none', at: new Date(now).toISOString() } })]),
    jobs([job({ status: 'failed', retryable: true, errorCode: 'server-stopped', service: stopped, stage: '本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。' })]),
    jobs([job({ route: 'cloud', tier: undefined, env: cloudEnv, service: undefined, chunks: windows(3) })]), jobs([job({ chunks: windows(6) })]), h(PdfConvertJobs, { call, jobs: [job()], expandChunks: true }),
    history([record(), record({ route: 'cloud', tier: undefined, env: { kind: 'cloud', modelVersion: 'vlm', language: 'ch', maxPages: 200, maxBytes: 180 * MB, bookBytes: 96 * MB } }),
      record({ status: 'failed', failure: { stage: 'local', code: 'server-stopped', reason: 'x' }, canRetry: true })]),
  ];
  for (const element of list) assert.doesNotMatch(render(element, 'en').replace(/本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。/g, 'x'), han);
  const english = render(jobs([job()]), 'en');
  assert.match(english, /Environment/);
  assert.match(english, /Local mineru 4\.0\.10 · standard tier \(better layout understanding, a little slower\)/);
  assert.match(english, /Model: MinerU2\.5-Pro-2605-1\.2B-GGUF/);
  assert.match(english, /The local service is running/);
  assert.match(english, /50 pages at a time; progress moves when a window is done/);
  assert.match(english, /Show all windows/);
  const cloud = render(jobs([job({ route: 'cloud', tier: undefined, env: cloudEnv, service: undefined, chunks: windows(3) })]), 'en');
  assert.match(cloud, /MinerU cloud · vlm model/);
  assert.match(cloud, /Uses your saved token \(the token is never shown\)/);
  assert.match(cloud, /Up to 200 pages \/ 180 MB per piece · this book 96 MB/);
});

test('Marker environment does not display MinerU daemon states or restart instructions', () => {
  const html = render(jobs([job({ converter: 'marker', env: { kind: 'local', windows: { kind: 'fixed', pages: 5 } }, service: { state: 'stopped' } })]));
  assert.match(html, /本地 Marker/);
  assert.doesNotMatch(html, /本地服务|重新启动|pdf-env__service/);
  assert.match(html, /每次 5 页/);
});
