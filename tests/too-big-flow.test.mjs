import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* 创建题组 for a selection too big for one generation: ONE block with a choice of how to go on (steps / pages by topic), only the chosen panel, no contradicting
   sentences, one primary button. Static markup, no host. */

const compiled = await build({ stdin: { contents: `
  export { default as Generate } from './ui/Generate.jsx';
  export { availableModes, defaultMode, effectiveMode, showsChoice, pathSummary } from './ui/too-big-choice.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Generate, availableModes, defaultMode, effectiveMode, showsChoice, pathSummary, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const noop = () => {};

const page = (n, title, index, chars) => ({ id: `b${n}`, title: `Book · p.${n}`, chars, courses: ['DB'], document: { id: 'h', page: n, totalPages: 36, bookTitle: 'Book', origin: 'converted', converter: 'mineru', chapter: { index, title, level: 1 } } });
// 30 pages of a chapter and 6 pages of index: 20,000 characters a page is 720,000 in all (too big); 1,000 a page is 36,000 (fits).
const book = chars => [...Array.from({ length: 30 }, (_, i) => page(i + 1, 'Alpha', 0, chars)), ...Array.from({ length: 6 }, (_, i) => page(31 + i, 'Index', 1, chars))];
const BIG = book(20000), SMALL = book(1000);
const none = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [] };
const ready = { selected: 'mcp:mcp__rag__q', effective: 'mcp:mcp__rag__q', hostCanSearch: true, otherTools: [],
  providers: [{ id: 'mcp:mcp__rag__q', kind: 'mcp', label: 'query_documents', server: 'rag', tool: 'mcp__rag__q' }] };
const gen = (focus = '') => ({ kind: 'mixed', count: 10, difficulty: 'mixed', language: 'English', focus, role: '' });
function render({ sources = BIG, retrieval = none, focus = '', mode, language = 'zh' } = {}) {
  setUiLanguage(language);
  try {
    const data = { root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: true, focus: { course: 'DB', courses: [{ name: 'DB' }] } };
    return renderToStaticMarkup(h(Generate, { data, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop,
      genSource: 'files', setGenSource: noop, gen: gen(focus), setGen: noop, selectedSources: sources.map(source => source.id), setSelectedSources: noop, setModal: noop, askInChat: noop,
      openModelSettings: noop, initialRetrieval: retrieval, ...(mode ? { initialGenerationMode: mode } : {}) }));
  } finally { setUiLanguage('zh'); }
}
const count = (html, pattern) => (html.match(pattern) || []).length;
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const submit = html => /<button[^>]*data-tour="generate-submit"[^>]*>/.exec(html)?.[0] || '';
const SENTENCE = /先在「这次想练什么？」/g;

test('the choice is pure: which modes, the default, the one that is on, the summary of the steps', () => {
  const tooBig = { tooBig: true, willRetrieve: true, needsTopic: true }, fits = { tooBig: false, willRetrieve: false, needsTopic: false };
  assert.deepEqual(availableModes({ advice: tooBig, pathReady: true, retrieval: none }), ['path']);
  assert.deepEqual(availableModes({ advice: tooBig, pathReady: true, retrieval: ready }), ['path', 'retrieval']);
  assert.deepEqual(availableModes({ advice: tooBig, pathReady: false, retrieval: none }), [], 'nothing to choose: only the explanation');
  assert.deepEqual(availableModes({ advice: fits, pathReady: true, retrieval: none }), ['path', 'single']);
  assert.equal(defaultMode(['path', 'retrieval'], tooBig), 'path', 'steps first');
  assert.equal(defaultMode(['retrieval'], tooBig), 'retrieval');
  assert.equal(defaultMode([], tooBig), null);
  assert.equal(defaultMode(['path', 'single'], fits), 'single', 'a selection that fits is done at once unless the learner chooses otherwise');
  assert.equal(effectiveMode('retrieval', ['path'], tooBig), 'path', 'a choice that no longer exists for this selection falls back');
  assert.equal(effectiveMode('single', ['path', 'single'], fits), 'single');
  assert.equal(showsChoice(['single'], fits), false);
  assert.equal(showsChoice([], tooBig), true);
  assert.equal(showsChoice(['path', 'single'], fits), true);
  assert.match(pathSummary([{ count: 15 }, { count: 12 }]), /^共 2 步 · 约 27 题$/);
});

test('path mode: one block, the steps only, no coverage strength, one primary button that says how many steps, a summary of steps and no "将从…出…题"', () => {
  const html = render({ mode: 'path' });
  assert.match(html, /所选资料太大，一次出不完/);
  assert.equal(count(html, /class="gen-path"/g), 1);
  assert.equal(count(html, /retrieval-panel/g), 0, 'only the chosen mode is drawn');
  assert.equal(count(html, /分步生成路径/g), 0, 'one title for the block, not a second one for the steps');
  assert.doesNotMatch(html, /generate-row__label">覆盖强度/, 'the coverage strength (with the spending limit and the count) does not apply to a step');
  assert.equal(count(html.replace(/<details[\s\S]*?<\/details>/g, ''), /sh-btn--primary/g), 1, 'one primary action (the folded card keeps its own buttons)');
  assert.equal(count(html, /data-usage="generate.path-queue"/g), 1, 'the queue button exists once (not also inside the step list)');
  assert.match(submit(html), /data-usage="generate.path-queue"/, 'the one submit button at the bottom of the form is the queue button');
  assert.doesNotMatch(submit(html), /disabled/);
  assert.match(text(html), /按路径逐步出题 · 5 步依次排队/);
  assert.match(text(html), /共 5 步 · 约 \d+ 题/);
  assert.doesNotMatch(html, /将从/, 'no promise of a number of questions next to a different button');
  assert.doesNotMatch(html, /生成并检查题组/);
  assert.equal(count(html, SENTENCE), 0, 'no demand for a topic: the steps need none');
});

test('path mode: the steps that are off by default are folded into one line and stay individually checkable; each step has an explained "只出这一步"', () => {
  const html = render({ mode: 'path' });
  assert.match(text(html), /1 个可选步骤默认跳过（索引等）/);
  const folded = /<details[^>]*class="sh-disclosure[^"]*"[^>]*>((?:(?!<\/details>)[\s\S])*)<\/details>/.exec(html.slice(html.indexOf('gen-path')))?.[1] || '';
  assert.match(folded, /data-optional="true"/, 'the optional step is inside the fold');
  assert.match(folded, /type="checkbox"/, 'and can still be ticked');
  assert.equal(count(html.slice(html.indexOf('gen-path'), html.indexOf('</details>')), /data-optional="false"/g), 5, 'the five steps in use stay in the list');
  assert.match(html, /只出这一步/);
  assert.doesNotMatch(html, /只用这一步/);
  assert.match(text(html), /把选择缩到这一步的页面，回到普通出题（会离开分步模式），题数用这一步的建议题数/);
  assert.doesNotMatch(html, /<[^>]*\stitle="只出这一步/);
  assert.doesNotMatch(html, /gen-path__steps[^>]*max-height/);
});

test('retrieval mode: the topic is asked for once, the ordinary form stays, its button is off until a topic is written and the reason is a hint', () => {
  const html = render({ mode: 'retrieval', retrieval: ready });
  assert.equal(count(html, /class="retrieval-panel"/g), 1);
  assert.equal(count(html, /gen-path__steps/g), 0, 'the steps are not drawn in this mode');
  assert.equal(count(html, SENTENCE), 1, 'the sentence that asks for the topic is said once');
  assert.equal(count(html, /所选资料太大/g), 1);
  assert.match(html, /generate-row__label">覆盖强度/, 'the ordinary form is all there');
  assert.match(submit(html), /disabled/);
  assert.match(submit(html), /data-usage="generate.submit"/);
  assert.doesNotMatch(html, /将从/, 'no summary next to a disabled button');
  assert.match(text(html), /写下主题后才能生成/);
  assert.equal(count(html, /data-usage="generate.path-queue"/g), 0);
  const withTopic = render({ mode: 'retrieval', retrieval: ready, focus: '死锁' });
  assert.doesNotMatch(submit(withTopic), /disabled/);
  assert.match(withTopic, /检索已启用/);
  assert.equal(count(withTopic, /写下主题后才能生成/g), 0);
});

test('with a retrieval tool ready both ways are offered as a choice; steps are the default and only one panel is drawn', () => {
  const html = render({ retrieval: ready });
  assert.match(html, /role="group"[^>]*aria-label="怎么出题"/);
  assert.match(text(html), /分步出题/);
  assert.match(text(html), /按主题挑页面/);
  assert.equal(count(html, /class="gen-path"/g), 1);
  assert.equal(count(html, /retrieval-panel/g), 0);
  assert.equal(count(html, /大教材建议/g), 0, 'the tool exists: the card that explains how to get one is not needed');
  assert.match(html, /aria-pressed="true"[^>]*>分步出题/);
});

test('without a retrieval tool there is nothing to choose: the steps, and the old card as a plain hint, not a panel next to them', () => {
  const html = render({});
  assert.doesNotMatch(html, /aria-label="怎么出题"/, 'a choice of one is not a choice');
  assert.doesNotMatch(html, />按主题挑页面<\/button>/, 'not offered as a way');
  assert.equal(count(html, /class="gen-path"/g), 1);
  assert.equal(count(html, /大教材建议/g), 1, 'the long-document card is kept');
  assert.match(html, /data-reason="selection"/);
  assert.match(text(html), /或者在上面少选几份\/几页/);
  assert.equal(count(html, /sh-btn--primary/g) >= 1, true);
  // The card sits in a fold under the steps: it does not compete with them.
  assert.match(html, /<details[^>]*class="sh-disclosure[^"]*"[^>]*>(?:(?!<\/details>)[\s\S])*data-reason="selection"/);
  assert.doesNotMatch(html, /所选资料超过一次生成的上限。请按章节/, 'the second warning under the button is gone while the steps are the way on');
});

test('a selection that fits is done at once as before; a long one only adds a small choice, closed on "一次出题"', () => {
  const html = render({ sources: SMALL });
  assert.doesNotMatch(html, /所选资料太大/);
  assert.match(text(html), /一次出题/);
  assert.equal(count(html, /class="gen-path"/g), 0);
  assert.match(html, /generate-row__label">覆盖强度/);
  assert.match(submit(html), /data-usage="generate.submit"/);
  assert.doesNotMatch(submit(html), /disabled/);
  assert.match(text(html), /将从 1 份资料/);
  const small = render({ sources: SMALL.slice(0, 5) });
  assert.doesNotMatch(small, /怎么出题|class="gen-path"|一次出题/, 'a few pages: nothing of this');
});

test('the explanations are Tooltips with a keyboard anchor, never a title attribute on a text element', () => {
  for (const options of [{ mode: 'path' }, { mode: 'retrieval', retrieval: ready }]) {
    const html = render(options);
    assert.match(html, /role="tooltip"/);
    assert.doesNotMatch(html.slice(html.indexOf('class="too-big"')), /<(?:span|div|li|small|p|strong)[^>]*\stitle=/);
  }
  const path = text(render({ mode: 'path' }));
  assert.match(path, /每一步是一个独立的出题任务，按顺序排队；先做完的一步就可以先练/);
  assert.match(path, /每一步有自己的题数/, 'why the coverage strength is not shown');
  assert.match(path, /这一步没有自己的重点时，用这里写的作为默认重点/, 'what the topic does here');
  assert.match(text(render({ mode: 'retrieval', retrieval: ready })), /StudyHub 用它去检索/, 'what the topic does there');
});

test('the same states in English have no Chinese left', () => {
  for (const options of [{ mode: 'path' }, { mode: 'retrieval', retrieval: ready }, { retrieval: ready }, {}, { sources: SMALL }]) {
    const html = render({ ...options, language: 'en' });
    assert.doesNotMatch(text(html).replace(/创建题组/g, ''), han, JSON.stringify({ ...options, sources: options.sources ? 'small' : 'big' }));
  }
});
