/* The "补全原文件" flow in the UI: the reader's notice, the dialog (choose, verify, mode, attach, relink) and the 资料 row
   menu entry, in Chinese and English. Pure logic and static markup; the layout is checked in the browser preview. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readAppSource } from './helpers/app-source.mjs';
import { withStudy } from './helpers/study-services.mjs';

const han = /[\u3400-\u9fff]/;
const compiled = await build({ stdin: { contents: `
  export * from './ui/document-preview/original-file.js';
  export { OriginalNotice, OriginalDialog, OriginalMenuEntry } from './ui/document-preview/OriginalFile.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const h = React.createElement, text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };
const noop = () => {};
/** The opening tag of the radio button with this value (attribute order does not matter). */
const radio = (html, value) => (html.match(/<input[^>]*type="radio"[^>]*>/g) || []).find(tag => tag.includes(`value="${value}"`)) || '';

const BOOK = 'D:\\Users\\Eric\\Documents\\courses\\databases\\week3\\Database System Concepts.pdf';
const none = { mode: null, status: 'none' };
const ref = { mode: 'reference', status: 'ok', path: BOOK, bytes: 24641536, format: 'pdf' };
const copy = { mode: 'copy', status: 'ok', bytes: 24641536, format: 'pdf' };
const MATCH = { verdict: 'match', accepted: true, pages: { stored: 120, supplied: 120, match: true }, checked: 60, matched: 60, similarity: 0.991, mismatchedPages: [], reasons: [], bytes: 24641536 };
const IDENTICAL = { verdict: 'identical', accepted: true, pages: { stored: 120, supplied: 120, match: true }, checked: 0, matched: 0, similarity: 1, mismatchedPages: [], reasons: [], bytes: 24641536 };
const MISMATCH = { verdict: 'mismatch', accepted: false, pages: { stored: 120, supplied: 98, match: false }, checked: 60, matched: 3, similarity: 0.31, mismatchedPages: [1, 2, 3], reasons: ['page-count', 'text'], bytes: 24641536 };
const target = { sourceId: 's1', title: 'Database System Concepts', format: 'pdf' };
const dialog = (initial, props = {}) => renderToStaticMarkup(h(lib.OriginalDialog, { target, call: noop, onClose: noop, onChanged: noop, initial, ...props }));

/* ---------- pure helpers ---------- */

test('a pasted, quoted, @-mentioned or file:// path becomes a plain absolute path', () => {
  assert.equal(lib.unquotePath('  "D:\\a b\\book.pdf" '), 'D:\\a b\\book.pdf');
  assert.equal(lib.unquotePath('@D:\\a\\book.pdf'), 'D:\\a\\book.pdf');
  assert.equal(lib.unquotePath('file:///D:/a%20b/book.pdf'), 'D:/a b/book.pdf');
  assert.equal(lib.unquotePath('file:///home/me/book.pdf'), '/home/me/book.pdf');
  assert.equal(lib.unquotePath('book.pdf'), 'book.pdf');
  assert.equal(lib.isAbsolutePath('D:\\a\\b.pdf'), true); assert.equal(lib.isAbsolutePath('D:/a/b.pdf'), true);
  assert.equal(lib.isAbsolutePath('/home/me/b.pdf'), true); assert.equal(lib.isAbsolutePath('\\\\server\\share\\b.pdf'), true);
  assert.equal(lib.isAbsolutePath('b.pdf'), false); assert.equal(lib.isAbsolutePath('..\\b.pdf'), false);
});

test('a long path is shortened in the middle and keeps the drive and the file name', () => {
  assert.equal(lib.shortPath(BOOK), 'D:\\…\\Database System Concepts.pdf');
  assert.equal(lib.shortPath('/home/me/courses/databases/book.pdf'), '/home/…/book.pdf');
  assert.equal(lib.shortPath('D:\\a\\book.pdf'), 'D:\\a\\book.pdf');
});

test('the row menu line says where the original is, in plain words', () => {
  assert.deepEqual(lib.originalLine(none).text, '原文件：未保存');
  assert.deepEqual(lib.originalLine(undefined).text, '原文件：未保存');
  assert.equal(lib.originalLine(ref).text, '原文件：引用 D:\\…\\Database System Concepts.pdf');
  assert.equal(lib.originalLine(ref).title, BOOK);
  assert.equal(lib.originalLine(copy).text, '原文件：已复制到资料库 · 23.5 MB');
  assert.equal(lib.originalLine({ ...ref, status: 'missing' }).tone, 'warning');
  assert.match(lib.originalLine({ ...ref, status: 'missing' }).text, /找不到/);
  assert.match(lib.originalLine({ ...ref, status: 'changed', reason: 'changed' }).text, /已被修改/);
  inLanguage('en', () => {
    assert.equal(lib.originalLine(none).text, 'Original file: not saved');
    assert.equal(lib.originalLine(ref).text, 'Original file: linked D:\\…\\Database System Concepts.pdf');
    assert.equal(lib.originalLine(copy).text, 'Original file: copied into the library · 23.5 MB');
  });
});

test('what is wrong with the original, and what can be done, is stated plainly', () => {
  assert.equal(lib.issueOf(ref), null);
  assert.equal(lib.issueOf(copy), null);
  assert.equal(lib.issueOf(none).kind, 'none');
  const missing = lib.issueOf({ ...ref, status: 'missing', reason: 'missing' });
  assert.equal(missing.message, `找不到原文件：${BOOK}`); assert.equal(missing.canCopy, false); assert.equal(missing.kind, 'missing');
  const changed = lib.issueOf({ ...ref, status: 'changed', reason: 'changed' });
  assert.equal(changed.message, '文件已被修改，和保存的文字对不上'); assert.equal(changed.canCopy, true);
  assert.match(lib.issueOf({ ...ref, status: 'changed', reason: 'redirected' }).message, /指向/);
  assert.equal(lib.issueOf({ mode: 'copy', status: 'missing' }).canCopy, false);
  inLanguage('en', () => {
    assert.equal(lib.issueOf({ ...ref, status: 'missing', reason: 'missing' }).message, `Original file not found: ${BOOK}`);
    assert.equal(lib.issueOf({ ...ref, status: 'changed', reason: 'changed' }).message, 'The file has been modified and no longer matches the saved text');
  });
});

test('the verification report reads as plain sentences; a mismatch says it may not be the same file', () => {
  assert.deepEqual(lib.reportHeadline(IDENTICAL), { tone: 'success', text: '核对通过：和保存文字时用的是同一个文件' });
  assert.deepEqual(lib.reportHeadline(MATCH), { tone: 'success', text: '核对通过：页数一致，文字对得上' });
  assert.deepEqual(lib.reportHeadline(MISMATCH), { tone: 'warning', text: '页数不同 / 文字对不上，可能不是同一份文件' });
  assert.deepEqual(lib.reportLines(MATCH).map(line => line.text), ['页数一致：120 页', '文字对得上：抽查 60 页，60 页一致，相似度 99.1%']);
  assert.deepEqual(lib.reportLines(MISMATCH).map(line => line.text), ['页数不同：保存的文字来自 120 页，这个文件有 98 页', '文字对不上：抽查 60 页，3 页一致，相似度 31%']);
  assert.deepEqual(lib.reportLines(IDENTICAL), []);
  inLanguage('en', () => {
    assert.equal(lib.reportHeadline(MISMATCH).text, 'Different page count / text does not match; this may not be the same file');
    assert.deepEqual(lib.reportLines(MATCH).map(line => line.text), ['Same page count: 120 pages', 'Text matches: 60 pages checked, 60 identical, 99.1% similar']);
  });
});

test('the two choices state their cost; without a path (a browser-chosen file) only the copy is possible', () => {
  const both = lib.modeOptions({ size: 24641536, hasPath: true });
  assert.deepEqual(both.map(option => option.value), ['reference', 'copy']);
  assert.equal(both[0].detail, '指给它原文件的位置（只记路径，不复制，不占空间；文件移动或删除后预览会提示找不到）');
  assert.equal(both[1].detail, '复制一份到资料库（约 23.5 MB，文件移动也不受影响）');
  assert.equal(both[0].disabled, false);
  assert.equal(lib.modeOptions({ size: 24641536, hasPath: false })[0].disabled, true);
  assert.equal(lib.defaultMode({ hasPath: true }), 'reference');
  assert.equal(lib.defaultMode({ hasPath: false }), 'copy');
  inLanguage('en', () => {
    assert.equal(lib.modeOptions({ size: 24641536, hasPath: true })[1].detail, 'Keep a copy in the library (about 23.5 MB; unaffected if the file moves)');
  });
});

test('attaching is allowed only after a verified report, with a confirmation for a mismatch, and by reference only with a path', () => {
  const path = { kind: 'path', path: BOOK }, file = { kind: 'file', name: 'x.pdf', size: 10 };
  assert.equal(lib.canAttach({ phase: 'verified', report: MATCH, picked: path, mode: 'reference', confirmed: false }), true);
  assert.equal(lib.canAttach({ phase: 'verified', report: MISMATCH, picked: path, mode: 'reference', confirmed: false }), false);
  assert.equal(lib.canAttach({ phase: 'verified', report: MISMATCH, picked: path, mode: 'reference', confirmed: true }), true);
  assert.equal(lib.canAttach({ phase: 'verifying', report: null, picked: path, mode: 'reference', confirmed: false }), false);
  assert.equal(lib.canAttach({ phase: 'verified', report: MATCH, picked: file, mode: 'reference', confirmed: false }), false);
  assert.equal(lib.canAttach({ phase: 'verified', report: MATCH, picked: file, mode: 'copy', confirmed: false }), true);
});

test('backend refusals are explained in the learner language', () => {
  assert.equal(lib.explainFailure('The file was not found: D:\\x.pdf'), '找不到这个文件：D:\\x.pdf');
  assert.equal(lib.explainFailure('Document path must be absolute'), '请填写完整路径（从盘符或 / 开始）');
  assert.match(lib.explainFailure('Document must be a file of at most 40 MB'), /40 MB/);
  assert.match(lib.explainFailure('The file must be the same type as the document (pdf), not txt'), /PDF/);
  assert.equal(lib.explainFailure('something else'), 'something else');
  inLanguage('en', () => assert.equal(lib.explainFailure('Document path must be absolute'), 'Enter the full path (starting with a drive letter or /)'));
});

/* ---------- the reader's notice ---------- */

test('the legacy notice names what is missing, what still works and both ways to fix it, with a button', () => {
  const html = renderToStaticMarkup(h(lib.OriginalNotice, { document: { format: 'pdf', original: none }, onAction: noop }));
  const words = text(html);
  assert.match(words, /没有原文件/); assert.match(words, /「原始 PDF」/); assert.match(words, /仍然可用/);
  assert.match(words, /只记路径，不占空间/); assert.match(words, /复制一份进资料库/); assert.match(words, /不会变/);
  assert.match(html, /<button[^>]*>补全原文件…<\/button>|<button[^>]*>.*补全原文件….*<\/button>/);
  const en = inLanguage('en', () => renderToStaticMarkup(h(lib.OriginalNotice, { document: { format: 'pdf', original: none }, onAction: noop })));
  assert.doesNotMatch(en, han);
  assert.match(text(en), /original file/i); assert.match(text(en), /Add the original file…/);
});

test('the notice for a text-only document can be closed, and closing it keeps a quiet way back instead of hiding the action', () => {
  const doc = { documentId: 'doc-1', format: 'pdf', original: none };
  const open = renderToStaticMarkup(h(lib.OriginalNotice, { document: doc, onAction: noop }));
  assert.match(open, /sh-inline__close/, 'there is a × on the full notice');
  assert.match(open, /aria-label="收起，之后在这里仍可补全原文件"/);
  // Closed: one quiet line, no box, no ×, and the action is still on the page.
  const closed = renderToStaticMarkup(h(lib.OriginalNotice, { document: doc, onAction: noop, collapsed: true }));
  assert.doesNotMatch(closed, /sh-inline__close/); assert.doesNotMatch(closed, /sh-inline--boxed/);
  assert.match(closed, /data-collapsed="true"/); assert.match(text(closed), /这份资料没有原文件/);
  assert.match(closed, /<button[^>]*>.*补全原文件….*<\/button>/);
  assert.doesNotMatch(text(closed), /只记路径|复制一份进资料库/, 'the long explanation is folded away');
  const en = inLanguage('en', () => renderToStaticMarkup(h(lib.OriginalNotice, { document: doc, onAction: noop, collapsed: true })));
  assert.doesNotMatch(en, han); assert.match(text(en), /no original file/i); assert.match(text(en), /Add the original file…/);
  const enOpen = inLanguage('en', () => renderToStaticMarkup(h(lib.OriginalNotice, { document: doc, onAction: noop })));
  assert.doesNotMatch(enOpen, han); assert.match(enOpen, /Close, you can still add the original file here/);
  // A reference that went missing or changed is a problem to fix, not a hint to close.
  const missing = renderToStaticMarkup(h(lib.OriginalNotice, { document: { ...doc, original: { ...ref, status: 'missing', reason: 'missing' } }, onAction: noop, collapsed: true }));
  assert.doesNotMatch(missing, /sh-inline__close/); assert.doesNotMatch(missing, /data-collapsed/); assert.match(missing, /重新指定…/);
});

test('which documents the learner closed the notice for is remembered per viewer, and a broken store changes nothing', () => {
  const store = new Map();
  const storage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) };
  assert.equal(lib.noticeCollapsed('doc-1', storage), false);
  assert.equal(lib.collapseNotice('doc-1', storage), true);
  assert.equal(lib.noticeCollapsed('doc-1', storage), true);
  assert.equal(lib.noticeCollapsed('doc-2', storage), false, 'another document still shows the full notice');
  assert.equal(lib.noticeCollapsed('', storage), false);
  // At most 200 documents are remembered, the oldest forgotten first.
  for (let index = 0; index < 250; index += 1) lib.collapseNotice(`bulk-${index}`, storage);
  assert.equal(lib.noticeCollapsed('bulk-249', storage), true); assert.equal(lib.noticeCollapsed('doc-1', storage), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  assert.equal(lib.noticeCollapsed('doc-1', broken), false); assert.equal(lib.collapseNotice('doc-1', broken), false);
  store.set('study-original-notice', '{not json'); assert.equal(lib.noticeCollapsed('doc-1', storage), false);
});

test('a referenced file that is missing or changed says so, with 重新指定 and, while the file exists, 改为复制到资料库', () => {
  const missing = renderToStaticMarkup(h(lib.OriginalNotice, { document: { format: 'pdf', original: { ...ref, status: 'missing', reason: 'missing' } }, onAction: noop }));
  assert.match(text(missing), new RegExp(`找不到原文件：${BOOK.replace(/[\\.]/g, '\\$&')}`));
  assert.match(missing, /重新指定…/); assert.doesNotMatch(missing, /改为复制到资料库/);
  const changed = renderToStaticMarkup(h(lib.OriginalNotice, { document: { format: 'pdf', original: { ...ref, status: 'changed', reason: 'changed' } }, onAction: noop }));
  assert.match(text(changed), /文件已被修改，和保存的文字对不上/);
  assert.match(changed, /重新指定…/); assert.match(changed, /改为复制到资料库/);
  const en = inLanguage('en', () => renderToStaticMarkup(h(lib.OriginalNotice, { document: { format: 'pdf', original: { ...ref, status: 'changed', reason: 'changed' } }, onAction: noop })));
  assert.doesNotMatch(en.replace(BOOK, ''), han);
  assert.match(en, /Choose another file…/); assert.match(en, /Copy into the library instead/);
});

test('a document whose original is fine shows no notice', () => {
  assert.equal(renderToStaticMarkup(h(lib.OriginalNotice, { document: { format: 'pdf', original: ref, originalAvailable: true }, onAction: noop })), '');
  assert.equal(renderToStaticMarkup(h(lib.OriginalNotice, { document: null, onAction: noop })), '');
});

/* ---------- the dialog ---------- */

test('choosing: what is missing, the path field with its label, the file picker and nothing to attach yet', () => {
  const html = dialog({ info: none });
  const words = text(html);
  assert.match(words, /补全原文件/); assert.match(words, /Database System Concepts/);
  assert.match(html, /<input[^>]*aria-label="原文件的完整路径"/);
  assert.match(html, /type="file"/);
  assert.match(words, /选择文件…/);
  assert.match(html, /<button[^>]*disabled[^>]*>.*附上原文件/);
  assert.doesNotMatch(words, /只记路径/, 'the two choices appear once a file has been checked');
});

test('verifying: the file name, its size and a status; no choice yet', () => {
  const html = dialog({ info: none, picked: { kind: 'path', path: BOOK, size: 24641536 }, phase: 'verifying' });
  assert.match(html, /role="status"/); assert.match(text(html), /正在核对文字/); assert.match(text(html), /23\.5 MB/);
  assert.doesNotMatch(text(html), /只记路径/);
});

test('verified: the report, then two real radio buttons with their costs, reference selected, 附上原文件 enabled', () => {
  const html = dialog({ info: none, picked: { kind: 'path', path: BOOK, size: 24641536 }, phase: 'verified', report: MATCH, mode: 'reference' });
  const words = text(html);
  assert.match(words, /核对通过：页数一致，文字对得上/); assert.match(words, /页数一致：120 页/);
  assert.match(html, /<fieldset/); assert.match(html, /<legend[^>]*>怎样保存这个文件/);
  assert.match(radio(html, 'reference'), /checked/); assert.doesNotMatch(radio(html, 'reference'), /disabled/);
  assert.notEqual(radio(html, 'copy'), ''); assert.doesNotMatch(radio(html, 'copy'), /checked/);
  assert.match(words, /指给它原文件的位置（只记路径，不复制，不占空间；文件移动或删除后预览会提示找不到）/);
  assert.match(words, /复制一份到资料库（约 23\.5 MB，文件移动也不受影响）/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>[^<]*附上原文件/);
  assert.doesNotMatch(words, /仍要附上/);
});

test('a browser-chosen file has no path: the copy is the only choice and the reason is given', () => {
  const html = dialog({ info: none, picked: { kind: 'file', name: 'book.pdf', size: 2048000 }, phase: 'verified', report: IDENTICAL, mode: 'copy' });
  assert.match(radio(html, 'reference'), /disabled/); assert.match(radio(html, 'copy'), /checked/);
  assert.match(text(html), /浏览器不会告诉我们文件在哪里/);
});

test('mismatch: a clear warning, the figures, and an unchecked confirmation that gates the button', () => {
  const html = dialog({ info: none, picked: { kind: 'path', path: BOOK, size: 24641536 }, phase: 'verified', report: MISMATCH, mode: 'reference', confirmed: false });
  const words = text(html);
  assert.match(html, /role="alert"/);
  assert.match(words, /页数不同 \/ 文字对不上，可能不是同一份文件/);
  assert.match(words, /页数不同：保存的文字来自 120 页，这个文件有 98 页/);
  assert.match(html, /<input[^>]*type="checkbox"(?![^>]*checked)[^>]*>/); assert.match(words, /我确认这是同一份资料，仍要附上/);
  assert.match(html, /<button[^>]*disabled[^>]*>.*附上原文件/);
  const confirmed = dialog({ info: none, picked: { kind: 'path', path: BOOK, size: 24641536 }, phase: 'verified', report: MISMATCH, mode: 'reference', confirmed: true });
  assert.doesNotMatch(confirmed, /<button[^>]*disabled[^>]*>[^<]*附上原文件/);
});

test('attached: the result and where the original is now', () => {
  const byReference = dialog({ info: ref, phase: 'done', done: { mode: 'reference' } });
  assert.match(text(byReference), /已附上原文件/); assert.match(text(byReference), /引用/); assert.match(byReference, /title="D:\\Users\\Eric/);
  const byCopy = dialog({ info: copy, phase: 'done', done: { mode: 'copy' } });
  assert.match(text(byCopy), /已复制到资料库/); assert.match(text(byCopy), /23\.5 MB/);
});

test('an original that is already attached by reference offers to point elsewhere, copy it or let go', () => {
  const html = dialog({ info: ref });
  assert.match(text(html), /原文件：引用/); assert.match(html, /重新指定…/); assert.match(html, /改为复制到资料库/); assert.match(html, /不再引用/);
  assert.doesNotMatch(html, /type="file"/, 'the picker appears only after choosing to point elsewhere');
});

test('a missing referenced file opens on the problem with the way to fix it, and the picker', () => {
  const html = dialog({ info: { ...ref, status: 'missing', reason: 'missing' } });
  assert.match(text(html), /找不到原文件：D:\\Users/); assert.match(html, /type="file"/); assert.match(html, /aria-label="原文件的完整路径"/);
});

test('a copy that is already in the library needs nothing', () => {
  const html = dialog({ info: copy });
  assert.match(text(html), /原文件已经复制在资料库里/); assert.doesNotMatch(html, /type="file"/);
});

test('a failure stays on screen as an alert in the learner language', () => {
  const html = dialog({ info: none, phase: 'error', error: 'The file was not found: D:\\x.pdf', pathText: 'D:\\x.pdf' });
  assert.match(html, /role="alert"/); assert.match(text(html), /找不到这个文件：D:\\x\.pdf/);
});

test('the whole dialog has no Chinese in English, apart from the learner own file names', () => {
  inLanguage('en', () => {
    const states = [{ info: none }, { info: none, picked: { kind: 'path', path: BOOK, size: 24641536 }, phase: 'verifying' },
      { info: none, picked: { kind: 'path', path: BOOK, size: 24641536 }, phase: 'verified', report: MATCH, mode: 'reference' },
      { info: none, picked: { kind: 'path', path: BOOK, size: 24641536 }, phase: 'verified', report: MISMATCH, mode: 'copy', confirmed: false },
      { info: none, picked: { kind: 'file', name: 'book.pdf', size: 99 }, phase: 'verified', report: IDENTICAL, mode: 'copy' },
      { info: ref }, { info: { ...ref, status: 'missing', reason: 'missing' } }, { info: { ...ref, status: 'changed', reason: 'changed' } },
      { info: copy }, { info: ref, phase: 'done', done: { mode: 'reference' } }, { info: none, phase: 'error', error: 'The file was not found: D:\\x.pdf' }];
    for (const state of states) {
      const html = dialog(state, { target: { ...target, title: 'Database System Concepts' } });
      assert.doesNotMatch(html.replaceAll(BOOK, ''), han, JSON.stringify(state));
    }
    const words = text(dialog({ info: none, picked: { kind: 'path', path: BOOK, size: 24641536 }, phase: 'verified', report: MATCH, mode: 'reference' }));
    assert.match(words, /Link to the file/); assert.match(words, /nothing is copied, no space used/); assert.match(words, /about 23\.5 MB/);
  });
});

/* ---------- the 资料 row menu ---------- */

test('the row menu entry: one button, a one-line status, nothing for an audio transcript or without a way to call', () => {
  const entry = (props = {}) => {
    const { call: given, ...rest } = props, call = 'call' in props ? given : noop; // an explicit `call: undefined` is a host that offers nothing
    return renderToStaticMarkup(withStudy(lib.StudyServicesContext, h(lib.OriginalMenuEntry, { item: { sourceIds: ['s1'], format: 'pdf', title: 'Book' }, ...rest }), { call }));
  };
  assert.match(entry({}), /<button[^>]*>补全原文件…<\/button>/);
  assert.match(entry({ initial: ref }), /<button[^>]*>管理原文件…<\/button>/);
  assert.match(text(entry({ initial: ref })), /原文件：引用 D:\\…\\Database System Concepts\.pdf/);
  assert.match(text(entry({ initial: copy })), /原文件：已复制到资料库 · 23\.5 MB/);
  assert.equal(entry({ item: { sourceIds: ['a'], format: 'audio' } }), '');
  assert.equal(entry({ call: undefined }), '', 'a host that offers nothing to call');
  assert.match(inLanguage('en', () => entry({})), />Add the original file…</);
  assert.doesNotMatch(inLanguage('en', () => entry({ initial: ref })).replaceAll(BOOK, '').replace('D:\\…\\Database System Concepts.pdf', ''), han);
});

test('the three entry points are mounted where the brief says, and nowhere else', async () => {
  const viewer = await readFile('ui/document-preview/DocumentViewer.jsx', 'utf8'), sources = await readFile('ui/Sources.jsx', 'utf8');
  assert.match(viewer, /OriginalNotice/); assert.match(viewer, /OriginalDialog/);
  assert.doesNotMatch(viewer, /这份旧资料保存了提取文字/, 'the old one-line message is gone');
  assert.match(sources, /<OriginalMenuEntry /);
});

test('the backup screen says referenced originals are not included, and the export tells how many were left out', async () => {
  const settings = await readFile('ui/settings/BackupSection.jsx', 'utf8'), app = await readAppSource(), catalogue = JSON.parse(await readFile('ui/locales/en.original.json', 'utf8'));
  const note = '已复制到资料库的原文件会放进备份；只记了路径的原文件留在你的电脑上，不在备份里，换电脑后需要重新指定。';
  assert.ok(settings.includes(note)); assert.match(catalogue[note], /not in the backup/);
  assert.match(app, /portableMaterials\?\.referencedOriginals\?\.length/);
  const count = '备份已导出。其中 {0} 份原文件只记了路径，没有放进备份；换电脑后需要重新指定。';
  assert.ok(app.includes(count)); assert.match(catalogue[count], /not in the backup/);
});
