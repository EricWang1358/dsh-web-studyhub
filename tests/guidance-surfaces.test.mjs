/* 3.7 guidance, step 0: the proactive surfaces that exist today listen to 设置 › 引导 (the master switch and their own switch), and nothing else about
   them changes: with nothing stored they show exactly as before. The first-run line is not proactive and does not listen. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export { useReaderHint, forgetClosedHints, closeHint, hintClosed } from './ui/document-preview/reader/hints.js';
  export { default as TopicGroupReminder } from './ui/study-map/TopicGroupReminder.jsx';
  export { GUIDANCE_KEY } from './ui/guidance/budget.js';
  export { clearItem, guidanceItem } from './ui/guidance/registry.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const lib = module.exports, h = React.createElement;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}
/** Run `body` with a browser localStorage holding `initial`. */
function withStorage(initial, body) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = memoryStorage(initial);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return body(storage); } finally { if (before) Object.defineProperty(globalThis, 'localStorage', before); else delete globalThis.localStorage; }
}
const hintShown = id => renderToStaticMarkup(h(function Probe() { const [shown] = lib.useReaderHint(id); return h('i', null, shown ? 'shown' : 'hidden'); }));
const reminder = () => renderToStaticMarkup(h(lib.TopicGroupReminder, { grouping: { ungrouped: 5, groups: 2, topics: 30 }, root: '/lib' }));

test('the reader hints: shown as before; the master switch or their own switch keeps them away', () => {
  lib.forgetClosedHints();
  withStorage({}, () => assert.match(hintShown('pdf-page'), /shown/, 'nothing stored: as before'));
  withStorage({ [lib.GUIDANCE_KEY]: JSON.stringify({ off: true }) }, () => {
    assert.match(hintShown('pdf-page'), /hidden/);
    assert.match(hintShown('page-presets'), /hidden/);
  });
  withStorage({ [lib.GUIDANCE_KEY]: JSON.stringify({ muted: ['reader.pdf-page'] }) }, () => {
    assert.match(hintShown('pdf-page'), /hidden/, 'its own switch');
    assert.match(hintShown('page-presets'), /shown/, 'the other one is untouched');
  });
});

test('a reader hint closed with storage comes back once Settings clears it, in the same visit', () => {
  lib.forgetClosedHints();
  withStorage({}, storage => {
    assert.equal(lib.closeHint('pdf-page'), true);
    assert.match(hintShown('pdf-page'), /hidden/);
    assert.equal(lib.clearItem(lib.guidanceItem('reader.pdf-page'), { local: storage, session: null }), true);
    assert.match(hintShown('pdf-page'), /shown/, 'no leftover memory of this visit hides it');
  });
  // Without storage the visit still remembers the closing (unchanged).
  assert.equal(lib.closeHint('pdf-page', null), false);
  assert.equal(lib.hintClosed('pdf-page', null), true);
  lib.forgetClosedHints();
});

test('the topic-group reminder: shown as before; hidden by the master switch or its own switch; its 稍后 memory unchanged', () => {
  lib.setUiLanguage('zh');
  withStorage({}, () => assert.match(reminder(), /有 5 个主题还没归入主题组/));
  withStorage({ [lib.GUIDANCE_KEY]: JSON.stringify({ off: true }) }, () => assert.equal(reminder(), ''));
  withStorage({ [lib.GUIDANCE_KEY]: JSON.stringify({ muted: ['library.topic-groups'] }) }, () => assert.equal(reminder(), ''));
  withStorage({ 'study-topic-group-later:/lib': '2:5' }, () => assert.equal(reminder(), '', '稍后 still holds until the grouping changes'));
});
