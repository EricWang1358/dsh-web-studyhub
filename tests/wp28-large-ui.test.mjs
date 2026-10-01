import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* WP28: the "大教材建议" card, the Settings section and the import hub's reaction to a file that is too large. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as LargeDocumentCard } from './ui/LargeDocumentCard.jsx';
  export { default as ExtensionsSettings, providerLabel } from './ui/ExtensionsSettings.jsx';
  export { runImport, importSummary, importAccept, routeImportFile } from './ui/ImportHub.jsx';
  export { generateAdvice } from './ui/large-document-advice.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { LargeDocumentCard, ExtensionsSettings, providerLabel, runImport, generateAdvice, importAccept, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const none = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [] };
const found = { selected: 'builtin', effective: 'builtin', hostCanSearch: true, otherTools: [],
  providers: [{ id: 'mcp:mcp__rag__query_documents', kind: 'mcp', label: 'query_documents', tool: 'mcp__rag__query_documents', server: 'rag', description: 'Semantic search' }] };
const active = { ...found, selected: 'mcp:mcp__rag__query_documents', effective: 'mcp:mcp__rag__query_documents' };

/* ---------- the card ---------- */

test('too-large PDF: a calm card with the recommended converters, download channels incl. mainland ones, and the steps', () => {
  const html = render(h(LargeDocumentCard, { reason: 'pdf-size', detail: { name: '操作系统.pdf' }, retrieval: none }));
  assert.match(html, /大教材建议/);
  assert.match(html, /操作系统\.pdf/);
  assert.match(html, /8 MB/);
  for (const name of ['MinerU', 'Docling']) assert.match(html, new RegExp(name));
  assert.match(html, /href="https:\/\/mineru\.net\/client"/);
  assert.match(html, /href="https:\/\/www\.modelscope\.cn\/organization\/OpenDataLab"/);
  assert.match(html, /国内可用/);
  assert.match(html, /MIT/);
  assert.match(html, /rel="noreferrer"/);
  assert.equal((html.match(/<li class="large-doc__step"/g) || []).length, 4, 'convert, import the result, choose chapters, optional retrieval');
  assert.doesNotMatch(html, /已安装|已检测到.*MinerU/, 'never claims a tool is installed');
  assert.match(html, /没有检测到检索工具/);
  assert.doesNotMatch(html, /<button(?![^>]*class="sh-)[^>]*>/, 'shared buttons only');
});

test('each trigger has its own reason in words', () => {
  const text = reason => render(h(LargeDocumentCard, { reason, detail: { name: 'book.pdf', chars: 812345, pages: 412 }, retrieval: none }));
  assert.match(text('pdf-pages'), /200 页/);
  assert.match(text('text-chars'), /60 万字/);
  assert.match(text('selection'), /812,345/);
  assert.match(text('selection'), /按章节/);
  assert.match(text('long-document'), /412 页/);
  assert.match(text('long-document'), /book\.pdf/);
});

test('the retrieval tools and a copyable DSH configuration are offered for the reasons that need them', () => {
  const selection = render(h(LargeDocumentCard, { reason: 'selection', detail: { chars: 700000 }, retrieval: none }));
  assert.match(selection, /mcp-local-rag/);
  assert.match(selection, /RAGFlow/);
  assert.match(selection, /@deepseek-ai\/dsh-mcp-client/);
  assert.match(selection, /cordis\.patch\.yml/);
  assert.match(selection, /npmmirror/);
  assert.match(selection, /复制配置/);
  const pdf = render(h(LargeDocumentCard, { reason: 'pdf-size', retrieval: none }));
  assert.match(pdf, /mcp-local-rag/, 'retrieval is part of the way to use a big book, shown behind a disclosure');
});

test('a detected tool is named, and "enabled" is only said when the learner chose one', () => {
  assert.match(render(h(LargeDocumentCard, { reason: 'selection', detail: { chars: 700000 }, retrieval: found })), /检测到 1 个检索工具，还没有选择/);
  const enabled = render(h(LargeDocumentCard, { reason: 'selection', detail: { chars: 700000 }, retrieval: active }));
  assert.match(enabled, /已启用检索/);
  assert.match(enabled, /query_documents/);
});

test('the card in English has no Chinese in its own text', () => {
  for (const reason of ['pdf-size', 'pdf-pages', 'text-chars', 'selection', 'long-document']) {
    const html = render(h(LargeDocumentCard, { reason, detail: { name: 'book.pdf', chars: 700000, pages: 412 }, retrieval: found }), 'en');
    assert.doesNotMatch(html, han, reason);
    assert.match(html, /Large textbooks|large textbook/i);
  }
});

test('the card can open the settings section', () => {
  const html = render(h(LargeDocumentCard, { reason: 'selection', detail: { chars: 700000 }, retrieval: found, onOpenSettings() {} }));
  assert.match(html, /打开检索设置/);
});

/* ---------- Settings section ---------- */

test('Settings lists what DSH exposes and recommends the rest, without claiming anything is installed', () => {
  const empty = render(h(ExtensionsSettings, { initialStatus: none, call() {} }));
  assert.match(empty, /<legend class="settings-section__title">扩展：文档转换与检索<\/legend>/);
  assert.match(empty, /没有检测到检索工具/);
  assert.match(empty, /MinerU/);
  assert.doesNotMatch(empty, /<select/);
  const withTool = render(h(ExtensionsSettings, { initialStatus: found, call() {} }));
  assert.match(withTool, /query_documents/);
  assert.match(withTool, /<select/);
  assert.match(withTool, /不使用检索/);
  assert.match(withTool, /测试/);
  assert.doesNotMatch(render(h(ExtensionsSettings, { initialStatus: active, call() {} })), /没有检测到检索工具/);
  assert.match(render(h(ExtensionsSettings, { initialStatus: active, call() {} })), /已启用/);
  const missing = render(h(ExtensionsSettings, { initialStatus: { ...none, selected: 'mcp:mcp__gone__search', missing: 'mcp:mcp__gone__search' }, call() {} }));
  assert.match(missing, /mcp__gone__search/);
  assert.match(missing, /找不到/);
});

test('Settings section in English', () => {
  for (const status of [none, found, active]) assert.doesNotMatch(render(h(ExtensionsSettings, { initialStatus: status, call() {} }), 'en'), han);
  assert.equal(providerLabel({ kind: 'mcp', label: 'query_documents', server: 'rag' }), 'query_documents（rag）');
  assert.equal(providerLabel({ kind: 'service', label: 'studyRetrieval' }), 'studyRetrieval');
});

/* ---------- what Generate does with a big selection ---------- */

test('Generate advice: blocked over the limit without a provider, narrowed with one, never blocked below it', () => {
  const sources = [{ id: 'a', chars: 400000 }, { id: 'b', chars: 400000 }, { id: 'c', chars: 100000 }];
  assert.deepEqual(generateAdvice({ sources, selectedIds: ['a'], focus: '', retrieval: none }), { chars: 400000, tooBig: false, willRetrieve: false, needsTopic: false, blocked: false, reason: null });
  assert.deepEqual(generateAdvice({ sources, selectedIds: ['a', 'b'], focus: '', retrieval: none }), { chars: 800000, tooBig: true, willRetrieve: false, needsTopic: false, blocked: true, reason: 'selection' });
  const withProvider = generateAdvice({ sources, selectedIds: ['a', 'b'], focus: '', retrieval: active });
  assert.equal(withProvider.blocked, true);
  assert.equal(withProvider.needsTopic, true);
  const withTopic = generateAdvice({ sources, selectedIds: ['a', 'b'], focus: '死锁', retrieval: active });
  assert.equal(withTopic.blocked, false);
  assert.equal(withTopic.willRetrieve, true);
  assert.equal(generateAdvice({ sources, selectedIds: ['a', 'c'], focus: '', retrieval: active }).willRetrieve, true, 'above 150,000 characters a chosen provider narrows');
  assert.equal(generateAdvice({ sources: [{ id: 'x', chars: 100000 }], selectedIds: ['x'], focus: '', retrieval: active }).willRetrieve, false);
  assert.equal(generateAdvice({ sources, selectedIds: [], focus: '', retrieval: active }).blocked, false);
});

/* ---------- import hub ---------- */

test('an oversized file fails with a flag the hub turns into the card', async () => {
  const big = { name: 'big.pdf', size: 9 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
  const results = await runImport([big], { call: async () => { throw new Error('should not be called'); } });
  assert.equal(results[0].status, 'error');
  assert.equal(results[0].large, 'pdf-size');
  const pages = await runImport([{ name: 'long.pdf', size: 1000, arrayBuffer: async () => new ArrayBuffer(8), text: async () => '' }],
    { call: async () => { throw new Error('PDF 超过 200 页，请先按章节拆分'); } });
  assert.equal(pages[0].large, 'pdf-pages');
  const other = await runImport([{ name: 'a.txt', size: 5, arrayBuffer: async () => new ArrayBuffer(1), text: async () => '' }], { call: async () => { throw new Error('Text documents must use UTF-8 encoding'); } });
  assert.equal(other[0].large, undefined);
});

test('converter JSON dropped on the hub is imported as one document, not as a question deck', async () => {
  const content = JSON.stringify([{ type: 'text', text: '概率论', text_level: 1, page_idx: 0 }, { type: 'text', text: '概率是度量。', page_idx: 0 }]);
  const calls = [];
  const file = { name: 'content_list.json', size: content.length, arrayBuffer: async () => new TextEncoder().encode(content).buffer, text: async () => content };
  const results = await runImport([file], { call: async (action, args) => { calls.push([action, args.filename]); return { documentId: 'd', sourceIds: ['p1', 'p2'], document: { title: '概率论', format: 'pdf', sources: [{ document: { converter: 'mineru' } }] } }; } });
  assert.deepEqual(calls, [['materials.document.import', 'content_list.json']]);
  assert.equal(results[0].status, 'done');
  assert.equal(results[0].result.kind, 'document');
  assert.equal(results[0].result.converted, 'mineru');
  assert.equal(importSummaryOf(results).sourceIds.length, 2);
  // A question deck in the same slot still goes the deck way.
  const deckText = JSON.stringify({ title: 'deck', cards: [{ prompt: 'q', answer: 'a' }] });
  const deckCalls = [];
  await runImport([{ name: 'deck.json', size: deckText.length, arrayBuffer: async () => new TextEncoder().encode(deckText).buffer, text: async () => deckText }],
    { call: async (action) => { deckCalls.push(action); return action === 'draft.import.propose' ? { title: 'deck' } : { title: 'deck', cards: [] }; } });
  assert.deepEqual(deckCalls, ['draft.import.propose', 'draft.import']);
});
const importSummaryOf = results => module.exports.importSummary(results);

test('the drop zone and its hint say converter output is welcome', () => {
  assert.ok(importAccept().includes('.json') && importAccept().includes('.md'));
});
