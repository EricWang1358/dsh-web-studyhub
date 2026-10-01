import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* WP28b: the one-click path. The card and Settings lead with "安装检索扩展" and "为这门课建立检索索引";
   MinerU's desktop client is the first converter; command-line, Docker and hand-written configuration sit under 高级. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { default as LargeDocumentCard } from './ui/LargeDocumentCard.jsx';
  export { default as ExtensionsSettings } from './ui/ExtensionsSettings.jsx';
  export * from './ui/retrieval-extension-flow.js';
  export { TOOLS, EXTENSION } from './lib/large-documents.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { ExtensionPanel, LargeDocumentCard, ExtensionsSettings, runInstall, runUninstall, startIndex, indexProgress, TOOLS, EXTENSION, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const noop = () => {};
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const base = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [], companion: { id: 'x', running: false } };
const fresh = { ...base, extension: { canInstall: true, installed: false, enabled: false, desktop: false } };
const installed = { ...base, extension: { canInstall: true, installed: true, enabled: true, version: '2.1.1', desktop: false } };
const running = { ...installed, companion: { id: 'mcp:mcp__studyhub__query_documents', running: true }, hostCanSearch: true };
const plan = { course: '操作系统', pages: 48, toIndex: 48, unchanged: 0, toRemove: 0, chars: 24000, firstRun: true, modelMb: 90, canIndex: true };
const panel = (props, language) => render(h(ExtensionPanel, { call: noop, courses: ['操作系统', '数据库'], defaultCourse: '操作系统', ...props }), language);

/* ---------- the panel ---------- */

test('no host status yet: the panel says nothing rather than guessing', () => {
  assert.equal(panel({ status: null }), '');
});

test('a DSH that cannot install plugins is told so, with the hand-made route named', () => {
  const html = panel({ status: { ...base, extension: { canInstall: false, installed: false, enabled: false, desktop: false } } });
  assert.match(html, /不能在应用内安装/);
  assert.match(html, /高级：手动配置/);
  assert.doesNotMatch(html, /<button[^>]*>(?:<svg.*?<\/svg>)?安装检索扩展/);
});

test('not installed: one primary button, and an honest account of what it does', () => {
  const html = panel({ status: fresh });
  assert.match(html, /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?安装检索扩展/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1);
  assert.match(html, /不需要命令行/);
  assert.match(html, /组件/);
  assert.doesNotMatch(html, /为这门课建立检索索引/, 'there is nothing to index with until it is installed');
  assert.doesNotMatch(html, /cordis\.patch\.yml|npx|Docker/);
});

test('the approval dialog lists the build scripts DSH holds back and asks before allowing them', () => {
  const html = panel({ status: fresh, initialApproval: ['onnxruntime-node', 'sharp'] });
  assert.match(html, /role="dialog"|<dialog/);
  assert.match(html, /onnxruntime-node/);
  assert.match(html, /sharp/);
  assert.match(html, /允许并继续/);
  assert.match(html, /取消/);
});

test('installed but not started yet: says so and offers nothing to build with', () => {
  const html = panel({ status: installed });
  assert.match(html, /检索扩展已安装/);
  assert.match(html, /正在启动|重启/);
  assert.doesNotMatch(html, /为这门课建立检索索引/);
});

test('running: the index builder leads, naming the course, the first-run model download and the language caveat', () => {
  const html = panel({ status: running, initialPlan: plan });
  assert.match(html, /为这门课建立检索索引/);
  assert.match(html, /<select/);
  assert.match(html, /操作系统/);
  assert.match(html, /48 页/);
  assert.match(html, /首次需要下载约 90 MB 的检索模型/);
  assert.match(html, /主要针对英文/);
  assert.match(html, /sh-btn--primary/);
});

test('up to date: nothing to do is said, and the button is off', () => {
  const html = panel({ status: running, initialPlan: { ...plan, toIndex: 0, unchanged: 48, firstRun: false } });
  assert.match(html, /索引已是最新/);
  assert.doesNotMatch(html, /首次需要下载/);
  assert.match(html, /<button[^>]*disabled[^>]*>(?:<svg.*?<\/svg>)?为这门课建立检索索引/);
});

test('progress: the model preparation, then pages counted, with a way to stop', () => {
  const model = panel({ status: running, initialPlan: plan, initialRun: { status: 'running', stage: 'model', done: 0, total: 48, firstRun: true } });
  assert.match(model, /正在准备检索模型/);
  assert.match(model, /首次需要下载/);
  const indexing = panel({ status: running, initialPlan: plan, initialRun: { status: 'running', stage: 'indexing', done: 12, total: 48 } });
  assert.match(indexing, /<progress[^>]*value="12"[^>]*max="48"|<progress[^>]*max="48"[^>]*value="12"/);
  assert.match(indexing, /12 \/ 48/);
  assert.match(indexing, /停止/);
  assert.doesNotMatch(indexing, /为这门课建立检索索引/, 'one build at a time');
  assert.deepEqual(indexProgress({ status: 'running', stage: 'indexing', done: 12, total: 48 }).percent, 25);
  assert.equal(indexProgress({ status: 'running', stage: 'model', done: 0, total: 0 }).percent, 0);
});

test('finished, failed and stopped builds each say what happened', () => {
  const complete = panel({ status: running, initialPlan: { ...plan, toIndex: 0, unchanged: 48 }, initialRun: { status: 'complete', course: '操作系统', added: 48, removed: 0, unchanged: 0, failed: [], failedCount: 0, done: 48, total: 48 } });
  assert.match(complete, /已为「操作系统」建立索引/);
  assert.match(complete, /新增 48 页/);
  const failed = panel({ status: running, initialPlan: plan, initialRun: { status: 'failed', error: '没能下载检索模型（网络）', errorCode: 'retrieval-model-download' } });
  assert.match(failed, /没能下载检索模型/);
  assert.match(failed, /下载地址/);
  assert.match(failed, /重试|建立检索索引/);
  assert.match(panel({ status: running, initialPlan: plan, initialRun: { status: 'cancelled' } }), /已停止/);
  const partial = panel({ status: running, initialPlan: plan, initialRun: { status: 'complete', course: 'X', added: 40, removed: 0, unchanged: 0, failed: [{ id: 'a', message: 'parse' }], failedCount: 2 } });
  assert.match(partial, /2 页没能写入/);
});

test('the panel in English has no Chinese in its own text', () => {
  const states = [{ status: fresh }, { status: fresh, initialApproval: ['sharp'] }, { status: installed }, { status: running, initialPlan: plan },
    { status: running, initialPlan: plan, initialRun: { status: 'running', stage: 'model', done: 0, total: 5 } },
    { status: running, initialPlan: plan, initialRun: { status: 'failed', error: 'x', errorCode: 'retrieval-model-download' } },
    { status: { ...base, extension: { canInstall: false, installed: false, enabled: false, desktop: false } } }];
  for (const props of states) assert.doesNotMatch(panel({ ...props, courses: ['OS'], defaultCourse: 'OS' }, 'en'), han, JSON.stringify(props).slice(0, 80));
});

/* ---------- the flows behind the buttons ---------- */

const answers = values => { const calls = []; return { calls, call: async (action, args) => { calls.push([action, args]); const next = values.shift(); if (next instanceof Error) throw next; return next; } }; };

test('install: straight through, or via the approval step, or refused in words', async () => {
  const direct = answers([{ status: 'installed', restartRequired: false }, { ...running }]);
  assert.deepEqual(await runInstall(direct.call), { phase: 'installed', restartRequired: false, status: running });
  assert.deepEqual(direct.calls.map(entry => entry[0]), ['retrieval.extension.install', 'retrieval.status']);
  const approval = answers([{ status: 'needs-approval', pending: ['sharp'] }]);
  assert.deepEqual(await runInstall(approval.call), { phase: 'approval', pending: ['sharp'] });
  const approved = answers([{ status: 'installed', restartRequired: true }, installed]);
  assert.equal((await runInstall(approved.call, ['sharp'])).restartRequired, true);
  assert.deepEqual(approved.calls[0], ['retrieval.extension.install', { approvedBuilds: ['sharp'] }]);
  const refused = answers([new Error('网络不可用')]);
  assert.deepEqual(await runInstall(refused.call), { phase: 'error', message: '网络不可用' });
});

test('uninstall and start-index report their outcome without throwing', async () => {
  const removed = answers([{ status: 'removed' }, base]);
  assert.deepEqual(await runUninstall(removed.call), { phase: 'removed', status: base });
  assert.equal((await runUninstall(answers([new Error('x')]).call)).phase, 'error');
  const started = answers([{ status: 'running', total: 4 }]);
  assert.deepEqual(await startIndex(started.call, '操作系统'), { phase: 'started', run: { status: 'running', total: 4 } });
  assert.deepEqual(started.calls[0], ['retrieval.index.start', { course: '操作系统' }]);
  const failed = await startIndex(answers([Object.assign(new Error('还没有运行'), { code: 'retrieval-index-unavailable' })]).call, '');
  assert.deepEqual([failed.phase, failed.code], ['error', 'retrieval-index-unavailable']);
});

/* ---------- the card and Settings ---------- */

const card = (props, language) => render(h(LargeDocumentCard, { reason: 'selection', detail: { chars: 700000 }, retrieval: fresh, call: noop, courses: ['操作系统'], ...props }), language);
const at = (html, pattern) => html.search(pattern);

test('the card leads with the one-click route and the GUI converter; the rest is under 高级', () => {
  const html = card({ reason: 'pdf-size', detail: { name: 'book.pdf' } });
  assert.match(html, /下载并安装 MinerU 客户端/);
  assert.match(html, /导出/);
  assert.match(html, /拖回/);
  assert.match(html, /JSON/);
  assert.ok(at(html, /安装检索扩展/) > 0);
  const advanced = at(html, /高级：命令行与 Docker/);
  assert.ok(advanced > 0, 'a disclosure holds the harder routes');
  assert.ok(at(html, /MinerU/) < advanced, 'MinerU comes first');
  assert.ok(at(html, /安装检索扩展/) < advanced, 'the one-click install comes before the advanced part');
  for (const word of ['Docling', 'RAGFlow', 'mcp-local-rag']) assert.ok(at(html, new RegExp(word)) > advanced, `${word} is under 高级`);
  assert.match(html, /需要命令行/);
  assert.match(html, /需要 Docker/);
});

test('the configuration text is only ever behind 高级：手动配置', () => {
  const html = card({});
  const manual = at(html, /高级：手动配置/);
  assert.ok(manual > 0);
  assert.ok(at(html, /cordis\.patch\.yml/) > manual);
  assert.ok(at(html, /@deepseek-ai\/dsh-mcp-client/) > manual);
  assert.ok(at(html, /复制配置/) > manual);
  assert.equal((html.match(/cordis\.patch\.yml/g) || []).length, 1, 'mentioned once, in the manual section');
});

test('the card offers the install and the index builder where it is shown', () => {
  assert.match(card({ retrieval: fresh }), /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?安装检索扩展/);
  assert.match(card({ retrieval: running, initialPlan: plan }), /为这门课建立检索索引/);
  // Without a way to call the host (a static preview) there is no button to press: only the words.
  assert.doesNotMatch(card({ call: undefined, retrieval: fresh }), /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?安装检索扩展/);
});

test('while the extension runs but holds no index yet, the status line says it will be used once built', () => {
  assert.match(card({ retrieval: running, initialPlan: plan }), /检索扩展已就绪；建好索引后会自动用它挑选页面/);
  assert.doesNotMatch(card({ retrieval: running, initialPlan: plan }), /还没有选择/);
  assert.doesNotMatch(card({ retrieval: running, initialPlan: plan, courses: ['OS'] }, 'en'), han);
});

test('the card in English', () => {
  for (const reason of ['pdf-size', 'selection', 'long-document']) {
    const html = card({ reason, detail: { name: 'book.pdf', chars: 700000, pages: 400 }, courses: ['OS'] }, 'en');
    assert.doesNotMatch(html, han, reason);
    assert.match(html, /Install the search extension/);
  }
});

test('the catalogue says what each route needs', () => {
  const need = id => TOOLS.find(tool => tool.id === id).needs;
  assert.deepEqual([need('mineru'), need('docling'), need('ragflow'), need('mcp-local-rag')], ['download', 'command-line', 'docker', 'manual']);
  assert.equal(EXTENSION.package, '@ericwang1358/studyhub-retrieval');
});

test('Settings: the extension is the first thing in the section; the choice of other tools and the download address are under 高级', () => {
  const html = render(h(ExtensionsSettings, { initialStatus: fresh, call: noop, courses: ['操作系统'] }));
  assert.match(html, /<legend class="settings-section__title">扩展：文档转换与检索<\/legend>/);
  assert.ok(at(html, /安装检索扩展/) > 0);
  assert.ok(at(html, /安装检索扩展/) < at(html, /高级/));
  assert.match(html, /模型下载地址/);
  const withTool = render(h(ExtensionsSettings, { initialStatus: { ...fresh, hostCanSearch: true, providers: [{ id: 'mcp:mcp__rag__q', kind: 'mcp', label: 'q', server: 'rag' }] }, call: noop, courses: [] }));
  assert.ok(at(withTool, /<select/) > at(withTool, /高级/), 'the provider choice is an advanced setting');
  assert.doesNotMatch(render(h(ExtensionsSettings, { initialStatus: fresh, call: noop, courses: [] }), 'en'), han);
});
