import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The MinerU entry in the UI: the settings section (the one-click card itself: tests/mineru-install-ui.test.mjs), the import route panel, the job card,
   and the demoted desktop client. The cloud route was removed in 3.5.5: an old cloud job still renders, and nothing offers the cloud. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as MineruSettings } from './ui/MineruSettings.jsx';
  export { default as MineruRoute } from './ui/MineruRoute.jsx';
  export { PdfConvertJobs, PdfDetail } from './ui/PdfConvertJob.jsx';
  export { default as LargeDocumentCard, ConverterMain } from './ui/LargeDocumentCard.jsx';
  export { importDoneMessage, importOutcome } from './ui/ImportHub.jsx';
  export { uploadPdf, localEstimate, minutesOf, sizeLabel, pageRange } from './ui/mineru-flow.js';
  export { TOOLS } from './lib/large-documents.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { MineruSettings, MineruRoute, PdfConvertJobs, PdfDetail, LargeDocumentCard, importDoneMessage, importOutcome,
  uploadPdf, localEstimate, minutesOf, sizeLabel, pageRange, TOOLS, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const call = async () => ({});

const states = {
  missing: { state: 'not-installed', next: 'install', origin: null },
  needs: { state: 'needs-models', next: 'download-models', origin: 'search', tier: 'flash', modelsMbByTier: { basic: 800, standard: 2000 }, estimates: { basic: 1.6, standard: 2.5 } },
  stopped: { state: 'server-stopped', next: 'start-server', origin: 'search', tier: 'basic', version: '4.0.10', estimates: { basic: 1.6, standard: 2.5 } },
  unknown: { state: 'unknown', next: 'recheck', origin: 'search', version: '4.0.10', running: true },
  ready: { state: 'ready', next: null, origin: 'search', exe: '/usr/local/bin/mineru', tier: 'basic', version: '4.0.10', estimates: { basic: 1.6, standard: 2.5 }, windowPages: 50 },
};
const plan = { name: 'Book.pdf', pages: 450, bytes: 12 * 1024 * 1024,
  windows: Array.from({ length: 9 }, (_, i) => ({ index: i + 1, startPage: i * 50 + 1, endPage: Math.min(450, i * 50 + 50), pages: 50 })) };
const file = { name: 'Book.pdf', size: 12 * 1024 * 1024 };

/* ---------- settings ---------- */

test('settings: one section for MinerU on this computer, with the one-click card and nothing of the removed cloud route', () => {
  const html = render(h(MineruSettings, { call, initialLocal: states.missing }));
  assert.match(html, /PDF 转换（MinerU）/);
  assert.match(html, /不上传任何内容。/);
  assert.match(html, /class="mineru-install"/);
  assert.match(html, /未安装/);
  assert.doesNotMatch(html, /type="password"|type="checkbox"|令牌无效|mineru\.net\/apiManage|云端|uv tool install/, 'no token, no consent, no terminal command');
  const ready = render(h(MineruSettings, { call, initialLocal: states.ready }));
  assert.match(ready, /可以用了/);
  assert.match(ready, /你自己安装的/, 'a MinerU found on the PATH says it is the learner\'s own');
});

/* ---------- the import route panel ---------- */

test('local ready: the plan, an estimate labelled as one, and no privacy checkbox, no cloud route to choose from', () => {
  const html = render(h(MineruRoute, { file, call, initialLocal: states.ready, initialPlan: plan }));
  assert.doesNotMatch(html, /name="mineru-route"|云端|暂不可用/);
  assert.match(html, /这本书会分 9 段处理/);
  assert.match(html, /每 50 页一段/);
  assert.match(html, /约 12 分钟（估算：每页约 1\.6 秒/);
  assert.match(html, /开始本地解析/);
  assert.match(html, /本地解析：不会上传任何内容。/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.match(html, /<button[^>]*class="sh-btn sh-btn--primary[^"]*"[^>]*>(?:(?!<\/button>).)*开始本地解析/s);
  assert.doesNotMatch(html, /disabled=""[^>]*>(?:(?!<\/button>).)*开始本地解析/s, 'the start button is enabled');
});

test('MinerU not installed: the one-click card is right here (no trip to Settings), and the start waits for it', () => {
  for (const local of [states.missing, states.needs]) {
    const html = render(h(MineruRoute, { file, call, initialLocal: local, initialPlan: plan, onOpenSettings() {} }));
    assert.doesNotMatch(html, /name="mineru-route"/);
    assert.match(html, /disabled=""[^>]*>(?:(?!<\/button>).)*开始本地解析/s);
    assert.doesNotMatch(html, /type="checkbox"|type="password"/);
    assert.match(html, /class="mineru-install mineru-install--compact"/);
    assert.match(html, /一键安装/);
    assert.match(html, /更多选项/, 'the compact card links to the options in Settings');
    assert.doesNotMatch(html, /先在设置里准备本机 MinerU|前往设置|uv tool install|下载模型并启用本地解析/);
  }
});

test('MinerU installed with its service stopped: the start stays on, and says the conversion starts the service', () => {
  const html = render(h(MineruRoute, { file, call, initialLocal: states.stopped, initialPlan: plan }));
  assert.doesNotMatch(html, /disabled=""[^>]*>(?:(?!<\/button>).)*开始本地解析/s);
  assert.match(html, /本机服务没在运行，开始解析时会先自动启动（约 1 分钟）。/);
  assert.doesNotMatch(html, /class="mineru-install/, 'no install card for an installed MinerU');
});

test('without a file the entry offers a PDF picker and peer converters without manual instructions', () => {
  const html = render(h(MineruRoute, { call, onFile() {}, initialLocal: states.ready }));
  assert.match(html, /选择 PDF…/);
  assert.match(html, /type="file" accept="\.pdf,application\/pdf"/);
  assert.match(html, /value="mineru"/); assert.match(html, /value="marker"/);
  assert.doesNotMatch(html, /高级：桌面客户端和命令行|--pages|mineru.net\/client/);
});

/* ---------- the job card ---------- */

const job = (extra = {}) => ({ id: 'j1', type: 'pdf-convert', route: 'local', filename: 'Book.pdf', status: 'running', phase: 'local', done: 260, total: 450, chunk: { index: 2, count: 3 },
  chunks: [{ index: 1, startPage: 1, endPage: 200, pages: 200, state: 'done' }, { index: 2, startPage: 201, endPage: 400, pages: 200, state: 'parsing' }, { index: 3, startPage: 401, endPage: 450, pages: 50, state: 'planned' }],
  stage: '第 2/3 段 · 本地解析', warnings: [], note: '', startedAt: new Date(Date.now() - 90_000).toISOString(), ...extra });
// The card on a page and, beside it, the detail the 任务 console shows (the environment, the window in hand, the windows): what a job says in all.
const jobs = (list, expandChunks) => h(React.Fragment, null, h(PdfConvertJobs, { jobs: list, call, onOpenSources() {}, onOpenSettings() {} }),
  ...list.filter(item => item.type === 'pdf-convert').map(item => h(PdfDetail, { key: item.id, job: item, expandChunks })));

test('a running conversion: real progress (pages over pages), which piece of N, the phase, and a stop button; no fake percentage', () => {
  const html = render(jobs([job()]));
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="58"/);
  assert.match(html, /260\/450 页完成/);
  assert.match(html, /第 1 段 · 第 1–200 页/, 'the windows are in the console detail');
  assert.match(html, />停止</);
  assert.equal((html.match(/class="cjc"/g) || []).length, 1, 'one compact card');
  assert.match(html, /不是卡住了/);
  const starting = render(jobs([job({ phase: 'start-service', stage: '正在启动本机 MinerU 服务（第一次约 1 分钟）', done: 0 })]));
  assert.match(starting, /启动本机服务/, 'a stopped service being started by the run says so');
});

test('a failed conversion offers to continue without redoing finished pieces; a stopped service is started by that same 接着做; an old cloud job cannot continue', () => {
  const failed = render(jobs([job({ status: 'failed', retryable: true, stage: '本地解析没有完成（已完成的段落会保留）。', errorCode: 'window-failed' })]));
  assert.match(failed, /本地解析没有完成/);
  assert.match(failed, />接着做</);
  assert.match(failed, />归档</);
  const stopped = render(jobs([job({ status: 'failed', retryable: true, errorCode: 'server-stopped', stage: '本机 MinerU 服务没有在运行，或解析到一半停了。点「接着做」会先启动服务，再从停下的那一段接着解析（已完成的段落会保留）。' })]));
  assert.match(stopped, />接着做</);
  assert.doesNotMatch(stopped, /重新启动本地服务并接着做/);
  const cloud = render(jobs([job({ route: 'cloud', status: 'failed', retryable: false, errorCode: 'cloud-removed', stage: '云端解析已停用；请重新选择这份 PDF 用本机解析。' })]));
  assert.match(cloud, /云端解析已停用/);
  assert.doesNotMatch(cloud, />接着做<|去设置里换一个令牌/, 'nothing to retry and no token to replace');
});

test('a finished conversion says how many pages were saved and opens them; other job types are not drawn', () => {
  const html = render(jobs([job({ status: 'complete', phase: 'done', done: 450, sourceIds: Array.from({ length: 450 }, (_, i) => `s${i}`), finishedAt: new Date().toISOString() }), { id: 'a', type: 'audio-import', filename: 'x.mp3', status: 'running' }]));
  assert.match(html, /已存为 450 份资料/);
  assert.match(html, /打开资料/);
  assert.doesNotMatch(html, /x\.mp3/);
  assert.equal(render(jobs([])), '');
});

/* ---------- the large-document card and the import hub ---------- */

test('the 大教材建议 card leads with the one-click local MinerU; the desktop client is only under 高级', () => {
  const html = render(h(LargeDocumentCard, { reason: 'pdf-pages', detail: { name: '操作系统.pdf' }, retrieval: null }));
  assert.match(html, /data-tool="mineru-local"/);
  const local = html.indexOf('data-tool="mineru-local"'), client = html.indexOf('data-tool="mineru"'), advanced = html.indexOf('large-doc__advanced');
  assert.ok(local > 0 && advanced > local, 'the local MinerU comes first');
  assert.ok(client > advanced, 'the desktop client / command line card sits under the advanced disclosure');
  assert.doesNotMatch(html.slice(0, advanced), /mineru\.net\/client/, 'no desktop-client link outside 高级');
  assert.doesNotMatch(html, /下载并安装 MinerU 客户端/);
  assert.match(html, /一键安装/);
  assert.doesNotMatch(html, /云端/);
  assert.match(html, /<span class="sh-badge[^"]*"[^>]*data-tone="info"[^>]*>推荐<\/span>/);
});

test('the catalogue recommends the one-click local MinerU and Docling; the desktop client is kept without a recommendation; there is no cloud entry', () => {
  const converters = TOOLS.filter(tool => tool.role === 'converter');
  assert.deepEqual(converters.filter(tool => tool.recommended).map(tool => tool.id), ['mineru-local', 'docling']);
  assert.equal(TOOLS.find(tool => tool.id === 'mineru-local').needs, 'one-click');
  assert.equal(TOOLS.find(tool => tool.id === 'mineru-cloud'), undefined);
  const desktop = TOOLS.find(tool => tool.id === 'mineru');
  assert.equal(desktop.recommended, false);
  assert.ok(desktop.channels.some(channel => channel.url === 'https://mineru.net/client'));
});

test('the import hub reports a started conversion in words and goes to the Sources page', () => {
  const summary = { done: 1, failed: 0, documents: [], decks: [], subtitles: [], sourceIds: [], conversions: [{ name: 'Book.pdf', pages: 450, route: 'local', jobId: 'j' }] };
  assert.equal(importDoneMessage(summary), '「Book.pdf」正在后台用 MinerU 解析（450 页），进度在资料页');
  const marker = { ...summary.conversions[0], converter: 'marker' };
  assert.match(importDoneMessage({ ...summary, conversions: [marker] }), /用 Marker 解析/);
  assert.equal(importDoneMessage({ ...summary, conversions: [marker, summary.conversions[0]] }), '2 份 PDF 正在后台解析，进度在资料页');
  assert.equal(importOutcome(summary).page, 'sources');
  assert.match(importOutcome(summary).notice.text, /进度在资料页/);
  assert.equal(importDoneMessage({ ...summary, conversions: [summary.conversions[0], summary.conversions[0]] }), '2 份 PDF 正在后台用 MinerU 解析，进度在资料页');
});

/* ---------- reading the file ---------- */

test('uploadPdf hands the file over in pieces, reports progress, and cancels the upload when something fails', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 123, 7);
  const upload = { name: 'Book.pdf', size: bytes.length, arrayBuffer: async () => bytes.buffer, slice: (from, to) => ({ arrayBuffer: async () => bytes.subarray(from, to) }) };
  const calls = [], progress = [];
  const ok = async (action, args) => { calls.push([action, args]); return action === 'mineru.upload.start' ? { uploadId: 'u1', chunkBytes: 3 * 1024 * 1024 } : {}; };
  const id = await uploadPdf(ok, upload, { onProgress: value => progress.push(value) });
  assert.equal(id, 'u1');
  assert.deepEqual(calls.map(([action]) => action), ['mineru.upload.start', 'mineru.upload.chunk', 'mineru.upload.chunk', 'mineru.upload.chunk', 'mineru.upload.finish']);
  assert.deepEqual(calls.filter(([action]) => action === 'mineru.upload.chunk').map(([, args]) => args.offset), [0, 2 * 1024 * 1024, 4 * 1024 * 1024]);
  const rebuilt = Buffer.concat(calls.filter(([action]) => action === 'mineru.upload.chunk').map(([, args]) => Buffer.from(args.data, 'base64')));
  assert.equal(Buffer.compare(rebuilt, bytes), 0, 'every byte arrives once, in order');
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
  const failing = []; let seen = 0;
  const broken = async (action, args) => { failing.push(action); if (action === 'mineru.upload.chunk' && ++seen === 2) throw new Error('disk full'); return action === 'mineru.upload.start' ? { uploadId: 'u2', chunkBytes: 3 * 1024 * 1024 } : {}; };
  await assert.rejects(uploadPdf(broken, upload), /disk full/);
  assert.equal(failing.at(-1), 'mineru.upload.cancel', 'a half-read upload does not stay behind');
});

test('small helpers: minutes are never zero, sizes read naturally, page ranges are compact', () => {
  assert.equal(minutesOf(20), 1);
  assert.equal(minutesOf(192), 3);
  assert.equal(localEstimate(120, 'basic', { basic: 1.6 }), 192);
  assert.equal(localEstimate(120, 'standard', {}), null);
  assert.equal(sizeLabel(800), '800 MB');
  assert.equal(sizeLabel(1200), '1.2 GB');
  assert.equal(sizeLabel(4.25), '4.3 MB');
  assert.equal(pageRange(1, 200), '1–200');
  assert.equal(pageRange(7, 7), '7');
});

/* ---------- English ---------- */

test('English: no Chinese in any state of settings, the route panel, the job card or the large-document card', () => {
  const everything = [
    h(MineruSettings, { call, initialLocal: states.missing }), h(MineruSettings, { call, initialLocal: states.ready }),
    h(MineruSettings, { call, initialLocal: states.needs }), h(MineruSettings, { call, initialLocal: states.stopped }), h(MineruSettings, { call, initialLocal: states.unknown }),
    h(MineruRoute, { call, onFile() {}, initialLocal: states.missing }),
    h(MineruRoute, { file, call, initialLocal: states.missing, initialPlan: plan, onOpenSettings() {} }),
    h(MineruRoute, { file, call, initialLocal: states.needs, initialPlan: plan }),
    h(MineruRoute, { file, call, initialLocal: states.stopped, initialPlan: plan }),
    h(MineruRoute, { file, call, initialLocal: states.ready, initialPlan: plan }),
    h(MineruRoute, { file, call, initialLocal: states.ready, initialPlan: { ...plan, windows: [plan.windows[0]] } }),
    jobs([job(), job({ id: 'j2', phase: 'start-service', stage: '正在启动本机 MinerU 服务（第一次约 1 分钟）' }),
      job({ id: 'j3', status: 'failed', retryable: true, errorCode: 'server-stopped', stage: '本机 MinerU 服务没有在运行，或解析到一半停了。点「接着做」会先启动服务，再从停下的那一段接着解析（已完成的段落会保留）。' }),
      job({ id: 'j4', route: 'cloud', status: 'failed', retryable: false, errorCode: 'cloud-removed', stage: '云端解析已停用；请重新选择这份 PDF 用本机解析。' }),
      job({ id: 'j5', status: 'cancelled', stage: '已取消；已解析好的段落会保留，再导入同一个文件不会重复解析' }),
      job({ id: 'j6', status: 'complete', phase: 'done', sourceIds: ['a'], warnings: ['本地解析可能把页眉、页脚和页码也留在了正文里；它们没有被删除。'] })]),
    h(LargeDocumentCard, { reason: 'pdf-size', detail: { name: 'book.pdf' }, retrieval: null }),
    h(LargeDocumentCard, { reason: 'long-document', detail: { name: 'book.pdf', pages: 412 }, retrieval: null }),
  ];
  for (const element of everything) assert.doesNotMatch(render(element, 'en'), han);
  const english = render(h(MineruRoute, { file, call, initialLocal: states.needs, initialPlan: plan }), 'en');
  assert.match(english, /This book will be processed in 9 pieces/);
  assert.match(english, /Start local conversion/);
  assert.doesNotMatch(english, /cloud/i);
});
