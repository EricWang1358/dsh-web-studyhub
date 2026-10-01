import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// P18 / P23: the Sources page lists documents (a PDF is one row with its pages
// on demand), opens the newest day, says things plainly, and acts on whole
// documents: generating from one passes every page, removing one removes
// every page after a confirmation.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default, removeDocument, courseAssignments } from './ui/Sources.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { default: Sources, removeDocument, courseAssignments, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const SHA = '7'.repeat(64);
const now = new Date().toISOString();
const page = n => ({ id: `pdf-${SHA}-text2-p${n}`, title: `lecture5-memory.pdf · p.${n}`, text: `第 ${n} 页 分页与虚拟内存`, createdAt: now, courses: ['操作系统'], usedBy: [],
  document: { id: SHA, filename: 'lecture5-memory.pdf', page: n, totalPages: 3, extractionVersion: 2, warnings: [], sparseText: false, materialId: `document-${SHA}-pdf`, format: 'pdf' } });
const md = { id: 'md-1', title: 'os-scheduling.md', text: '# 调度', createdAt: now, courses: ['操作系统'], usedBy: [],
  document: { materialId: 'document-m-md', materialRevision: 'r', format: 'md', filename: 'os-scheduling.md' } };
const older = { id: 'old-1', title: '进程与线程 · 第 3 周', text: '进程是资源分配单位。', createdAt: '2025-03-04T09:00:00.000Z', courses: [], usedBy: [] };
const sources = [page(1), page(2), page(3), md, older];
const data = { root: 'lib', sources, decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [{ name: '操作系统' }] }, modelReady: true };
const render = (props = {}) => renderToStaticMarkup(React.createElement(Sources, { data, act() {}, setModal() {}, onGenerate() {}, ...props }));
const rows = html => (html.match(/data-document-key="/g) || []).length;

test('a PDF is one row; pages stay inside it and the wording is plain', () => {
  setUiLanguage('zh');
  const html = render();
  assert.equal(rows(html), 2, 'today: the PDF and the Markdown file; the older day stays closed');
  assert.match(html, /lecture5-memory\.pdf/);
  assert.match(html, /PDF · 3 页/);
  assert.doesNotMatch(html, /lecture5-memory\.pdf · p\.2/);
  assert.doesNotMatch(html, /排版提取 v2|旧版提取/);
  assert.match(html, /Markdown/);
  assert.match(html, /共 3 份资料/, 'the count is in documents, not the 5 stored pages');
  assert.match(html, /从这份资料出题/);
  assert.match(html, /查看 3 页/, 'a multi-page document offers its page list');
});

test('the newest day is open and older days are collapsed', () => {
  setUiLanguage('zh');
  const html = render();
  const heads = [...html.matchAll(/class="source-group-head"[^>]*aria-expanded="(true|false)"|aria-expanded="(true|false)"[^>]*class="source-group-head"/g)]
    .map(match => match[1] || match[2]);
  assert.deepEqual(heads, ['true', 'false']);
  assert.doesNotMatch(html, /进程与线程/);
});

test('a freshly imported document is highlighted and its day opened', () => {
  setUiLanguage('zh');
  const html = render({ highlight: { ids: ['old-1'], at: 1 } });
  assert.match(html, /进程与线程/);
  assert.match(html, /data-new="true"/);
  assert.match(html, /刚导入/);
  assert.equal((html.match(/data-new="true"/g) || []).length, 1);
});

test('tour anchors mark the list and the add button, also on an empty library', () => {
  setUiLanguage('zh');
  const html = render();
  assert.match(html, /data-tour="sources-list"/);
  assert.match(html, /data-tour="sources-add"/);
  const empty = render({ data: { ...data, sources: [] }, sourceForm: React.createElement('div', { className: 'hub-stub' }, 'hub') });
  assert.match(empty, /data-tour="sources-list"/);
  assert.match(empty, /data-tour="sources-add"/);
  assert.match(empty, /hub-stub/, 'the import hub is the empty state');
});

test('removing a document removes every page and reports pages that could not go', async () => {
  const seen = [];
  const act = async (action, args, after) => { seen.push(['act', action, args.id]); if (after) await after({ ok: true }); return { ok: true }; };
  const call = async (action, args) => { seen.push(['call', action, args.id]); if (args.id.endsWith('p3')) throw new Error('Source is referenced by a deck or draft'); return { ok: true }; };
  const item = { sourceIds: [page(1).id, page(2).id, page(3).id] };
  const result = await removeDocument(item, { act, call });
  assert.deepEqual(seen.map(entry => entry.slice(0, 2).join(' ')), ['act source.remove', 'call source.remove', 'call source.remove']);
  assert.deepEqual(result.removed, [page(1).id, page(2).id]);
  assert.deepEqual(result.failed.map(entry => entry.id), [page(3).id]);
  const blocked = await removeDocument(item, { act: async () => undefined, call });
  assert.deepEqual(blocked.removed, []);
  assert.equal(blocked.failed.length, 3);
});

test('course assignments cover every page of the chosen documents', () => {
  const items = [{ key: 'pdf', sourceIds: [page(1).id, page(2).id] }, { key: 'md', sourceIds: ['md-1'] }];
  const byId = new Map(sources.map(source => [source.id, source]));
  assert.deepEqual(courseAssignments(items, ['pdf'], ['数据库'], byId), [
    { id: page(1).id, courses: ['数据库'], expectedCourses: ['操作系统'] },
    { id: page(2).id, courses: ['数据库'], expectedCourses: ['操作系统'] },
  ]);
});

test('the page reads in English apart from the learner’s own titles', () => {
  setUiLanguage('en');
  try {
    const html = render({ highlight: { ids: ['old-1'], at: 1 } });
    const text = html.replace(/<[^>]+>/g, ' ').replace(/lecture5-memory\.pdf|os-scheduling\.md|进程与线程 · 第 3 周|进程是资源分配单位。|# 调度|第 \d 页 分页与虚拟内存|操作系统/g, '');
    assert.doesNotMatch(text, han);
    assert.match(html, /PDF · 3 pages/);
  } finally { setUiLanguage('zh'); }
});
