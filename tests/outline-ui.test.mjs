/* The reader's contents panel as a tree and the "让 AI 帮你" flow, as the learner meets them: every state of the panel and of
   the flow rendered in both languages, the state machine, and how a kept outline finds its places in the drawn text. The
   layout itself is checked in the browser preview (screenshots in the work report). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bilingualMarkdown, headingNodes } from './helpers/bilingual-transcript.mjs';

const require = createRequire(import.meta.url);
const han = /[㐀-鿿]/;
const compiled = await build({ stdin: { contents: `export * from './ui/i18n.js';
export { default as OutlinePanel } from './ui/document-preview/reader/OutlinePanel.jsx';
export { OutlineAssistView, ProposalPreview } from './ui/document-preview/reader/OutlineAssist.jsx';
export { structureOutline, collectHeadings } from './ui/document-preview/reader/outline.js';
export { assistReducer, assistFromResult, rejectionKind, ASSIST_IDLE, applyOutline, locateEntries } from './ui/document-preview/reader/ai-outline.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } });
const load = () => { const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports); return module.exports; };
const lib = load();
const { OutlinePanel, OutlineAssistView, ProposalPreview, structureOutline, collectHeadings, assistReducer, assistFromResult, rejectionKind, ASSIST_IDLE, applyOutline, setUiLanguage } = lib;
const h = React.createElement;
const html = (element, language = 'zh') => { setUiLanguage(language); return renderToStaticMarkup(element); };

const tree = structureOutline(collectHeadings({ querySelectorAll: () => headingNodes(bilingualMarkdown()) }));
const labelOf = () => '';
const panel = (props = {}, language) => html(h(OutlinePanel, { items: tree, activeId: 'h-0', onJump() {}, labelOf, id: 'o', ...props }), language);
const count = (text, pattern) => (text.match(pattern) || []).length;

/* ---------- the panel ---------- */

test('the panel opens as a tree: the title and nine parts, the labels folded, every folded part says so', () => {
  const markup = panel();
  assert.equal(count(markup, /<li[ >]/g), 10);
  assert.equal(count(markup, /aria-expanded="false"/g), 9);
  assert.equal(count(markup, /aria-expanded="true"/g), 1);
  assert.doesNotMatch(markup, /英文原句|中文对照/);
  assert.match(markup, /第一部分：平台的含义与作用/);
  assert.match(markup, /aria-current="location"[^>]*>(?:(?!<\/button>).)*平台经济课堂实录/);
});

test('the part the reader is in shows its labels, and the label that is current is marked', () => {
  const third = tree.find(entry => entry.title.startsWith('第三')), label = tree.find(entry => entry.parent === third.id && entry.title === '中文对照');
  const markup = panel({ activeId: label.id });
  assert.equal(count(markup, /<li[ >]/g), 12);
  assert.equal(count(markup, />英文原句</g), 1);
  assert.match(markup, /aria-current="location"[^>]*>(?:(?!<\/button>).)*中文对照/);
  const inner = markup.slice(markup.indexOf('>第三部分'));
  assert.ok(inner.indexOf('>英文原句<') > 0 && inner.indexOf('>英文原句<') < inner.indexOf('>第四部分'), 'the labels sit under their part');
});

test('a collapsed part with the reader inside it lights the part, so the current place is never lost', () => {
  const third = tree.find(entry => entry.title.startsWith('第三')), label = tree.find(entry => entry.parent === third.id);
  const hidden = tree.filter(entry => entry.parent === 'h-0' && entry.title.startsWith('第') && entry !== third);
  const folded = html(h(OutlinePanel, { items: tree, activeId: label.id, onJump() {}, labelOf, id: 'o', initialOpen: ['h-0'] }));
  assert.ok(hidden.length > 0);
  assert.match(folded, /aria-current="location"[^>]*>(?:(?!<\/button>).)*第三部分/, 'folded: the part carries the highlight');
});

test('a long outline gets a filter box; a short one does not; the heading says how many entries there are', () => {
  assert.match(panel(), /type="search"/);
  const small = structureOutline([{ id: 'a', level: 1, title: '甲' }, { id: 'b', level: 1, title: '乙' }]);
  assert.doesNotMatch(panel({ items: small, activeId: 'a' }), /type="search"/);
});

test('an empty automatic outline says so and still offers the way to ask for one', () => {
  const markup = panel({ items: [], activeId: null, footer: h('span', null, 'FOOT') });
  assert.match(markup, /没有解析出标题/);
  assert.match(markup, /FOOT/);
  assert.doesNotMatch(markup, /type="search"/);
});

test('English: no Han outside the learner’s own headings, and every control is labelled', () => {
  const english = structureOutline([{ id: 'a', level: 1, title: 'Part 1' }, ...[1, 2, 3].flatMap(n => [{ id: `o${n}`, level: 2, title: 'Original' }, { id: `t${n}`, level: 2, title: 'Translation' }]).map((e, i) => ({ ...e, id: `${e.id}-${i}` }))]);
  const markup = html(h(OutlinePanel, { items: english, activeId: 'a', onJump() {}, labelOf, id: 'o', footer: h('span') }), 'en');
  assert.doesNotMatch(markup, han);
  assert.match(markup, /aria-label="Contents"/);
  assert.match(html(h(OutlinePanel, { items: [], activeId: null, onJump() {}, labelOf, id: 'o' }), 'en'), /No headings were found/);
});

/* ---------- the flow ---------- */

const noop = () => {};
const handlers = { onStart: noop, onRun: noop, onCancel: noop, onAccept: noop, onDiscard: noop, onRestore: noop };
const view = (state, props = {}, language) => html(h(OutlineAssistView, { state, saved: null, stale: null, ...handlers, ...props }), language);
const estimate = { feature: 'outline', uncachedInputTokens: { low: 2100, high: 2600 }, cacheReadTokens: { low: 0, high: 0 }, outputTokens: { low: 200, high: 3200 },
  inputTokens: { low: 2100, high: 2600 }, totalTokens: { low: 2300, high: 5800 }, calls: { low: 1, high: 1 }, stages: [{ id: 'outline', calls: 1, inputTokens: { low: 2100, high: 2600 }, outputTokens: { low: 200, high: 3200 } }], notes: ['cache-depends'] };
const coverage = { blocks: 73, units: 73, chars: 4100, condensed: false };
const usage = { uncachedInputTokens: 2300, outputTokens: 410, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 };
const entries = [{ title: '平台经济课堂实录', level: 1, startBlock: 0, kind: 'quoted' }, { title: '第一部分：平台的含义与作用', level: 2, startBlock: 1, kind: 'quoted' }, { title: '开场', level: 2, startBlock: 9, kind: 'label' }];

test('idle: one quiet button with the owner’s wording, in both languages', () => {
  assert.match(view(ASSIST_IDLE), /对自动解析的标题不满意？让 AI 帮你/);
  assert.match(view(ASSIST_IDLE, {}, 'en'), /Not happy with the automatic headings\? Let AI help/);
  assert.doesNotMatch(view(ASSIST_IDLE, {}, 'en'), han);
});

test('estimating and ready: the price comes before the call, and the learner starts it', () => {
  assert.match(view({ phase: 'estimating' }), /正在估算/);
  const ready = view({ phase: 'ready', coverage, estimate });
  assert.match(ready, /预计/);
  assert.match(ready, /tok/);
  assert.match(ready, /73/);
  assert.match(ready, /开始/);
  assert.match(ready, /只调用一次模型/);
  assert.doesNotMatch(ready, /查看估算明细|缓存命中|1 次模型调用/);
  const condensed = view({ phase: 'ready', coverage: { blocks: 1500, units: 240, chars: 150000, condensed: true }, estimate });
  assert.match(condensed, /1500/);
  assert.match(condensed, /240/);
  assert.match(condensed, /取样|只能定位/);
  assert.doesNotMatch(view({ phase: 'ready', coverage, estimate }, {}, 'en'), han);
});

test('running does not block reading: a status line and a way out, no dialog', () => {
  const running = view({ phase: 'running', coverage, estimate });
  assert.match(running, /role="status"/);
  assert.match(running, /可以继续阅读/);
  assert.match(running, /取消/);
  assert.doesNotMatch(running, /<dialog/);
  assert.doesNotMatch(view({ phase: 'running', coverage, estimate }, {}, 'en'), han);
});

test('without a model: said plainly, the automatic outline stays, no start button', () => {
  const none = view({ phase: 'nomodel' });
  assert.match(none, /还没有可用的 AI 模型/);
  assert.match(none, /让 AI 整理目录需要先配置模型；仍使用自动目录/);
  assert.match(none, /自动目录/);
  assert.doesNotMatch(none, />开始</);
  assert.doesNotMatch(view({ phase: 'nomodel' }, {}, 'en'), han);
});

test('a rejected answer: a plain reason by kind, what it cost, the automatic outline stays, and a way to try again', () => {
  const grounding = view({ phase: 'rejected', code: 'ungrounded', usage });
  assert.match(grounding, /role="alert"/);
  assert.match(grounding, /找不到依据/);
  assert.match(grounding, /Token 用量 2,710 tok/);
  assert.doesNotMatch(grounding, /缓存命中|未缓存输入|复制/);
  assert.match(grounding, /重新生成/);
  assert.match(view({ phase: 'rejected', code: 'not-json', usage: null }), /不是目录/);
  assert.match(view({ phase: 'rejected', code: 'bad-start', usage }), /位置或层级/);
  for (const code of ['not-json', 'empty', 'bad-start', 'ungrounded']) assert.doesNotMatch(view({ phase: 'rejected', code, usage }, {}, 'en'), han, code);
  assert.deepEqual(['not-json', 'empty', 'misplaced', 'ungrounded', 'bad-level', 'too-many'].map(rejectionKind), ['format', 'empty', 'grounding', 'grounding', 'structure', 'structure']);
});

test('a failed call: the message, and a way to retry; nothing was changed', () => {
  const failed = view({ phase: 'failed', message: 'network down' });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /network down/);
  assert.match(failed, /重试/);
  assert.doesNotMatch(view({ phase: 'failed', message: 'x' }, {}, 'en'), han);
});

test('a kept outline: it says so, and offers 重新生成 and 恢复自动目录; an outline of an older revision is called out', () => {
  const kept = view(ASSIST_IDLE, { saved: { entries, savedAt: '2026-10-01T10:00:00.000Z', source: 'ai' }, missing: 0 });
  assert.match(kept, /AI 目录/);
  assert.match(kept, /3 项/);
  assert.match(kept, /重新生成/);
  assert.match(kept, /恢复自动目录/);
  assert.doesNotMatch(kept, /让 AI 帮你/);
  assert.match(view(ASSIST_IDLE, { saved: { entries, savedAt: '', source: 'ai' }, missing: 2 }), /2 项在当前版面里找不到/);
  const stale = view(ASSIST_IDLE, { stale: { revision: 'old', entries: 10 } });
  assert.match(stale, /资料已更新/);
  assert.match(stale, /让 AI 帮你/);
  const en = view(ASSIST_IDLE, { saved: { entries, savedAt: '', source: 'ai' }, missing: 1, stale: null }, 'en');
  assert.doesNotMatch(en, han);
  assert.match(en, /Restore automatic headings/);
  assert.match(en, /Regenerate/);
  assert.doesNotMatch(view(ASSIST_IDLE, { stale: { revision: 'old', entries: 10 } }, 'en'), han);
});

test('the proposal is shown beside the current outline, each with its count, labels marked, usage and coverage honest', () => {
  const markup = html(h(ProposalPreview, { current: tree, entries, usage, coverage: { ...coverage, condensed: true, blocks: 1500, units: 240 }, warnings: ['levels-adjusted'] }));
  assert.match(markup, /当前目录 · 28 项/);
  assert.match(markup, /AI 建议 · 3 项/);
  assert.match(markup, /概括/);
  assert.match(markup, /Token 用量 2,710 tok/);
  assert.doesNotMatch(markup, /缓存命中|未缓存输入|复制/);
  assert.match(markup, /1500/);
  assert.match(markup, /层级/);
  const english = html(h(ProposalPreview, { current: structureOutline([{ id: 'a', level: 1, title: 'A' }]), entries: [{ title: 'Intro', level: 1, startBlock: 0, kind: 'label' }], usage, coverage, warnings: [] }), 'en');
  assert.doesNotMatch(english, han);
  assert.match(english, /Current headings · 1\b/);
  assert.match(english, /AI proposal · 1\b/);
});

test('the flow moves idle → estimating → ready → running → proposal, and any failure leaves it where the learner can retry', () => {
  let state = assistReducer(ASSIST_IDLE, { type: 'estimate' });
  assert.equal(state.phase, 'estimating');
  state = assistReducer(state, { type: 'result', result: { status: 'estimate', modelAvailable: true, coverage, estimate } });
  assert.deepEqual([state.phase, state.coverage.units, state.estimate.feature], ['ready', 73, 'outline']);
  state = assistReducer(state, { type: 'run' });
  assert.deepEqual([state.phase, state.estimate.feature], ['running', 'outline'], 'the estimate stays on screen while it runs');
  state = assistReducer(state, { type: 'result', result: { status: 'proposed', entries, usage, coverage } });
  assert.deepEqual([state.phase, state.entries.length, state.usage.outputTokens], ['proposal', 3, 410]);
  assert.equal(assistReducer(state, { type: 'reset' }), ASSIST_IDLE);
  assert.equal(assistFromResult({ status: 'rejected', code: 'bad-start', usage }).phase, 'rejected');
  assert.equal(assistFromResult({ available: false, reason: 'model_unavailable' }).phase, 'nomodel');
  assert.equal(assistFromResult({ status: 'unavailable' }).phase, 'nomodel');
  assert.equal(assistFromResult({ status: 'estimate', modelAvailable: false, coverage }).phase, 'nomodel');
  assert.equal(assistFromResult({ status: 'empty' }).phase, 'empty');
  assert.deepEqual(assistReducer(ASSIST_IDLE, { type: 'error', message: 'boom' }), { phase: 'failed', message: 'boom' });
  assert.equal(assistReducer(state, { type: 'nonsense' }), state);
});

/* ---------- where a kept outline's entries are in the drawn text ---------- */

/** A drawn document: block elements with one text node each inside a container, with the DOM calls the reader's helpers use. */
function drawn(blocks) {
  const texts = [], elements = [];
  const make = (tagName, parentElement, attributes = {}) => ({ tagName, parentElement, dataset: {}, attributes: new Map(Object.entries(attributes)),
    hasAttribute(name) { return this.attributes.has(name); }, setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); }, getAttribute(name) { return this.attributes.get(name); },
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; },
    closest(selector) { const tags = selector.split(',').map(part => part.trim().toUpperCase()); for (let node = this; node; node = node.parentElement) if (tags.includes(node.tagName.toUpperCase())) return node; return null; } });
  const root = make('div', null);
  root.ownerDocument = {
    createTreeWalker() { let at = 0; return { nextNode: () => texts[at++] ?? null }; },
    createRange() { const range = { setStart(node, offset) { range.startContainer = node; range.start = [texts.indexOf(node), offset]; }, setEnd(node, offset) { range.end = [texts.indexOf(node), offset]; } }; return range; },
  };
  root.querySelectorAll = selector => selector === '[data-ai-outline-id]' ? elements.filter(element => element.hasAttribute('data-ai-outline-id')) : [];
  for (const [tag, text, attributes] of blocks) {
    const element = make(tag, root, attributes);
    elements.push(element); texts.push({ textContent: text, parentElement: element, nodeType: 3 });
  }
  return { root, elements, texts };
}
const anchor = (quote, ordinal = 0) => ({ sourceId: 's1', offset: 0, quote, ordinal });

test('a kept outline is found in the drawn text by its anchors: each entry targets the block it starts, repeated lines by occurrence', () => {
  const { root, elements } = drawn([['h2', '第一部分'], ['p', '正文一'], ['h3', '英文原句'], ['p', '句子'], ['h3', '英文原句'], ['p', '句子二']]);
  const items = applyOutline(root, [{ title: '第一部分', level: 1, kind: 'quoted', anchor: anchor('第一部分') },
    { title: '英文原句', level: 2, kind: 'quoted', anchor: anchor('英文原句', 0) }, { title: '英文原句', level: 2, kind: 'quoted', anchor: anchor('英文原句', 1) }]);
  assert.deepEqual(items.map(item => [item.id, item.title, item.tagged]), [['ai-0', '第一部分', true], ['ai-1', '英文原句', true], ['ai-2', '英文原句', true]]);
  assert.deepEqual(elements.map(element => element.getAttribute('data-ai-outline-id') ?? null), ['ai-0', null, 'ai-1', null, 'ai-2', null]);
});

test('an entry whose place is not in the drawn text is left out, never guessed; tags of an earlier outline are cleared', () => {
  const { root, elements } = drawn([['h2', '第一部分'], ['p', '正文一'], ['h2', '第二部分'], ['p', '正文二']]);
  elements[3].setAttribute('data-ai-outline-id', 'ai-9');
  const items = applyOutline(root, [{ title: '第一部分', level: 1, kind: 'quoted', anchor: anchor('第一部分') },
    { title: '不存在', level: 1, kind: 'label', anchor: anchor('完全不在文中的开头') }, { title: '第二部分', level: 1, kind: 'quoted', anchor: anchor('第二部分') }]);
  assert.deepEqual(items.map(item => item.id), ['ai-0', 'ai-2']);
  assert.equal(elements[3].getAttribute('data-ai-outline-id') ?? null, null);
  assert.deepEqual(applyOutline(null, []), []);
});

test('plain text drawn as one block keeps the place as a range but has no element to scroll to', () => {
  const { root, elements } = drawn([['pre', '第一部分\n正文\n第二部分\n正文', { 'data-study-text': 'true' }]]);
  const items = applyOutline(root, [{ title: '第二部分', level: 1, kind: 'quoted', anchor: anchor('第二部分') }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].tagged, false, 'the whole <pre> is the text container, not a block of its own');
  assert.equal(elements[0].hasAttribute('data-ai-outline-id'), false);
  assert.deepEqual(items[0].range.start, [0, 8], 'the range starts where the second part does');
});

test('#14 & #57 outline shows weak-question read hints, 只看未读 filter chip, and 下一未读章 jump with wrap-around', async () => {
  const chapters = [
    { id: 'c1', level: 1, depth: 0, kind: 'chapter', children: 1, title: '第一章 索引' },
    { id: 's1', level: 2, depth: 1, parent: 'c1', children: 0, title: 'B+ 树' },
    { id: 'c2', level: 1, depth: 0, kind: 'chapter', children: 0, title: '第二章 事务' },
    { id: 'c3', level: 1, depth: 0, kind: 'chapter', children: 0, title: '第三章 锁' },
  ];
  const marks = new Map([['c1', 'c1'], ['c2', 'c2'], ['c3', 'c3']]);
  const meters = new Map([
    ['c1', { total: 4, mastered: 1, familiar: 0, learning: 1, weak: 2, unseen: 0, mastery: 0.4 }],
    ['c2', { total: 2, mastered: 2, familiar: 0, learning: 0, weak: 0, unseen: 0, mastery: 1 }],
    ['c3', { total: 3, mastered: 0, familiar: 0, learning: 0, weak: 1, unseen: 2, mastery: 0.1 }],
  ]);

  const partial = panel({
    items: chapters,
    activeId: 'c1',
    meters,
    reads: { read: new Set(['c1', 'c2']), count: 2, total: 3, marks, onUnread: () => {} },
  });
  assert.match(partial, /data-read-weak="true"/);
  assert.match(partial, /已读：第一章 索引（还有 2 道待巩固题）。点一下标为未读/);
  assert.match(partial, /aria-label="已读：第二章 事务。点一下标为未读"/);
  assert.match(partial, /只看未读/);
  assert.match(partial, /下一未读章/);

  const allRead = panel({
    items: chapters,
    activeId: 'c1',
    meters,
    reads: { read: new Set(['c1', 'c2', 'c3']), count: 3, total: 3, marks, onUnread: () => {} },
  });
  assert.doesNotMatch(allRead, /只看未读/);
  assert.doesNotMatch(allRead, /下一未读章/);

  // Interactive harness for 只看未读 toggle & 下一未读章 wrap-around jump.
  let hooks = [], cursor = 0, tree = null, compProps = {};
  const hLocal = (type, p, ...children) => ({ $$type: type, props: { ...(p || {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } });
  const reactShim = {
    default: null,
    Fragment: Symbol('Fragment'),
    createElement: hLocal,
    memo: c => c,
    forwardRef: r => r,
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useMemo(fn, deps) { const i = cursor++, prev = hooks[i]; if (!prev || !deps || deps.some((d, k) => d !== prev.deps[k])) hooks[i] = { val: fn(), deps }; return hooks[i].val; },
    useEffect() {},
    useLayoutEffect() {},
    useInsertionEffect() {},
    useId() { return 'id'; },
    useCallback(fn) { return fn; },
    useSyncExternalStore(_sub, snap) { return snap(); },
  };
  reactShim.default = reactShim;
  globalThis.__OUTLINE_UI_REACT__ = reactShim;
  try {
    const built = await build({
      stdin: { contents: `export { default as OutlinePanel } from './ui/document-preview/reader/OutlinePanel.jsx';`, resolveDir: process.cwd() },
      bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' }, logLevel: 'silent',
      plugins: [{
        name: 'shim-outline',
        setup(builder) {
          builder.onResolve({ filter: /^react$|^react\/jsx-runtime$/ }, () => ({ path: 'react', namespace: 'sr' }));
          builder.onLoad({ filter: /.*/, namespace: 'sr' }, () => ({
            contents: `const R = globalThis.__OUTLINE_UI_REACT__; export default R; export const { Fragment, createElement, memo, forwardRef, useState, useRef, useMemo, useEffect, useLayoutEffect, useInsertionEffect, useId, useCallback, useSyncExternalStore } = R; export const jsx = (t, p) => R.createElement(t, p); export const jsxs = jsx; export const jsxDEV = jsx;`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'comp', namespace: 'sc' }));
          builder.onLoad({ filter: /.*/, namespace: 'sc' }, () => ({
            contents: `
              const R = globalThis.__OUTLINE_UI_REACT__;
              export const Button = p => R.createElement('button', { ...p, 'data-comp': 'Button' });
              export const Checkbox = p => R.createElement('input', { type: 'checkbox', ...p });
              export const Chip = p => R.createElement('button', { ...p, 'data-comp': 'Chip', 'aria-pressed': p.selected });
              export const Disclosure = p => R.createElement('div', { ...p }, p.children);
              export const DisclosureToggle = p => R.createElement('button', { ...p });
              export const Icon = p => R.createElement('span', { 'data-icon': p.name });
              export const IconButton = p => R.createElement('button', { ...p, 'aria-label': p.label });
              export const StackedBar = () => R.createElement('div', null);
              export const Tooltip = p => R.createElement('span', { 'data-tooltip': p.content }, p.children);`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /shared\.js$/ }, () => ({ path: 'shared', namespace: 'ss' }));
          builder.onLoad({ filter: /.*/, namespace: 'ss' }, () => ({ contents: `export const useInjectCss = () => {};`, loader: 'js' }));
        },
      }],
    });
    const mod = { exports: {} };
    new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
    const { OutlinePanel: Panel } = mod.exports;
    const expandNode = node => {
      if (Array.isArray(node)) return node.map(expandNode);
      if (!node || typeof node !== 'object') return node;
      if (typeof node.$$type === 'function') return expandNode(node.$$type(node.props));
      return node.props?.children ? { ...node, props: { ...node.props, children: expandNode(node.props.children) } } : node;
    };
    const renderPanel = next => { compProps = next; cursor = 0; tree = expandNode(Panel(compProps)); return tree; };
    const findAll = (pred, node = tree, out = []) => {
      if (!node || typeof node !== 'object') return out;
      if (Array.isArray(node)) { node.forEach(n => findAll(pred, n, out)); return out; }
      if (pred(node)) out.push(node);
      if (node.props?.children) findAll(pred, node.props.children, out);
      return out;
    };

    // Unread chapters are c2 (unread only if excluded from read set): set read = {'c2'} so unread are c1 and c3!
    const jumped = [];
    renderPanel({
      items: chapters,
      activeId: 'c1',
      meters,
      reads: { read: new Set(['c2']), count: 1, total: 3, marks, onUnread: () => {} },
      onJump: item => jumped.push(item.id),
      id: 'o',
    });

    // Clicking 下一未读章 from c1 jumps to c3 (next unread after activeId).
    findAll(n => n.props?.['data-comp'] === 'Button' && n.props?.children === '下一未读章')[0].props.onClick();
    // Moving activeId to c3 (last unread) wraps around to c1 (first unread).
    renderPanel({ ...compProps, activeId: 'c3' });
    findAll(n => n.props?.['data-comp'] === 'Button' && n.props?.children === '下一未读章')[0].props.onClick();
    assert.deepEqual(jumped, ['c3', 'c1']);

    // Toggling 只看未读 hides c2 while keeping c1, s1 (unread via c1 ancestor), and c3.
    findAll(n => n.props?.['data-comp'] === 'Chip' && n.props?.children === '只看未读')[0].props.onClick();
    renderPanel(compProps);
    const textOf = node => (typeof node === 'string' || typeof node === 'number') ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : node?.props?.children ? textOf(node.props.children) : '';
    const visibleTitles = findAll(n => n.props?.className === 'reader-outline__link').map(textOf);
    assert.deepEqual(visibleTitles, ['第一章 索引', 'B+ 树', '第三章 锁']);
  } finally {
    delete globalThis.__OUTLINE_UI_REACT__;
  }
});
