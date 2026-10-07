import test from 'node:test';
import assert from 'node:assert/strict';

/* 2.5.8: the step panel for a book whose back matter is an optional step: it is off by default, said so in words (both languages), the pages of a step are shown,
   and only the steps in use are counted by the queue button. */

async function load() {
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const out = await build({ stdin: { contents: "export { default as GenerationPath, stepTitle, stepPages } from './ui/GenerationPath.jsx'; export { useGenerationPath } from './ui/use-generation-path.js'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  // The state lives in a hook (the form's own button queues the steps); the panel draws it.
  const Harness = props => React.createElement(mod.exports.GenerationPath, { path: mod.exports.useGenerationPath(props), onUseStep: props.onUseStep });
  return { ...mod.exports, Harness, React, renderToStaticMarkup };
}

const page = (n, title, index) => ({ id: `b${n}`, title: `Book · p.${n}`, chars: 1000, document: { id: 'h', page: n, totalPages: 36, bookTitle: 'Book', origin: 'converted', converter: 'mineru', chapter: { index, title, level: 1 } } });
const book = [...Array.from({ length: 30 }, (_, i) => page(i + 1, 'Alpha', 0)), ...Array.from({ length: 6 }, (_, i) => page(31 + i, 'Index', 1))];
const noop = () => {};

test('the index of a book is an optional step: off by default, said in words, not counted by the queue button, in both languages', async () => {
  const { Harness, setUiLanguage, React, renderToStaticMarkup } = await load();
  const render = () => renderToStaticMarkup(React.createElement(Harness, { sources: book, selectedIds: book.map(source => source.id), gen: {}, course: 'OS', call: noop, askInChat: noop, setNotice: noop, onUseStep: noop }));
  const zh = render();
  assert.match(zh, /可选 · 默认跳过（索引）/);
  assert.match(zh, /勾选就会包含这一步/, 'the way to include it');
  const items = zh.split('<li ').slice(1);
  assert.equal(items.length, 3, 'two steps of the chapter (30 pages) and the index');
  const optional = items.find(item => item.includes('data-optional="true"'));
  assert.ok(optional, 'the index step is marked optional');
  assert.match(optional, /data-included="false"/);
  assert.doesNotMatch(optional.match(/<input type="checkbox"[^>]*>/)[0], /checked/, 'unchecked by default');
  for (const item of items.filter(item => !item.includes('data-optional="true"'))) assert.match(item.match(/<input type="checkbox"[^>]*>/)[0], /checked/, 'the chapter steps are on');
  assert.equal((zh.match(/<input type="checkbox"[^>]*checked/g) || []).length, 2, 'only the two chapter steps are in use (the button of the form counts them)');
  assert.match(zh, /1 个可选步骤默认跳过（索引等）/, 'the step that is off by default is one folded line');
  assert.match(zh, /第 31–36 页/, 'the pages of the step');
  setUiLanguage('en');
  try {
    const en = render();
    assert.match(en, /Optional · skipped by default \(Index\)/);
    assert.match(en, /Tick the box to include this step/);
    assert.match(en, /1 optional step\(s\) skipped by default \(Index, …\)/);
    assert.match(en, /Pages 31–36/);
    assert.doesNotMatch(en, /[㐀-鿿]/, 'no Han in the English panel');
  } finally { setUiLanguage('zh'); }
});

test('a step with no usable chapter name is named by its pages, in English too, never by a cut-off word', async () => {
  const { stepTitle, stepPages, setUiLanguage } = await load();
  const step = { title: 'S · 第 5–9 页', parts: [{ documentKey: 'd', chapter: '', front: false, whole: false, from: 5, to: 9 }], ranges: [{ document: 'Book', from: 5, to: 9 }] };
  assert.equal(stepTitle({ ...step, title: '第 5–9 页' }), '第 5–9 页');
  setUiLanguage('en');
  try {
    assert.equal(stepTitle(step), 'Pages 5–9');
    assert.equal(stepPages(step, 'Pages 5–9'), '', 'not repeated when the name already says it');
    assert.equal(stepPages(step, 'Taxonomy'), 'Pages 5–9');
    assert.equal(stepTitle({ title: 'x', parts: [{ documentKey: 'd', chapter: '', front: true, whole: true, from: 1, to: 4 }] }), 'Front matter and contents');
  } finally { setUiLanguage('zh'); }
});
