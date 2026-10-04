import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The live card of a local conversion in the adaptive plan: which window runs, what the service says about it (queued, converting, no response, stopped, unknown) in
   plain words with what to do, the windows done / current / pending and the size of the next one, the estimate (hidden before the first window, "about", a range while the
   speed is not steady), and, afterwards, the real timings in the history rows. Chinese and English, one component for the live card and the history. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { PdfConvertJobs, PdfConvertHistory } from './ui/PdfConvertJob.jsx';
  export { default as MineruRoute } from './ui/MineruRoute.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { PdfConvertJobs, PdfConvertHistory, MineruRoute, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const call = async () => ({});
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const now = Date.now();
const ago = seconds => new Date(now - seconds * 1000).toISOString();

const localEnv = { kind: 'local', mineruVersion: '4.0.10', tier: 'basic', model: 'MinerU-4_models_onnx', windows: { kind: 'adaptive', firstPages: 10, targetSeconds: 75, minPages: 5, maxPages: 50 } };
const windows = [{ index: 1, startPage: 1, endPage: 10, pages: 10, state: 'done', seconds: 72 }, { index: 2, startPage: 11, endPage: 30, pages: 20, state: 'done', seconds: 61 },
  { index: 3, startPage: 31, endPage: 50, pages: 20, state: 'planned' }];
const view = (extra = {}) => ({ adaptive: true, window: { index: 3, startPage: 31, endPage: 50, pages: 20, startedAt: ago(95), expectedSeconds: 70 }, pace: { secondsPerPage: 3.1, windows: 2 },
  eta: { basis: 'measured', seconds: 1500, lowSeconds: 1500, highSeconds: 1500, stable: true }, next: 22, ...extra });
const job = (extra = {}) => ({ id: `j-${Math.random()}`, type: 'pdf-convert', route: 'local', tier: 'basic', filename: 'Scanned Textbook.pdf', status: 'running', phase: 'local', done: 30, total: 562,
  chunk: { index: 3, count: 0 }, chunks: windows, stage: '正在本地解析', warnings: [], note: '', startedAt: ago(200), env: localEnv, local: view(),
  service: { state: 'running', basis: 'window', at: ago(40) }, liveness: { state: 'parsing', at: ago(8), lastSignalAt: ago(8), silentForMs: 0 }, ...extra });
const jobs = list => h(PdfConvertJobs, { call, jobs: list });

/* ---------- the window and its state ---------- */

test('the card says which window is converting, since when and how long it should take, in the words a learner uses', () => {
  const html = render(jobs([job()]));
  const said = text(html);
  assert.match(said, /本地解析 · 第 3 段/);
  assert.doesNotMatch(said, /第 3\/\d+ 段/, 'the number of windows is not known in advance, so it is never "i of N"');
  assert.match(said, /这一段：第 31–50 页（20 页）/);
  assert.match(said, /已经用了 1 分 3\d 秒 · 预计约 1 分 10 秒/);
  assert.match(html, /data-state="parsing"/);
  assert.match(said, /转换中/);
  assert.match(said, /最后一次收到服务的状态：刚刚/);
});

test('each state of the window has its own plain label; "no response" says for how long and what to do, and is the only one that asks for anything', () => {
  const states = {
    queued: ['排队中', /服务收到了这一段，正在排队/],
    parsing: ['转换中', null],
    starting: ['服务正在启动', null],
    quiet: ['转换中（服务还没有报告这一段）', null],
    silent: ['无响应（已 6 分钟没有新状态）', /点「停止」[^。]*同一个 PDF[^。]*已经完成的段落会直接复用/],
    stopped: ['服务已停止', /点「重新启动本地服务并接着做」/],
    unknown: ['未知（读不到服务的状态）', /这不表示出了问题/],
  };
  for (const [state, [label, advice]] of Object.entries(states)) {
    const html = render(jobs([job({ liveness: { state, at: ago(10), lastSignalAt: ago(state === 'silent' ? 360 : 10), silentForMs: state === 'silent' ? 360_000 : 0 } })]));
    const said = text(html);
    assert.ok(said.includes(label), `${state}: "${label}" in "${said.slice(0, 600)}"`);
    assert.match(html, new RegExp(`data-state="${state}"`));
    if (advice) assert.match(said, advice, state);
  }
  assert.doesNotMatch(text(render(jobs([job()]))), /点「停止」，然后/, 'a window that is converting is not told to stop');
});

test('why a window can look stuck is explained once and plainly: the first window of a scan is the slowest, a slow computer takes proportionally longer, minutes without progress are normal', () => {
  const html = render(jobs([job()]));
  assert.match(html, /<details[^>]*pdf-live__why/);
  const said = text(html);
  assert.match(said, /为什么一段会这么久/);
  assert.match(said, /扫描版 PDF 的第一段最慢：模型要先加载，每一页还要做文字识别/);
  assert.match(said, /这台电脑慢，每段就按比例更久/);
  assert.match(said, /服务显示「转换中」时，几分钟没有新进度是正常的/);
});

test('without a liveness reading (the question is off, or a restored job) the card still shows the window and its timing, and says nothing about the service it cannot know', () => {
  const html = render(jobs([job({ liveness: undefined })]));
  assert.match(text(html), /这一段：第 31–50 页/);
  assert.doesNotMatch(html, /pdf-live__state/);
  assert.doesNotMatch(text(html), /最后一次收到服务的状态/);
});

/* ---------- the windows and the estimate ---------- */

test('the windows are listed as done, current and pending with the pages and the seconds each took, and the size the next one will have', () => {
  const html = render(jobs([job()]));
  const said = text(html);
  assert.match(said, /已完成 第 1 段 · 第 1–10 页 · 1 分 12 秒/);
  assert.match(said, /已完成 第 2 段 · 第 11–30 页 · 1 分 1 秒/);
  assert.match(html, /<li class="is-current"[^>]*>第 3 段 · 第 31–50 页/);
  assert.match(said, /下一段约 22 页（按这台电脑现在的速度）/);
  assert.match(html, /class="[^"]*pdf-chunks/);
});

test('many windows fold into one line with a toggle, and the line still says where the run is and how big the next window is', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ index: i + 1, startPage: i * 20 + 1, endPage: i * 20 + 20, pages: 20, state: i < 12 ? 'done' : 'planned', ...(i < 12 ? { seconds: 40 } : {}) }));
  const html = render(jobs([job({ chunks: many, chunk: { index: 13, count: 0 }, done: 240, local: view({ window: { index: 13, startPage: 241, endPage: 260, pages: 20, startedAt: ago(10), expectedSeconds: 40 } }) })]));
  const said = text(html);
  assert.match(said, /第 13 段 · 已完成 12 段/);
  assert.match(said, /下一段约 22 页/);
  assert.match(html, /展开各段/);
});

test('the estimate: nothing before the first window has finished; "about" one figure when the speed is steady; "about" a range, said to be unsteady, when it is not', () => {
  const none = text(render(jobs([job({ local: view({ pace: undefined, eta: undefined }), chunks: windows.map(window => ({ ...window, state: 'planned' })), done: 0 })])));
  assert.doesNotMatch(none, /预计还需/);
  assert.doesNotMatch(none, /每页约/, 'no pace before a window has been measured');
  const steady = text(render(jobs([job()])));
  assert.match(steady, /预计还需约 25 分钟/);
  assert.match(steady, /这台电脑每页约 3\.1 秒/);
  const unsteady = text(render(jobs([job({ local: view({ eta: { basis: 'measured', seconds: 1500, lowSeconds: 900, highSeconds: 2400, stable: false } }) })])));
  assert.match(unsteady, /预计还需约 15 分钟 到 40 分钟（速度还不稳定，估算会变）/);
  assert.doesNotMatch(unsteady, /预计还需约 25 分钟/);
  // the last stretch is "less than a minute", never "about less than a minute", and a range never starts at 0
  const almost = text(render(jobs([job({ local: view({ eta: { basis: 'measured', seconds: 20, lowSeconds: 20, highSeconds: 20, stable: true } }) })])));
  assert.match(almost, /预计还需不到 1 分钟/);
  assert.doesNotMatch(almost, /约 不到/);
  assert.match(text(render(jobs([job({ local: view({ eta: { basis: 'measured', seconds: 100, lowSeconds: 20, highSeconds: 400, stable: false } }) })]))), /预计还需约 1 分钟 到 7 分钟/);
  assert.match(text(render(jobs([job({ local: view({ eta: { basis: 'measured', seconds: 20, lowSeconds: 20, highSeconds: 20, stable: true } }) })]), 'en')), /Less than a minute left/);
});

test('a window that had to be retried in smaller pieces is said so', () => {
  assert.match(text(render(jobs([job({ local: view({ halved: 2 }) })]))), /有窗口没有成功，已自动拆成更小的段重试（2 次）/);
  assert.doesNotMatch(text(render(jobs([job()]))), /拆成更小的段/);
});

test('the environment block says how the windows are decided; a fixed plan still says its size', () => {
  assert.match(text(render(jobs([job()]))), /分段随这台电脑的速度调整：先做 10 页，之后每段约 75 秒（5–50 页）/);
  assert.match(text(render(jobs([job({ env: { ...localEnv, windows: { kind: 'fixed', pages: 50 } }, local: undefined, liveness: undefined, chunk: { index: 3, count: 12 } })]))), /每次 50 页，一段做完才前进/);
});

/* ---------- the history after the fact ---------- */

const record = (extra = {}) => ({ id: 'rec-00000001', filename: 'Scanned Textbook.pdf', bytes: 8 * 1024 * 1024, pages: 60, pieces: 4, route: 'local', tier: 'basic', status: 'complete', attempts: 1, elapsedMs: 280_000,
  startedAt: ago(3600), finishedAt: ago(3300), updatedAt: ago(3300), documentId: 'doc-1', importedPages: 60, skippedPages: 0, canRetry: false, live: false,
  env: localEnv, plan: { kind: 'adaptive', firstPages: 10, targetSeconds: 75, minPages: 5, maxPages: 50, secondsPerPage: 3.1 },
  windows: [{ start: 1, end: 10, pages: 10, seconds: 72, state: 'done' }, { start: 11, end: 30, pages: 20, seconds: 61, state: 'done' }, { start: 31, end: 50, pages: 20, seconds: 64.5, state: 'done' }, { start: 51, end: 60, pages: 10, seconds: 31, state: 'done' }],
  document: { exists: true, title: 'Scanned Textbook', pages: 60, sourceIds: ['s1'] }, ...extra });
const history = rows => h(PdfConvertHistory, { call, initialRecords: rows, now });

test('a finished row keeps the real timings: the pace of this computer and how long each window took', () => {
  const html = render(history([record()]));
  const said = text(html);
  assert.match(said, /这台电脑每页约 3\.1 秒/);
  assert.match(html, /<details[^>]*pdf-env__windows/);
  assert.match(said, /各段用时/);
  assert.match(said, /第 1 段 · 第 1–10 页 · 1 分 12 秒/);
  assert.match(said, /第 3 段 · 第 31–50 页 · 1 分 5 秒/);
  assert.match(said, /分段随这台电脑的速度调整/);
});

test('a row of a conversion that did not measure anything has no timings to show', () => {
  const html = render(history([record({ plan: { kind: 'fixed', windowPages: 50 }, env: { ...localEnv, windows: { kind: 'fixed', pages: 50 } }, windows: [{ start: 1, end: 50, pages: 50, state: 'done' }] })]));
  assert.doesNotMatch(html, /pdf-env__windows/);
  assert.doesNotMatch(text(html), /每页约/);
});

/* ---------- before it starts ---------- */

const states = { ready: { state: 'ready', next: null, tier: 'basic', version: '4.0.10', estimates: { basic: 1.6, standard: 2.5 }, windowPages: 50 } };
const saved = { token: { set: true, hint: '••••abcd', source: 'file' }, acknowledged: true, docsUrl: 'https://mineru.net/apiManage/docs' };
const adaptivePlan = { name: 'Book.pdf', pages: 450, bytes: 12 * 1024 * 1024, byChapters: false, maySplitFurther: false, pieces: [], windows: [{ index: 1, startPage: 1, endPage: 10, pages: 10 }],
  adaptive: { firstPages: 10, rampPages: [10, 20, 20], targetSeconds: 75, minPages: 5, maxPages: 50 }, tokenSet: true, acknowledged: true };

test('before a local run starts the plan is told as what it will do, not as a count of windows nobody has decided yet', () => {
  const html = render(h(MineruRoute, { file: { name: 'Book.pdf', size: 12 * 1024 * 1024 }, call, initialSettings: saved, initialLocal: states.ready, initialPlan: adaptivePlan, initialRoute: 'local' }));
  const said = text(html);
  assert.match(said, /共 450 页/);
  assert.match(said, /先做 10 页看一看这台电脑有多快，再按它的速度调整每段的页数（每段约 75 秒，5–50 页）/);
  assert.doesNotMatch(said, /这本书会分 \d+ 段处理/);
  assert.doesNotMatch(said, /每 50 页一段/);
  assert.match(said, /开始本地解析/);
});

/* ---------- English ---------- */

test('English: no Chinese anywhere in the live card, in any state, nor in the history row (file names aside)', () => {
  for (const state of ['queued', 'parsing', 'starting', 'quiet', 'silent', 'stopped', 'unknown']) {
    const html = render(jobs([job({ liveness: { state, at: ago(10), lastSignalAt: ago(400), silentForMs: 400_000 }, local: view({ halved: 1, eta: { basis: 'measured', seconds: 1500, lowSeconds: 900, highSeconds: 2400, stable: false } }) })]), 'en');
    assert.doesNotMatch(text(html), han, `${state}: ${text(html).match(han.source + '.{0,30}')}`);
  }
  const live = text(render(jobs([job()]), 'en'));
  for (const phrase of [/Piece 3/, /This piece: pages 31–50 \(20 pages\)/, /Converting/, /Next piece: about 22 pages/, /About 25 min left/, /about 3\.1 sec a page/i, /first piece is the slowest/i]) assert.match(live, phrase);
  const silent = text(render(jobs([job({ liveness: { state: 'silent', at: ago(10), lastSignalAt: ago(400), silentForMs: 400_000 } })]), 'en'));
  assert.match(silent, /No response \(nothing new for 7 min\)/);
  assert.match(silent, /Stop[^.]*select the same PDF again[^.]*finished pieces are reused/i);
  const row = text(render(history([record()]), 'en'));
  assert.doesNotMatch(row, han);
  assert.match(row, /about 3\.1 sec a page/i);
  const route = text(render(h(MineruRoute, { file: { name: 'Book.pdf', size: 1e6 }, call, initialSettings: saved, initialLocal: states.ready, initialPlan: adaptivePlan, initialRoute: 'local' }), 'en'));
  assert.doesNotMatch(route, han);
  assert.match(route, /starts with 10 pages/i);
});
