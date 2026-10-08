/* 每日讲解合集: the tone choice is folded (the Settings default is used unless the learner opens it), the generate button waits for a model instead of failing afterwards,
   and the pointers to Settings are links. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';

/* ---------- the server says whether a model is there ---------- */

test('the recap status says whether a model can write it, so the page can wait instead of failing afterwards', async (t) => {
  const open = async (options) => {
    const root = await mkdtemp(join(tmpdir(), 'study-recap-gate-'));
    const service = new StudyService(root, options);
    t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
    return service;
  };
  assert.equal((await (await open({})).call('note.daily.status', {})).modelReady, false);
  assert.equal((await (await open({ complete: async () => 'x' })).call('note.daily.status', {})).modelReady, true);
});

/* ---------- the page ---------- */

const require = createRequire(import.meta.url);
globalThis.document = { querySelector: () => ({ textContent: '' }) };
const built = await build({ stdin: { contents: `export { DailyRecapPanel } from './ui/DailyRecap.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const load = (fn) => { const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(fn, module, module.exports); return module.exports; };
let active;
const hook = (initial) => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
const hooks = { ...React,
  useState: (initial) => { const owner = active, [index, value] = hook(() => typeof initial === 'function' ? initial() : initial);
    return [value, (next) => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
  useContext: () => null, useRef: (value) => hook(() => ({ current: value }))[1], useId: () => hook(() => `field-${active.cursor}`)[1],
  useInsertionEffect: () => {}, useEffect: (callback, deps) => { const [, slot] = hook(() => ({ deps: undefined, cleanup: null }));
    if (!slot.deps || deps.some((value, index) => value !== slot.deps[index])) { active.effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); slot.deps = deps; } },
};
const { DailyRecapPanel, setUiLanguage } = load((name) => (name === 'react' ? hooks : require(name)));
function view(props) {
  const owner = { cursor: 0, slots: [], effects: [] };
  return { render(next = {}) { owner.cursor = 0; active = owner; try { return DailyRecapPanel({ ...props, ...next }); } finally { active = null; } },
    effects() { owner.effects.splice(0).forEach((callback) => callback()); } };
}
const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const group = (extra) => ({ day: '2026-10-04', course: 'Databases', courseId: 'db', answeredCount: 10, wrongCount: 2, eligible: true, remaining: 0, ...extra });
const status = (extra = {}, groups = [group()]) => ({ day: '2026-10-04', tone: 'friendly', automatic: false, groups, ...extra });
async function open(statusValue, props = {}) {
  const editor = view({ root: 'r', call: async () => statusValue, ...props });
  editor.render(); editor.effects(); await settle();
  const tree = editor.render();
  return { tree, html: renderToStaticMarkup(tree), editor };
}
const generate = (tree) => find(tree, (node) => node.props?.onClick && node.props.children === '生成今日合集');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('without a model the generate button waits and one line says why, with the way to the model settings', async () => {
  setUiLanguage('zh');
  const opened = [];
  const { tree, html } = await open(status({ modelReady: false }), { onModelSettings: () => opened.push('model') });
  assert.equal(generate(tree).props.disabled, true);
  assert.equal((text(html).match(/整理合集需要先配置模型/g) || []).length, 1, 'said once for the panel, not once per course');
  const action = find(tree, (node) => node.props?.action?.label === '打开模型设置');
  action.props.action.onClick();
  assert.deepEqual(opened, ['model']);
});

test('with a model, or an older host that does not say, nothing changes', async () => {
  for (const extra of [{ modelReady: true }, {}]) {
    const { tree, html } = await open(status(extra));
    assert.equal(generate(tree).props.disabled, false);
    assert.doesNotMatch(text(html), /整理合集需要先配置模型/);
  }
});

test('on the result page the panel is plain, so the page keeps its one filled button; elsewhere the generate button stays the primary one', async () => {
  assert.equal(generate((await open(status(), { primary: false })).tree).props.variant, 'secondary');
  assert.equal(generate((await open(status())).tree).props.variant, 'primary');
});

test('a recap that is already written can still be read without a model', async () => {
  const { tree } = await open(status({ modelReady: false }, [group({ noteId: 'n', hasContent: true, stale: true })]), { onOpenNote: () => {} });
  const read = find(tree, (node) => node.props?.onClick && node.props.children === '阅读今日合集');
  assert.equal(read.props.disabled, false);
  assert.equal(find(tree, (node) => node.props?.onClick && node.props.children === '更新今日合集').props.disabled, true, 'updating it is a model call');
});

test('the tone is folded: the Settings default is named on the fold, and the choice is one click inside it', async () => {
  setUiLanguage('zh');
  const { html } = await open(status({ tone: 'professional' }, [group({ tone: 'professional' })]));
  const fold = html.match(/<details class="daily-recap-tone-fold"[^>]*>[\s\S]*?<\/details>/)?.[0] || '';
  assert.match(fold, /<summary>[^<]*讲解口吻[^<]*专业[^<]*<\/summary>/);
  assert.match(fold, /type="radio"/);
  assert.doesNotMatch(fold, /<details[^>]*open/);
  assert.equal((html.match(/type="radio"/g) || []).length, 2, 'both tones, inside the fold only');
});

test('the pointers to Settings are links', async () => {
  setUiLanguage('zh');
  const noSettings = (await open(status())).html;
  assert.doesNotMatch(noSettings, /前往设置/, 'a page that cannot open Settings draws no dead link');
  const opened = [];
  const { tree, html } = await open(status(), { onSettings: () => opened.push('recap') });
  assert.match(text(html), /自动生成可在设置里开启/);
  const link = find(tree, (node) => node.props?.onClick && node.props.children === '前往设置');
  assert.ok(link, 'a link next to the sentence');
  link.props.onClick();
  assert.deepEqual(opened, ['recap']);
});

test('English: the new lines are translated', async () => {
  setUiLanguage('en');
  try {
    const { html } = await open(status({ modelReady: false }), { onModelSettings: () => {}, onSettings: () => {} });
    assert.doesNotMatch(text(html).replace(/Databases/g, ''), /[㐀-鿿]/);
    assert.match(text(html), /Go to settings/);
  } finally { setUiLanguage('zh'); }
});
