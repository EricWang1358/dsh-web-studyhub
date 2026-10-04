import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 2, WP-M: one gate for "no model", one table of model failures, one note that shows them (#104 #105 #134).
const read = file => readFileSync(file, 'utf8');
const lacks = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} still has ${pattern}`); };
const has = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.match(text, pattern, `${file} lacks ${pattern}`); };
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as ModelSetupGate, gateTitle } from './ui/ModelSetupGate.jsx';
  export { default as ModelErrorNote } from './ui/ModelErrorNote.jsx';
  export { FAILURE_COPY, describeFailure, describeModelError } from './ui/generation-status.js';
  export { default as Generate } from './ui/Generate.jsx';
  export { default as Ingest } from './ui/Ingest.jsx';
  export { default as AiHelperNote } from './ui/AiHelperNote.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const noop = () => {};
const han = /[㐀-鿿]/;
const html = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };
const catalogue = {};
for (const name of readdirSync('ui/locales').filter(file => /^en(\..+)?\.json$/.test(file))) Object.assign(catalogue, JSON.parse(read(`ui/locales/${name}`)));

const SAMPLES = { 'rate-limit': '429 Too Many Requests: rate limit', quota: 'insufficient_quota', credential: '401 Unauthorized: invalid api key',
  timeout: 'request timed out', network: 'fetch failed', unavailable: '503 service unavailable' };

test('one failure table: a generation job and the learning flow say the same thing about the same failure (#105)', () => {
  m.setUiLanguage('zh');
  for (const [kind, raw] of Object.entries(SAMPLES)) {
    const job = m.describeFailure(raw), flow = m.describeModelError(raw);
    assert.equal(job.kind, kind);
    assert.equal(flow.kind, kind);
    assert.equal(job.title, flow.title, `${kind}: one title`);
    assert.equal(job.hint, flow.hint, `${kind}: one hint`);
    assert.equal(job.title, m.FAILURE_COPY[kind].title, kind);
    assert.equal(flow.detail, raw);
  }
  assert.equal(m.FAILURE_COPY.credential.action, 'settings');
  assert.equal(m.FAILURE_COPY.quota.action, 'settings');
  assert.equal(m.FAILURE_COPY['rate-limit'].action, 'retry');
  assert.equal(m.describeFailure('Quality gate failed').kind, 'quality', 'generation-only kinds are laid on top of the table');
  assert.equal(m.describeModelError('讲解过于简略').kind, 'unknown');
  for (const entry of Object.values(m.FAILURE_COPY)) for (const key of [entry.title, entry.hint]) assert.ok(catalogue[key], `English for: ${key}`);
});

test('each model failure title is written once (#105)', () => {
  const source = read('ui/generation-status.js');
  for (const entry of Object.values(m.FAILURE_COPY)) assert.equal(source.split(`'${entry.title}'`).length - 1, 1, entry.title);
  lacks('ui/generation-status.js', /模型当前限流|模型太久没有回应|连接模型失败/);
});

test('ModelErrorNote is an alert with the plain title, a fix and the raw text behind a Disclosure (#105)', () => {
  const rate = html(h(m.ModelErrorNote, { error: SAMPLES['rate-limit'], onRetry: noop, onSettings: noop }));
  assert.match(rate, /role="alert"/);
  assert.match(rate, /sh-inline--error/);
  assert.match(rate, /模型服务太忙了/);
  assert.match(rate, /sh-disclosure[^>]*>(?:(?!<\/details>).)*技术详情(?:(?!<\/details>).)*429 Too Many Requests: rate limit/s);
  assert.match(rate, />重试<\/button>/);
  assert.doesNotMatch(rate, />打开模型设置<\/button>/);
  const key = html(h(m.ModelErrorNote, { error: SAMPLES.credential, onRetry: noop, onSettings: noop }));
  assert.match(key, />打开模型设置<\/button>/, 'a key problem is fixed in the settings');
  assert.doesNotMatch(key, />重试<\/button>/);
  const bare = html(h(m.ModelErrorNote, { error: SAMPLES.credential }));
  assert.doesNotMatch(bare, /<button[^>]*sh-inline__action/, 'no action without a handler');
  const unknown = html(h(m.ModelErrorNote, { error: '讲解过于简略或过长' }));
  assert.match(unknown, /讲解过于简略或过长/);
  assert.doesNotMatch(unknown, /sh-disclosure/);
  const english = html(h(m.ModelErrorNote, { error: SAMPLES.network, onRetry: noop }), 'en');
  assert.doesNotMatch(english, han);
  assert.doesNotMatch(rate + key, /<details[^>]*wf-model-error|<code[^>]*wf-model/);
});

test('the learning flow and the helper notes show model errors through ModelErrorNote (#105)', () => {
  for (const file of ['ui/WorkflowScope.jsx', 'ui/WorkflowPortal.jsx', 'ui/WorkflowLesson.jsx']) lacks(file, /\bModelError\b/, /wf-model-error/);
  for (const file of ['ui/WorkflowPortal.jsx', 'ui/WorkflowLesson.jsx']) has(file, /ModelErrorNote/);
  has('ui/AiHelperNote.jsx', /ModelErrorNote|FAILURE_COPY|describeModelError/);
  lacks('ui/workflow-scope.css', /wf-model-error/);
});

test('ModelSetupGate: one copy table, three shapes (#104)', () => {
  const block = html(h(m.ModelSetupGate, { variant: 'block', feature: 'generate', model: { ready: false, reason: 'no-route' }, onOpenSettings: noop }));
  assert.match(block, /sh-setup/);
  assert.match(block, /先配置一个 AI 模型/);
  assert.match(block, /还没有选择用来出题的 AI 模型/);
  assert.match(block, /sh-btn--primary[^>]*>(?:<svg.*?<\/svg>)?打开模型设置/);
  const key = html(h(m.ModelSetupGate, { variant: 'block', feature: 'generate', model: { ready: false, reason: 'no-credential', label: 'DeepSeek V3' }, onOpenSettings: noop }));
  assert.match(key, /DeepSeek V3/);
  const inline = html(h(m.ModelSetupGate, { variant: 'inline', feature: 'ingest', model: { ready: false }, onOpenSettings: noop }));
  assert.match(inline, /sh-inline--warning/);
  assert.match(inline, /还没有可用的 AI 模型/);
  assert.match(inline, /录题需要模型整理题目/);
  assert.match(inline, />打开模型设置<\/button>/);
  const banner = html(h(m.ModelSetupGate, { variant: 'banner', feature: 'translate', model: { ready: false }, onOpenSettings: noop }));
  assert.match(banner, /sh-banner--warning/);
  assert.match(banner, /还没有可用的 AI 模型/);
  const grade = html(h(m.ModelSetupGate, { variant: 'block', feature: 'grade', model: { ready: false }, onOpenSettings: noop }));
  assert.match(grade, /批改需要模型/);
  assert.equal(html(h(m.ModelSetupGate, { variant: 'block', feature: 'generate', model: { ready: true }, onOpenSettings: noop })), '', 'nothing to gate when a model is ready');
  assert.doesNotMatch(html(h(m.ModelSetupGate, { variant: 'block', feature: 'generate', model: { ready: false }, onOpenSettings: noop }), 'en'), han);
  assert.doesNotMatch(html(h(m.ModelSetupGate, { variant: 'inline', feature: 'ingest', model: { ready: false } }), 'zh'), /<button/, 'no button without a handler');
  assert.equal(m.gateTitle('block'), '先配置一个 AI 模型');
  assert.equal(m.gateTitle('inline'), '还没有可用的 AI 模型');
});

test('the generate page without a model shows one gate, at the submit (#104)', () => {
  const data = { root: 'lib', decks: [], drafts: [], jobs: [], sources: [{ id: 'a', title: '索引笔记', text: '数据库索引加快查找。', courses: ['数据库'] }], modelReady: false,
    focus: { course: '数据库', courses: [{ name: '数据库' }] } };
  const out = html(h(m.Generate, { data, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop, genSource: 'files', setGenSource: noop,
    gen: { kind: 'mixed', count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '' }, setGen: noop, selectedSources: ['a'], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop }));
  assert.equal(out.split('先配置一个 AI 模型').length - 1, 1, 'one gate title');
  assert.doesNotMatch(out, /还没有可用的 AI 模型/);
  assert.doesNotMatch(out, /sh-banner/);
  assert.equal((out.match(/<section[^>]*class="sh-setup /g) || []).length, 1);
  assert.match(out, /data-tour="generate-submit"/);
  for (const file of ['ui/Generate.jsx', 'ui/Ingest.jsx', 'ui/DraftShortfall.jsx', 'ui/AiHelperNote.jsx'])
    lacks(file, /["'`]先配置一个 AI 模型["'`]|["'`]还没有可用的 AI 模型["'`]|["'`]没有可用模型/);
  has('ui/Generate.jsx', /ModelSetupGate/);
  has('ui/Ingest.jsx', /ModelSetupGate/);
});

test('the AI helper note says "no model" with the gate title (#104)', () => {
  m.setUiLanguage('zh');
  const out = html(h(m.AiHelperNote, { unavailable: { reason: 'no-model' }, fallback: '先用按章节做的路径', onSettings: noop }));
  assert.match(out, /还没有可用的 AI 模型。先用按章节做的路径。/);
  assert.match(out, /打开模型设置/);
});

test('recording questions suggests a neutral example, not the developer\'s own course (#134)', () => {
  const out = html(h(m.Ingest, { data: { decks: [], modelReady: true, focus: {} }, start: noop }));
  assert.doesNotMatch(out, /SWE5006/);
  assert.match(out, /placeholder="例如：数据结构 · 错题"/);
  assert.match(out, /placeholder="例如：数据结构 \/ 第 3 章"/);
  lacks('ui/Ingest.jsx', /SWE5006/);
  const english = html(h(m.Ingest, { data: { decks: [], modelReady: true, focus: {} }, start: noop }), 'en');
  assert.doesNotMatch(english, /SWE5006|[㐀-鿿]/);
  const gated = html(h(m.Ingest, { data: { decks: [], modelReady: false, focus: {} }, start: noop, onOpenSettings: noop }));
  assert.match(gated, /sh-inline--warning/);
  assert.match(gated, /录题需要模型整理题目/);
});
