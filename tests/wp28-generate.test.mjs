import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* WP28: what 创建题组 shows for a selection too big for one generation, and for the retrieval panel and job line. */

const compiled = await build({ stdin: { contents: `
  export { default as Generate } from './ui/Generate.jsx';
  export { default as RetrievalPanel } from './ui/RetrievalPanel.jsx';
  export { default as GenerationTrace } from './ui/GenerationTrace.jsx';
  export { retrievalSummary } from './ui/large-document-advice.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Generate, RetrievalPanel, GenerationTrace, retrievalSummary, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const noop = () => {};
const big = [{ id: 'b1', title: 'Big · p.1', chars: 400000, text: undefined, courses: ['DB'] }, { id: 'b2', title: 'Big2 · p.1', chars: 400000, courses: ['DB'] },
  { id: 's1', title: 'Small', chars: 5000, courses: ['DB'] }];
const none = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [] };
const active = { selected: 'mcp:mcp__rag__q', effective: 'mcp:mcp__rag__q', hostCanSearch: true, otherTools: [],
  providers: [{ id: 'mcp:mcp__rag__q', kind: 'mcp', label: 'query_documents', server: 'rag', tool: 'mcp__rag__q' }] };
const gen = (focus = '') => ({ kind: 'mixed', count: 10, difficulty: 'mixed', language: 'English', focus, role: '' });
function render({ selected, retrieval = none, focus = '', language = 'zh', mode } = {}) {
  setUiLanguage(language);
  try {
    const data = { root: 'lib', decks: [], drafts: [], jobs: [], sources: big, modelReady: true, focus: { course: 'DB', courses: [{ name: 'DB' }] } };
    return renderToStaticMarkup(h(Generate, { data, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop,
      genSource: 'files', setGenSource: noop, gen: gen(focus), setGen: noop, selectedSources: selected, setSelectedSources: noop, setModal: noop, askInChat: noop,
      openModelSettings: noop, initialRetrieval: retrieval, ...(mode ? { initialGenerationMode: mode } : {}) }));
  } finally { setUiLanguage('zh'); }
}
const submit = html => /<button[^>]*data-tour="generate-submit"[^>]*>/.exec(html)?.[0] || '';

test('a selection over the limit with no retrieval tool: the card explains (folded under the steps), the ordinary generate button is replaced by the one of the steps', () => {
  const html = render({ selected: ['b1', 'b2'] });
  assert.match(html, /大教材建议/);
  assert.match(html, /800,000/);
  assert.match(html, /MinerU/);
  assert.match(submit(html), /data-usage="generate\.path-queue"/, 'one way on: the steps');
  assert.match(html, /超过一次生成的上限/);
  assert.doesNotMatch(html, /retrieval-panel/);
  assert.doesNotMatch(html, /生成并检查题组/);
});

test('with a retrieval tool but no topic: asks for the topic first; generating is off', () => {
  const html = render({ selected: ['b1', 'b2'], retrieval: active, mode: 'retrieval' });
  assert.doesNotMatch(html, /大教材建议/, 'the tool exists, the card is not needed');
  assert.match(html, /class="retrieval-panel"/);
  assert.match(html, /写下主题/);
  assert.match(submit(html), /disabled/);
  assert.match(html, /预览会用到的页面/);
});

test('with a retrieval tool and a topic: the panel says what will happen and generating is on', () => {
  const html = render({ selected: ['b1', 'b2'], retrieval: active, focus: '死锁', mode: 'retrieval' });
  assert.match(html, /检索已启用/);
  assert.match(html, /800,000/);
  assert.doesNotMatch(submit(html), /disabled/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1, 'still one primary action');
  assert.doesNotMatch(html, /class="gen-path"/, 'only the chosen way is drawn');
});

test('a normal selection is untouched, even with a tool chosen', () => {
  for (const retrieval of [none, active]) {
    const html = render({ selected: ['s1'], retrieval });
    assert.doesNotMatch(html, /大教材建议|retrieval-panel/);
    assert.doesNotMatch(submit(html), /disabled/);
  }
  // Above 150,000 characters a chosen tool narrows even when the selection still fits.
  assert.match(render({ selected: ['b1'], retrieval: active, focus: '索引' }), /retrieval-panel/);
  assert.doesNotMatch(render({ selected: ['b1'], retrieval: none }), /大教材建议/);
});

test('the same page in English', () => {
  for (const options of [{ selected: ['b1', 'b2'] }, { selected: ['b1', 'b2'], retrieval: active }, { selected: ['b1', 'b2'], retrieval: active, mode: 'retrieval' }, { selected: ['b1', 'b2'], retrieval: active, focus: 'deadlock', mode: 'retrieval' }]) {
    const html = render({ ...options, language: 'en' });
    assert.doesNotMatch(html.replace(/<[^>]*>/g, ' ').replace(/创建题组/g, ''), han, JSON.stringify(options));
  }
});

const preview = { provider: 'mcp:mcp__rag__q', query: '死锁', hits: 3, unresolved: 1, truncated: false, chars: 5000,
  pages: [{ sourceId: 'p17', title: 'b · p.17', page: 17, score: 0.9, snippet: '死锁需要互斥、持有并等待' }, { sourceId: 'p33', title: 'b · p.33', page: 33, score: 0.6, snippet: '页表映射' }] };

test('the panel lists the pages a search would use and lets the learner keep only some', () => {
  setUiLanguage('zh');
  const html = renderToStaticMarkup(h(RetrievalPanel, { call: noop, advice: { chars: 800000 }, sourceIds: ['b1'], focus: '死锁', initialPreview: preview, onApply: noop }));
  assert.match(html, /第 17 页/);
  assert.match(html, /死锁需要互斥/);
  assert.equal((html.match(/type="checkbox"[^>]*checked/g) || []).length, 2, 'all pages start ticked');
  assert.match(html, /只用勾选的页面/);
  assert.match(html, /另有 1 段/);
  const noTopic = renderToStaticMarkup(h(RetrievalPanel, { call: noop, advice: { chars: 800000, needsTopic: true }, sourceIds: [], focus: '' }));
  assert.match(noTopic, /<button[^>]*disabled[^>]*>(?:<svg.*?<\/svg>)?预览会用到的页面/);
  const empty = renderToStaticMarkup(h(RetrievalPanel, { call: noop, advice: { chars: 800000 }, sourceIds: [], focus: 'x', initialPreview: { ...preview, pages: [] } }));
  assert.match(empty, /没有找到相关页面/);
  setUiLanguage('en');
  try { assert.doesNotMatch(renderToStaticMarkup(h(RetrievalPanel, { call: noop, advice: { chars: 800000 }, sourceIds: [], focus: 'x', initialPreview: { ...preview, pages: preview.pages.map(page => ({ ...page, snippet: 'deadlock' })) } })), han); }
  finally { setUiLanguage('zh'); }
});

test('a job says which pages the search used, or why it did not', () => {
  setUiLanguage('zh');
  const used = retrievalSummary({ provider: 'mcp:x', query: '死锁', selected: 80, used: [{ page: 17 }, { page: 33 }], truncated: false });
  assert.equal(used.error, false);
  assert.match(used.text, /第 17、33 页/);
  assert.match(used.text, /所选 80 份/);
  assert.match(retrievalSummary({ used: [{ page: 1 }], selected: 9, truncated: true }).text, /只取了最相关的部分/);
  const failed = retrievalSummary({ provider: 'mcp:x', selected: 80, used: [], error: 'connection refused' });
  assert.equal(failed.error, true);
  assert.match(failed.text, /connection refused/);
  assert.equal(retrievalSummary(undefined), null);
  const manyPages = retrievalSummary({ selected: 50, used: Array.from({ length: 30 }, (_, i) => ({ page: i + 1 })) });
  assert.match(manyPages.text, /…/);
  const trace = job => renderToStaticMarkup(h(GenerationTrace, { job: { status: 'complete', steps: [], ...job } }));
  assert.match(trace({ retrieval: { selected: 80, used: [{ page: 17 }], provider: 'x' } }), /data-retrieval="used"/);
  assert.match(trace({ retrieval: { selected: 80, used: [], error: 'boom' } }), /data-retrieval="error"/);
  assert.doesNotMatch(trace({}), /data-retrieval/);
  setUiLanguage('en');
  try { assert.doesNotMatch(retrievalSummary({ selected: 80, used: [{ page: 17 }], truncated: true }).text, han); assert.doesNotMatch(retrievalSummary({ error: 'boom' }).text, han); }
  finally { setUiLanguage('zh'); }
});
