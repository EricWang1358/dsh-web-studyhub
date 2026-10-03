import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// P18 at the WP4 seam: 创建题组 chooses material by document. A PDF is one row
// (its pages on demand) and the count is in documents, not pages.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Generate } from './ui/Generate.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Generate, setUiLanguage } = module.exports;
const SHA = '5'.repeat(64);
const page = n => ({ id: `pdf-${SHA}-text2-p${n}`, title: `slides.pdf · p.${n}`, text: `page ${n}`, courses: ['数据库'],
  document: { id: SHA, filename: 'slides.pdf', page: n, totalPages: 4, extractionVersion: 2, warnings: [], materialId: `document-${SHA}-pdf`, format: 'pdf' } });
const sources = [page(1), page(2), page(3), page(4), { id: 'md', title: 'notes.md', text: '# n', courses: ['数据库'], document: { materialId: 'document-x-md', format: 'md' } }];
const gen = { kind: 'mixed', count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '' };
const noop = () => {};
const render = (selectedSources = []) => renderToStaticMarkup(React.createElement(Generate, {
  data: { root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: true, model: { ready: true, reason: 'ok' }, focus: { course: '数据库', courses: [{ name: '数据库' }] } },
  busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop, genSource: 'files', setGenSource: noop, gen, setGen: noop,
  selectedSources, setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop }));

test('the generation form lists documents and counts documents', () => {
  setUiLanguage('zh');
  const html = render([page(1).id, page(2).id, page(3).id, page(4).id]);
  const evidencePicker = html.match(/<fieldset data-tour="generate-sources">([\s\S]*?)<\/fieldset>/)?.[1];
  assert.ok(evidencePicker, 'the factual material picker is present');
  assert.equal((evidencePicker.match(/data-document-key="/g) || []).length, 2, 'a 4-page PDF and a Markdown file in factual selection');
  assert.match(evidencePicker, /已选择 1 \/ 2 份资料/);
  assert.match(evidencePicker, /PDF · 4 页/);
  assert.doesNotMatch(html, /slides\.pdf · p\.3|排版提取|旧版提取/);
  assert.match(html, /导入资料/, 'adding material still goes through the shared import dialog');
});
