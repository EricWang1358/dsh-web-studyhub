import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The MinerU entry in the UI: settings (token and local mineru), the import route panel, the job card, and the demoted desktop client. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as MineruSettings, LocalMineruPanel, MineruTokenForm, PrivacyConfirm, localSummary, privacyNote } from './ui/MineruSettings.jsx';
  export { default as MineruRoute } from './ui/MineruRoute.jsx';
  export { PdfConvertJobs } from './ui/PdfConvertJob.jsx';
  export { default as LargeDocumentCard, ConverterMain } from './ui/LargeDocumentCard.jsx';
  export { importDoneMessage, importOutcome } from './ui/ImportHub.jsx';
  export { chooseRoute, uploadPdf, localEstimate, minutesOf, sizeLabel, pageRange } from './ui/mineru-flow.js';
  export { TOOLS } from './lib/large-documents.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { MineruSettings, LocalMineruPanel, MineruTokenForm, PrivacyConfirm, MineruRoute, PdfConvertJobs, LargeDocumentCard, importDoneMessage, importOutcome,
  chooseRoute, uploadPdf, localEstimate, minutesOf, sizeLabel, pageRange, TOOLS, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const call = async () => ({});

const TOKEN = 'eyJ0eXBlIjoiSldUIn0.mineru_TOKEN_000000000000000001.sig-abc';
const unset = { token: { set: false, hint: '' }, acknowledged: false, docsUrl: 'https://mineru.net/apiManage/docs', settingsFile: 'C:\\Users\\a\\.dsh\\study\\mineru.json' };
const saved = { token: { set: true, hint: `••••${TOKEN.slice(-4)}`, source: 'file' }, acknowledged: true, docsUrl: unset.docsUrl };
const states = {
  missing: { state: 'not-installed', next: 'install' },
  needs: { state: 'needs-models', next: 'download-models', tier: 'flash', modelsMbByTier: { basic: 800, standard: 1200 }, estimates: { basic: 1.6, standard: 2.5 } },
  stopped: { state: 'server-stopped', next: 'start-server', tier: 'basic', version: '4.0.10', estimates: { basic: 1.6, standard: 2.5 } },
  // What the real CLI gives while its service is stopped: the version only, no settings (they live in the service).
  stoppedUnknown: { state: 'server-stopped', next: 'start-server', version: '4.0.10', running: false, tier: '', mode: '', modelsDownloaded: null },
  unknown: { state: 'unknown', next: 'recheck', version: '4.0.10', running: true },
  ready: { state: 'ready', next: null, tier: 'basic', version: '4.0.10', estimates: { basic: 1.6, standard: 2.5 }, windowPages: 50 },
};
const plan = { name: 'Book.pdf', pages: 450, bytes: 12 * 1024 * 1024, byChapters: false, maySplitFurther: false,
  pieces: [[1, 200], [201, 400], [401, 450]].map(([startPage, endPage], i) => ({ index: i + 1, startPage, endPage, pages: endPage - startPage + 1 })),
  windows: Array.from({ length: 9 }, (_, i) => ({ index: i + 1, startPage: i * 50 + 1, endPage: Math.min(450, i * 50 + 50), pages: 50 })), tokenSet: false, acknowledged: false };
const file = { name: 'Book.pdf', size: 12 * 1024 * 1024 };

/* ---------- which route leads ---------- */

test('local conversion or local setup leads in every state, including with a saved cloud token', () => {
  for (const local of [...Object.values(states), null]) {
    for (const settings of [saved, unset, null]) assert.equal(chooseRoute({ local, settings }), 'local');
  }
});

/* ---------- settings ---------- */

test('settings: where to create the token (the documentation page), a password field, and only the last four characters of a saved token', () => {
  const html = render(h(MineruSettings, { call, initialSettings: saved, initialLocal: states.ready }));
  assert.match(html, /href="https:\/\/mineru\.net\/apiManage\/docs"/);
  assert.match(html, /type="password"/);
  assert.match(html, new RegExp(`••••${TOKEN.slice(-4)}`));
  assert.ok(!html.includes(TOKEN) && !html.includes(TOKEN.slice(0, 24)), 'the token is never in the markup');
  assert.match(html, /保存并验证/);
  assert.match(html, />验证</, 'a saved token can be checked again');
  assert.match(html, /清除已保存的令牌/);
  assert.match(html, /目前免费/);
  assert.match(html, /文档会上传到 MinerU 的云端解析，目前不收费，规则可能变化/);
  assert.match(html, /本地解析不会上传任何内容/);
  assert.ok(html.indexOf('data-route="local"') < html.indexOf('data-route="cloud"'), 'local setup appears before cloud setup');
  assert.match(html, /云端暂不可用，优先使用本地模型/);
});

test('settings without a token: unconfigured, the check button is not offered, the privacy confirmation is unchecked', () => {
  const html = render(h(MineruSettings, { call, initialSettings: unset, initialLocal: states.missing }));
  assert.match(html, /未配置/);
  assert.doesNotMatch(html, />验证</);
  assert.match(html, /<input id="[^"]*" type="checkbox"(?![^>]*checked)/);
});

test('every state of the local mineru says one honest thing and offers one next step', () => {
  const panel = (status, extra = {}) => render(h(LocalMineruPanel, { call, status, onStatus() {}, ...extra }));
  assert.match(panel(states.missing), /没有找到本地 mineru/);
  assert.match(panel(states.missing), /uv tool install/);
  assert.match(panel(states.missing), /不会替你安装/);
  assert.doesNotMatch(panel(states.missing), /下载模型并启用/, 'nothing is installed or downloaded for the learner');
  const needs = panel(states.needs);
  assert.match(needs, /还没有下载并启用解析模型/);
  assert.match(needs, /basic/); assert.match(needs, /standard/);
  assert.match(needs, /800 MB/); assert.match(needs, /1\.2 GB/);
  assert.match(needs, /估算/);
  assert.match(needs, /下载模型并启用本地解析…/);
  assert.doesNotMatch(needs, /确认下载/, 'the download is a second, explicit step');
  assert.match(panel(states.needs, { initialConfirm: true }), /将下载约 800 MB/);
  assert.match(panel(states.needs, { initialConfirm: true }), /确认下载/);
  assert.match(panel(states.stopped), /启动本地服务/);
  for (const stopped of [states.stopped, states.stoppedUnknown]) {
    const html = panel(stopped);
    assert.match(html, /本地 mineru 已装好，服务没在运行/, 'says plainly it is installed and only the service is off');
    assert.match(html, />启动本地服务</, 'with the start button');
    assert.doesNotMatch(html, /还没有下载|下载模型并启用|name="mineru-tier"/, 'nothing about models: a stopped service cannot say');
  }
  const unknown = panel(states.unknown);
  assert.match(unknown, /读不出它的设置/);
  assert.match(unknown, />重新检测</);
  assert.doesNotMatch(unknown, /还没有下载|下载模型并启用|>启动本地服务</, 'an unreadable config is not "models missing"');
  assert.match(render(h(LocalMineruPanel, { call, status: states.stoppedUnknown, onStatus() {} }), 'en'), /already installed, but its service is not running/);
  assert.doesNotMatch(render(h(LocalMineruPanel, { call, status: states.unknown, onStatus() {} }), 'en'), han, 'the unreadable state has an English form');
  const ready = panel(states.ready);
  assert.match(ready, /本地 mineru 可用（basic 档 · v4\.0\.10）/);
  assert.match(ready, /重新启动本地服务/);
  assert.ok(!ready.includes('>启动本地服务<'), 'a running service is not offered to start');
});

test('a running setup shows what it is doing, the last line of output, and a way to cancel', () => {
  const running = { ...states.needs, setup: { status: 'running', step: 'download', tier: 'basic', modelsMb: 800, lastLine: '50% model.onnx', startedAt: new Date().toISOString() } };
  const html = render(h(LocalMineruPanel, { call, status: running, onStatus() {} }));
  assert.match(html, /正在下载模型/);
  assert.match(html, /50% model\.onnx/);
  assert.match(html, /没有精确的百分比/);
  assert.match(html, />取消</);
  assert.doesNotMatch(html, /下载模型并启用本地解析/);
});

test('the privacy confirmation is a checkbox with the plain sentence', () => {
  const html = render(h(PrivacyConfirm, { checked: false, onChange() {} }));
  assert.match(html, /type="checkbox"/);
  assert.match(html, /目前不收费，规则可能变化/);
});

/* ---------- the import route panel ---------- */

test('an explicitly chosen cloud route still shows its piece plan and both routes', () => {
  const html = render(h(MineruRoute, { file, call, initialSettings: saved, initialLocal: states.needs, initialPlan: plan, initialRoute: 'cloud' }));
  assert.match(html, /这本书会分 3 段处理/);
  assert.match(html, /共 450 页/);
  assert.match(html, /每 200 页切一段/);
  assert.match(html, /第 1 段 · 第 1–200 页/);
  assert.match(html, /第 3 段 · 第 401–450 页/);
  assert.match(html, /用 MinerU 云端解析/);
  assert.match(html, /本地 mineru/);
  assert.match(html, /文档会上传到 MinerU 的云端解析，目前不收费，规则可能变化/);
  assert.match(html, /开始云端解析/);
});

test('local ready: the local route is selected, with an estimate labelled as one, and no privacy checkbox is needed', () => {
  const html = render(h(MineruRoute, { file, call, initialSettings: unset, initialLocal: states.ready, initialPlan: plan }));
  assert.match(html, /name="mineru-route" checked="" value="local"/);
  assert.match(html, /这本书会分 9 段处理/);
  assert.match(html, /每 50 页一段/);
  assert.match(html, /约 12 分钟（估算：basic 档每页约 1\.6 秒/);
  assert.match(html, /开始本地解析/);
  assert.match(html, /不会上传任何内容，也不需要令牌/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.match(html, /<button[^>]*class="sh-btn sh-btn--primary[^"]*"[^>]*>(?:(?!<\/button>).)*开始本地解析/s);
  assert.doesNotMatch(html, /disabled=""[^>]*>(?:(?!<\/button>).)*开始本地解析/s, 'the start button is enabled');
});

test('an explicit cloud choice keeps the warning and one-time privacy confirmation, even when local is ready', () => {
  const html = render(h(MineruRoute, { file, call, initialSettings: { ...saved, acknowledged: false }, initialLocal: states.ready, initialPlan: plan, initialRoute: 'cloud' }));
  assert.match(html, /name="mineru-route" checked="" value="cloud"/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /同意用云端解析/);
  assert.match(html, /云端暂不可用，优先使用本地模型/);
  assert.match(html, /disabled=""[^>]*>(?:(?!<\/button>).)*开始云端解析/s, 'cannot start before confirming');
  const confirmed = render(h(MineruRoute, { file, call, initialSettings: saved, initialLocal: states.missing, initialPlan: plan, initialRoute: 'cloud' }));
  assert.match(confirmed, /已确认：文档会上传到 MinerU 的云端/);
  assert.doesNotMatch(confirmed, /disabled=""[^>]*>(?:(?!<\/button>).)*开始云端解析/s);
});

test('a saved token never bypasses local installation or model-download setup', () => {
  for (const local of [states.missing, states.needs, states.stopped]) {
    const html = render(h(MineruRoute, { file, call, initialSettings: saved, initialLocal: local, initialPlan: plan }));
    assert.match(html, /name="mineru-route" checked="" value="local"/);
    assert.match(html, /disabled=""[^>]*>(?:(?!<\/button>).)*开始本地解析/s);
    assert.doesNotMatch(html, /type="checkbox"|type="password"/);
    assert.match(html, /先在设置里准备本机 MinerU/);
    assert.doesNotMatch(html, /uv tool install|下载模型并启用本地解析/);
  }
});

test('explicitly choosing unconfigured cloud directs token setup to settings', () => {
  const html = render(h(MineruRoute, { file, call, initialSettings: unset, initialLocal: states.missing, initialPlan: plan, onOpenSettings() {}, initialRoute: 'cloud' }));
  assert.match(html, /先在设置里配置 MinerU 云端令牌/);
  assert.doesNotMatch(html, /type="password"|apiManage/);
  assert.match(html, /打开设置/);
  assert.match(html, /disabled=""[^>]*>(?:(?!<\/button>).)*开始云端解析/s);
});

test('without a file the entry offers a PDF picker and peer converters without manual instructions', () => {
  const html = render(h(MineruRoute, { call, onFile() {}, initialSettings: saved, initialLocal: states.ready }));
  assert.match(html, /选择 PDF…/);
  assert.match(html, /type="file" accept="\.pdf,application\/pdf"/);
  assert.match(html, /value="mineru"/); assert.match(html, /value="marker"/);
  assert.doesNotMatch(html, /高级：桌面客户端和命令行|--pages|mineru.net\/client/);
});

/* ---------- the job card ---------- */

const job = (extra = {}) => ({ id: 'j1', type: 'pdf-convert', route: 'cloud', filename: 'Book.pdf', status: 'running', phase: 'parse', done: 260, total: 450, chunk: { index: 2, count: 3 },
  chunks: [{ index: 1, startPage: 1, endPage: 200, pages: 200, state: 'done' }, { index: 2, startPage: 201, endPage: 400, pages: 200, state: 'parsing' }, { index: 3, startPage: 401, endPage: 450, pages: 50, state: 'planned' }],
  stage: '第 2/3 段 · 正在解析', warnings: [], note: '', startedAt: new Date(Date.now() - 90_000).toISOString(), ...extra });
const jobs = list => h(PdfConvertJobs, { jobs: list, call, onOpenSources() {}, onOpenSettings() {} });

test('a running conversion: real progress (pages over pages), which piece of N, the phase, and a stop button; no fake percentage', () => {
  const html = render(jobs([job()]));
  assert.match(html, /解析 · 第 2\/3 段/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="58"/);
  assert.match(html, /已解析 260\/450 页/);
  assert.match(html, /第 1 段 · 第 1–200 页/);
  assert.match(html, /停止（已解析好的段落会保留）/);
  const local = render(jobs([job({ route: 'local', phase: 'local', done: 100, chunk: { index: 3, count: 9 } })]));
  assert.match(local, /本地解析 · 第 3\/9 段/);
  assert.match(local, /不是卡住了/);
});

test('an honest slowdown note is shown, never as a failure', () => {
  const html = render(jobs([job({ note: 'MinerU 云端正在排队，比平时慢（可能是今天的高优先额度用完了）。这不是失败，会自动继续。' })]));
  assert.match(html, /这不是失败/);
  assert.doesNotMatch(html, /转换未完成/);
});

test('a failed conversion offers to continue without redoing finished pieces; a stopped local service restarts first; a bad token goes to settings', () => {
  const failed = render(jobs([job({ status: 'failed', retryable: true, phase: 'parse', stage: '连不上 MinerU：请检查网络后重试（已完成的部分会保留）。', errorCode: 'network' })]));
  assert.match(failed, /转换未完成/);
  assert.match(failed, /接着做（不重复已完成的段落）/);
  assert.match(failed, /知道了/);
  const stopped = render(jobs([job({ status: 'failed', retryable: true, route: 'local', errorCode: 'server-stopped', stage: '本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。' })]));
  assert.match(stopped, /重新启动本地服务并接着做/);
  const token = render(jobs([job({ status: 'failed', retryable: true, errorCode: 'invalid-token', stage: 'MinerU 令牌无效：请到「设置 › MinerU 云端解析」重新粘贴一个有效的令牌。' })]));
  assert.match(token, /去设置里换一个令牌/);
  assert.match(token, /换好令牌后接着做/);
  assert.doesNotMatch(token, /接着做（不重复已完成的段落）/);
});

test('a finished conversion says how many pages were saved and opens them; other job types are not drawn', () => {
  const html = render(jobs([job({ status: 'complete', phase: 'done', done: 450, sourceIds: Array.from({ length: 450 }, (_, i) => `s${i}`), finishedAt: new Date().toISOString() }), { id: 'a', type: 'audio-import', filename: 'x.mp3', status: 'running' }]));
  assert.match(html, /已存为 450 页资料 · 云端解析/);
  assert.match(html, /打开资料/);
  assert.doesNotMatch(html, /x\.mp3/);
  assert.equal(render(jobs([])), '');
});

/* ---------- the large-document card and the import hub ---------- */

test('the 大教材建议 card leads with local models; the desktop client is only under 高级', () => {
  const html = render(h(LargeDocumentCard, { reason: 'pdf-pages', detail: { name: '操作系统.pdf' }, retrieval: null }));
  assert.match(html, /data-tool="mineru-local"/);
  const local = html.indexOf('data-tool="mineru-local"'), client = html.indexOf('data-tool="mineru"'), advanced = html.indexOf('large-doc__advanced');
  assert.ok(local > 0 && advanced > local, 'local model setup comes first');
  assert.ok(client > advanced, 'the desktop client / command line card sits under the advanced disclosure');
  assert.doesNotMatch(html.slice(0, advanced), /mineru\.net\/client/, 'no desktop-client link outside 高级');
  assert.doesNotMatch(html, /下载并安装 MinerU 客户端/);
  assert.match(html, /云端暂不可用，优先使用本地模型/);
  assert.match(html, /<span class="sh-badge[^"]*"[^>]*data-tone="info"[^>]*>推荐<\/span>/);
});

test('the catalogue recommends local models and Docling; cloud and desktop are kept without a recommendation', () => {
  const converters = TOOLS.filter(tool => tool.role === 'converter');
  assert.deepEqual(converters.filter(tool => tool.recommended).map(tool => tool.id), ['mineru-local', 'docling']);
  assert.equal(TOOLS.find(tool => tool.id === 'mineru-cloud').recommended, false);
  const desktop = TOOLS.find(tool => tool.id === 'mineru');
  assert.equal(desktop.recommended, false);
  assert.ok(desktop.channels.some(channel => channel.url === 'https://mineru.net/client'));
  assert.equal(TOOLS.find(tool => tool.id === 'mineru-cloud').studyhubFormat, 'mineru-content-list');
  assert.equal(TOOLS.find(tool => tool.id === 'mineru-cloud').channels[0].url, 'https://mineru.net/apiManage/docs');
});

test('the import hub reports a started conversion in words and goes to the Sources page', () => {
  const summary = { done: 1, failed: 0, documents: [], decks: [], subtitles: [], sourceIds: [], conversions: [{ name: 'Book.pdf', pages: 450, route: 'cloud', jobId: 'j' }] };
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
    h(MineruSettings, { call, initialSettings: unset, initialLocal: states.missing }), h(MineruSettings, { call, initialSettings: saved, initialLocal: states.ready }),
    h(MineruSettings, { call, initialSettings: saved, initialLocal: states.needs }), h(MineruSettings, { call, initialSettings: saved, initialLocal: states.stopped }),
    h(LocalMineruPanel, { call, status: states.needs, onStatus() {}, initialConfirm: true }),
    h(LocalMineruPanel, { call, status: { ...states.needs, setup: { status: 'running', step: 'configure', modelsMb: 800, lastLine: 'x', startedAt: new Date().toISOString() } }, onStatus() {} }),
    h(MineruTokenForm, { call, settings: saved, initialResult: { ok: false, state: 'invalid' } }), h(MineruTokenForm, { call, settings: unset, initialResult: { ok: true, state: 'valid' } }),
    h(MineruTokenForm, { call, settings: unset, initialResult: { ok: false, state: 'unreachable' } }),
    h(MineruRoute, { call, onFile() {}, initialSettings: unset, initialLocal: states.missing }),
    h(MineruRoute, { file, call, initialSettings: unset, initialLocal: states.missing, initialPlan: plan, onOpenSettings() {} }),
    h(MineruRoute, { file, call, initialSettings: { ...saved, acknowledged: false }, initialLocal: states.needs, initialPlan: plan }),
    h(MineruRoute, { file, call, initialSettings: saved, initialLocal: states.ready, initialPlan: plan }),
    h(MineruRoute, { file, call, initialSettings: saved, initialLocal: states.ready, initialPlan: { ...plan, pieces: [plan.pieces[0]], windows: [plan.windows[0]] } }),
    jobs([job(), job({ id: 'j2', route: 'local', phase: 'local', note: 'MinerU 请求太频繁，正在等一会儿再继续（不是失败）。' }), job({ id: 'j3', status: 'failed', retryable: true, errorCode: 'server-stopped', route: 'local', stage: '本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。' }),
      job({ id: 'j4', status: 'failed', retryable: true, errorCode: 'invalid-token', stage: 'MinerU 令牌无效：请到「设置 › MinerU 云端解析」重新粘贴一个有效的令牌。' }),
      job({ id: 'j5', status: 'cancelled', stage: '已取消；已解析好的段落会保留，再导入同一个文件不会重复解析' }),
      job({ id: 'j6', status: 'complete', phase: 'done', sourceIds: ['a'], warnings: ['本地解析可能把页眉、页脚和页码也留在了正文里；它们没有被删除。'] })]),
    h(LargeDocumentCard, { reason: 'pdf-size', detail: { name: 'book.pdf' }, retrieval: null }),
    h(LargeDocumentCard, { reason: 'long-document', detail: { name: 'book.pdf', pages: 412 }, retrieval: null }),
  ];
  for (const element of everything) assert.doesNotMatch(render(element, 'en'), han);
  const english = render(h(MineruRoute, { file, call, initialSettings: { ...saved, acknowledged: false }, initialLocal: states.needs, initialPlan: plan, initialRoute: 'cloud' }), 'en');
  assert.match(english, /This book will be processed in 3 pieces/);
  assert.match(english, /Use MinerU cloud conversion/);
  assert.match(english, /free at the moment; the rules may change/);
});
