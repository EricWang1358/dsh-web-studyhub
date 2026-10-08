import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { documentIndexState } from '../ui/index-coverage.js';

const compiled = await build({ stdin: { contents: "export { default as IndexBadge, indexLabel } from './ui/IndexBadge.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { IndexBadge, indexLabel, setUiLanguage } = mod.exports;

/* A material row says whether its search index is built. The pure part: the state of one document from the coverage the backend reports
   (retrieval.index.coverage), and the plain words for it. */

const item = (ids) => ({ key: 'doc', sourceIds: ids });
const coverage = (extra = {}) => ({ indexed: [], stale: [], missing: [], hasIndex: true, canIndex: true, building: null, ...extra });

test('a document is indexed, partly indexed, stale, missing or being built, counted page by page', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.equal(documentIndexState(item(ids), coverage({ indexed: ids })).state, 'indexed');
  const partial = documentIndexState(item(ids), coverage({ indexed: ['a', 'b'], missing: ['c', 'd'] }));
  assert.deepEqual([partial.state, partial.indexed, partial.total], ['partial', 2, 4]);
  const stale = documentIndexState(item(ids), coverage({ indexed: ['a', 'b', 'c'], stale: ['d'] }));
  assert.deepEqual([stale.state, stale.stale, stale.indexed], ['stale', 1, 3]);
  const missing = documentIndexState(item(ids), coverage({ missing: ids }), { big: true });
  assert.deepEqual([missing.state, missing.total], ['missing', 4]);
  const building = documentIndexState(item(ids), coverage({ missing: ids, building: { course: '*', stage: 'indexing', done: 3, total: 20 } }));
  assert.equal(building.state, 'building');
  const half = documentIndexState(item(ids), coverage({ indexed: ['a'], missing: ['b', 'c', 'd'], building: { course: '*', stage: 'indexing', done: 3, total: 20 } }));
  assert.equal(half.state, 'building', 'a document that is not complete yet while a build runs');
  assert.equal(documentIndexState(item(ids), coverage({ indexed: ids, building: { done: 1, total: 2 } })).state, 'indexed', 'a finished document stays indexed while others are built');
});

test('nothing is said when nothing is known: no coverage yet, an empty document, or small notes without an index', () => {
  assert.equal(documentIndexState(item(['a']), null), null, 'still loading');
  assert.equal(documentIndexState(item([]), coverage()), null);
  assert.equal(documentIndexState(item(['a']), coverage({ hasIndex: false, missing: ['a'] })), null, 'no index in this library: a small note stays quiet');
  assert.equal(documentIndexState(item(['a']), coverage({ hasIndex: false, missing: ['a'] }), { big: true }).state, 'missing', 'a big book is where the index matters: it says so even before the first build');
  assert.equal(documentIndexState(item(['a']), coverage({ hasIndex: true, missing: ['a'] })), null, 'a small note without an index is normal: no loud "not indexed" on every row');
  assert.equal(documentIndexState(item(['a']), coverage({ hasIndex: true, indexed: ['a'] })).state, 'indexed', 'but a built index is always shown');
  assert.equal(documentIndexState(item(['a', 'b']), coverage({ hasIndex: true, indexed: ['a'], missing: ['b'] })).state, 'partial', 'and so is a half-built one');
});

test('plain words, with the page counts, in both languages and without telling what cannot be done', () => {
  assert.equal(indexLabel({ state: 'indexed', indexed: 404, total: 404 }, { canIndex: true }), '索引已建好 · 这份资料 404/404 页');
  assert.equal(indexLabel({ state: 'partial', indexed: 120, total: 404, stale: 0 }, { canIndex: true }), '索引建了一部分 · 这份资料 120/404 页');
  assert.equal(indexLabel({ state: 'stale', stale: 3, indexed: 401, total: 404 }, { canIndex: true }), '索引需要更新 · 这份资料有 3 页改过');
  assert.equal(indexLabel({ state: 'missing', total: 404 }, { canIndex: true }), '还没建索引');
  assert.equal(indexLabel({ state: 'missing', total: 404 }, { canIndex: false }), '还没建索引（需要先安装检索扩展）');
  assert.equal(indexLabel({ state: 'building', indexed: 10, total: 404 }, { canIndex: true, building: { done: 3, total: 20 } }), '正在建立索引…');
});

test('the badge renders as a quiet chip with the state on it, in both languages, and nothing when there is nothing to say', () => {
  const info = { state: 'indexed', indexed: 404, total: 404, stale: 0 };
  const html = renderToStaticMarkup(React.createElement(IndexBadge, { info, coverage: { canIndex: true, building: null } }));
  assert.match(html, /class="sh-badge sh-badge--sm index-badge"[^>]*data-state="indexed"/);
  assert.match(html, /data-tone="success"/);
  assert.match(html, /索引已建好 · 这份资料 404\/404 页/);
  assert.equal(renderToStaticMarkup(React.createElement(IndexBadge, { info: null, coverage: null })), '');
  setUiLanguage('en');
  try {
    const en = renderToStaticMarkup(React.createElement(IndexBadge, { info: { state: 'partial', indexed: 120, total: 404, stale: 0 }, coverage: { canIndex: true } }));
    assert.match(en, /Index partly built · this material 120\/404 pages/);
    assert.doesNotMatch(en, /[㐀-鿿]/);
    assert.match(renderToStaticMarkup(React.createElement(IndexBadge, { info: { state: 'missing', total: 4 }, coverage: { canIndex: false } })), /Not indexed yet \(install the search extension first\)/);
  } finally { setUiLanguage('zh'); }
});
