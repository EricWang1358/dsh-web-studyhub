/* 资料重命名 on the screen: the inline editor, the reader header, the 资料 row (one additive menu entry, F2 / double-click, 原名),
   the plain error sentences and the keyboard, in Chinese and English. Static markup and pure logic; the layout is checked in the
   browser preview (scripts/qa/rename.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ stdin: { contents: `
  export { default as Sources, RowMenuItems } from './ui/Sources.jsx';
  export { documentSearchText } from './ui/SourcePicker.jsx';
  export { RenameField, ReaderHeading } from './ui/document-preview/RenameTitle.jsx';
  export * from './ui/document-preview/rename.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const h = React.createElement, han = /[㐀-鿿]/;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };
const noop = () => {};

const SHA = '7'.repeat(64), now = new Date().toISOString();
const page = (n, extra = {}) => ({ id: `pdf-${SHA}-text2-p${n}`, title: `Databases lecture · p.${n}`, text: `page ${n}`, createdAt: now, courses: ['DB'], usedBy: [], renamedFrom: 'lecture5.pdf',
  document: { id: SHA, filename: 'lecture5.pdf', bookTitle: 'Databases lecture', page: n, totalPages: 2, extractionVersion: 2, materialId: `document-${SHA}-pdf`, format: 'pdf' }, ...extra });
const note = { id: 'n1', title: 'Pasted notes', text: 'hello', createdAt: now, courses: ['DB'], usedBy: [] };
const data = { root: 'lib', sources: [page(1), page(2), note], decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [{ name: 'DB' }] }, modelReady: true };
const renderSources = (props = {}) => renderToStaticMarkup(h(lib.Sources, { data, act: noop, call: noop, setModal: noop, onGenerate: noop, ...props }));

/* ---------- the rules, in plain words ---------- */

test('what is typed is checked with the host rules and a problem is one plain sentence', () => {
  assert.deepEqual(lib.validateTitle('  OS   notes ', 'old'), { ok: true, title: 'OS notes', unchanged: false });
  assert.equal(lib.validateTitle('OS notes', 'OS notes').unchanged, true);
  assert.equal(lib.validateTitle('   ', 'old').problem, '请输入名称');
  assert.equal(lib.validateTitle('x'.repeat(201), 'old').problem, '名称最多 200 个字符');
  assert.equal(lib.validateTitle('a\u0000b', 'old').problem, '名称里不能有控制字符');
  assert.equal(lib.validateTitle('...', 'old').problem, '名称不能只有点号');
  inLanguage('en', () => {
    assert.equal(lib.validateTitle('', 'old').problem, 'Enter a name');
    assert.equal(lib.validateTitle('x'.repeat(201), 'old').problem, 'The name can be at most 200 characters');
    assert.equal(lib.validateTitle('..', 'old').problem, 'The name needs more than dots');
  });
});

test('a host failure becomes a sentence a learner can act on', () => {
  assert.match(lib.explainRename(new Error('The document title has changed since it was read (expected "a", it is "b"); reload and try again')), /刚刚被改过/);
  assert.match(lib.explainRename(new Error('Material document or source not found')), /找不到这份资料/);
  assert.match(lib.explainRename(new Error('Document title must be at most 200 characters')), /200/);
  assert.equal(lib.explainRename(new Error('')), '没能改名，请重试。');
  inLanguage('en', () => {
    assert.match(lib.explainRename(new Error('Material document revision is stale; reload the document and try again')), /renamed a moment ago/);
    assert.doesNotMatch(lib.explainRename(new Error('Material document or source not found')), han);
  });
});

test('the keyboard: Enter saves, Esc cancels, F2 starts (never with a modifier, never while composing)', () => {
  assert.equal(lib.fieldKeyAction({ key: 'Enter' }), 'save');
  assert.equal(lib.fieldKeyAction({ key: 'Enter', isComposing: true }), null, 'confirming an IME candidate is not a save');
  assert.equal(lib.fieldKeyAction({ key: 'Escape' }), 'cancel');
  assert.equal(lib.fieldKeyAction({ key: 'a' }), null);
  assert.equal(lib.startsEditing({ key: 'F2' }), true);
  assert.equal(lib.startsEditing({ key: 'F2', ctrlKey: true }), false);
  assert.equal(lib.startsEditing({ key: 'Enter' }), false);
});

test('the call carries what the person saw, names the document by its identity, and goes through the page action runner', async () => {
  const [item] = (await import('../lib/source-groups.js')).groupSourcesByDocument(data.sources);
  assert.deepEqual(lib.renameArgs(item, { title: 'New' }), { documentId: `document-${SHA}-pdf`, expectedTitle: 'Databases lecture', title: 'New' });
  assert.deepEqual(lib.renameArgs(item, { restore: true }), { documentId: `document-${SHA}-pdf`, expectedTitle: 'Databases lecture', restore: true });
  const pasted = (await import('../lib/source-groups.js')).groupSourcesByDocument([note])[0];
  assert.deepEqual(lib.renameArgs(pasted, { title: 'Week 1' }), { sourceId: 'n1', expectedTitle: 'Pasted notes', title: 'Week 1' });
  const calls = [];
  const act = async (action, args, after, options) => { calls.push({ action, args, options }); return { status: 'renamed', title: args.title }; };
  assert.deepEqual(await lib.renameDocument({ act }, pasted, { title: 'Week 1' }), { status: 'renamed', title: 'Week 1' });
  assert.equal(calls[0].action, 'materials.document.rename');
  assert.equal(calls[0].options.rethrow, true, 'a failure reaches the editor, not a banner somewhere else');
  await assert.rejects(lib.renameDocument({ act: async () => undefined }, pasted, { title: 'x' }), /另一个操作还在进行/, 'a dropped (busy) action is said, not silent');
  assert.equal(lib.originalNote(item), '原名：lecture5.pdf');
  assert.equal(lib.originalNote(pasted), '');
});

test('the picker finds a renamed document by its new name, its file name and the name it had before', async () => {
  const [item] = (await import('../lib/source-groups.js')).groupSourcesByDocument(data.sources);
  const found = query => lib.documentSearchText(item).toLowerCase().includes(query);
  assert.ok(found('databases lecture') && found('lecture5.pdf'));
  assert.ok(found('lecture5'));
  assert.equal(found('unrelated'), false);
  const [plain] = (await import('../lib/source-groups.js')).groupSourcesByDocument([note]);
  assert.doesNotMatch(lib.documentSearchText(plain), /undefined/);
});

/* ---------- the editor ---------- */

test('the editor shows the name selected, the old name as placeholder, Save and Cancel, and the keys it understands', () => {
  const html = renderToStaticMarkup(h(lib.RenameField, { title: 'lecture5.pdf', onSave: noop, onCancel: noop }));
  assert.match(html, /<input[^>]*type="text"[^>]*value="lecture5\.pdf"/);
  assert.match(html, /placeholder="lecture5\.pdf"/);
  assert.match(html, /aria-label="新名称"/);
  assert.match(text(html), /保存 取消/);
  assert.doesNotMatch(html, /恢复原名/, 'a document that was never renamed has nothing to restore');
  assert.match(text(html), /Enter 保存，Esc 取消。只改名称，原文、页码、引用和题目都不变。/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, /aria-describedby="[^"]+"/);
});

test('a renamed document offers 恢复原名 (with the old name on hover) and a problem is announced', () => {
  const html = renderToStaticMarkup(h(lib.RenameField, { title: 'Databases lecture', original: 'lecture5.pdf', onSave: noop, onRestore: noop, onCancel: noop, problem: '名称最多 200 个字符' }));
  assert.match(html, /恢复原名/);
  assert.match(html, /title="原名：lecture5\.pdf"/);
  assert.match(html, /role="alert"[^>]*>名称最多 200 个字符</);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /data-state="problem"/);
});

test('the editor in English has no Chinese left', () => {
  inLanguage('en', () => {
    const html = renderToStaticMarkup(h(lib.RenameField, { title: 'Databases lecture', original: 'lecture5.pdf', onSave: noop, onRestore: noop, onCancel: noop, problem: lib.titleProblem('empty') }));
    assert.doesNotMatch(text(html), han);
    assert.match(html, /aria-label="New name"/);
    assert.match(text(html), /Save Cancel Restore original name/);
    assert.match(html, /title="Originally: lecture5\.pdf"/);
    assert.match(text(html), /Only the name changes/);
  });
});

/* ---------- the reader header ---------- */

test('the reader header shows the document name from the library, a 重命名 button, and F2 / double-click to edit', () => {
  const html = renderToStaticMarkup(h(lib.ReaderHeading, { data, source: data.sources[1], act: noop, call: noop }));
  assert.match(text(html), /Databases lecture 重命名/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-keyshortcuts="F2"/);
  assert.match(html, /title="Databases lecture\n原名：lecture5\.pdf"/);
  assert.doesNotMatch(html, /· p\.2/, 'a page of a PDF is shown as the document');
  const editing = renderToStaticMarkup(h(lib.ReaderHeading, { data, source: data.sources[1], act: noop, call: noop, edit: true }));
  assert.match(editing, /aria-label="重命名「Databases lecture」"/);
  assert.match(editing, /恢复原名/);
  assert.match(editing, /rename-field--header/);
  inLanguage('en', () => { assert.doesNotMatch(text(renderToStaticMarkup(h(lib.ReaderHeading, { data, source: data.sources[1], act: noop, call: noop }))), han); });
});

test('the header follows a rename made elsewhere (it reads the library, not the page that was opened) and a part of a recording keeps its number', () => {
  const stale = { ...data.sources[0] }; // the object the dialog was opened with still carries the old title
  const renamed = { ...data, sources: data.sources.map(source => source.id === stale.id ? { ...source, title: 'Another name · p.1', document: { ...source.document, bookTitle: 'Another name' } } : { ...source, title: source.title.replace('Databases lecture', 'Another name'), document: { ...source.document, bookTitle: source.document?.bookTitle && 'Another name' } }) };
  assert.match(text(renderToStaticMarkup(h(lib.ReaderHeading, { data: renamed, source: stale, act: noop }))), /Another name/);
  const parts = [1, 2].map(n => ({ id: `r${n}`, title: `PE1 · 中英对照逐字稿 (${n}/2)`, text: 'x', createdAt: now, courses: [], usedBy: [], audio: { batch: { id: 'b', title: 'PE1', volume: n, volumes: 2 }, sourceIds: ['r1', 'r2'] } }));
  assert.match(text(renderToStaticMarkup(h(lib.ReaderHeading, { data: { sources: parts }, source: parts[1], act: noop }))), /PE1 · 第 2 部分/);
  assert.equal(renderToStaticMarkup(h(lib.ReaderHeading, { data: { sources: [] }, source: { id: 'gone', title: 'Gone' }, act: noop })), 'Gone');
  assert.doesNotMatch(renderToStaticMarkup(h(lib.ReaderHeading, { data, source: data.sources[0] })), /重命名/, 'with no way to call the host there is nothing to offer');
});

/* ---------- the 资料 row ---------- */

test('the row menu gets ONE additive entry, 重命名…, only when renaming is possible', () => {
  const item = { sourceIds: ['a'], format: 'md', title: 'x', usedBy: [], courses: [] };
  const base = renderToStaticMarkup(h(lib.RowMenuItems, { item, busy: false, onChangeCourse: noop, onRemove: noop }));
  const withRename = renderToStaticMarkup(h(lib.RowMenuItems, { item, busy: false, onChangeCourse: noop, onRemove: noop, onRename: noop }));
  assert.doesNotMatch(base, /重命名/);
  assert.equal((withRename.match(/重命名…/g) || []).length, 1);
  assert.equal(withRename.replace(/<button[^>]*>重命名…<\/button>/, ''), base, 'nothing else in the menu changed');
  assert.match(withRename, /<button[^>]*>重命名…<\/button>[\s\S]*改课程…/, 'it sits before 改课程');
  inLanguage('en', () => assert.match(renderToStaticMarkup(h(lib.RowMenuItems, { item, busy: false, onRename: noop, onRemove: noop })), /Rename…/));
});

test('a row can be renamed from its menu, F2 and a double-click on the title; a renamed document says what it was called', () => {
  const html = renderSources();
  assert.match(html, /重命名…/);
  assert.match(html, /aria-keyshortcuts="F2"/);
  assert.match(html, /<strong class="source-title" title="Databases lecture">Databases lecture<\/strong>/);
  assert.match(html, /<small class="source-original" title="lecture5\.pdf">原名：lecture5\.pdf<\/small>/);
  assert.equal((html.match(/source-original/g) || []).length, 1, 'only the renamed document carries it');
  const plain = renderSources({ act: undefined, call: undefined });
  assert.doesNotMatch(plain, /重命名…|F2/, 'without a way to call the host the row is exactly what it was');
  inLanguage('en', () => {
    const english = renderSources();
    assert.match(english, /Rename…/);
    assert.match(english, /Originally: lecture5\.pdf/);
    assert.doesNotMatch(text(english.replace(/<strong[^>]*>[^<]*<\/strong>/g, '').replace(/class="source-excerpt[^>]*>[^<]*/g, '')), /原名|重命名/);
  });
});
