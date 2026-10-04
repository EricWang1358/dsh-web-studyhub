import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 1, WP-B: the call sites that moved onto the overlay primitives.
const read = file => readFileSync(file, 'utf8');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as CardEditor } from './ui/board/CardEditor.jsx';
  export { default as DeleteCardDialog } from './ui/board/DeleteCardDialog.jsx';
  export { RemoveSampleDialog } from './ui/tour/SampleControls.jsx';
  export { UsageSettingsView } from './ui/UsageSettings.jsx';
  export { default as SubmitBlanksDialog } from './ui/SubmitBlanksDialog.jsx';
  export { default as ShortcutHelp } from './ui/ShortcutHelp.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const lacks = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} still has ${pattern}`); };
const has = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.match(text, pattern, `${file} lacks ${pattern}`); };

const card = { id: 'a', title: '读论文', labels: [], createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T09:30:00.000Z' };
const board = { revision: 3, columns: [{ id: 'todo', title: '待办', done: false, cardIds: ['a'] }], cards: { a: card }, archived: [] };

test('the board has one delete confirmation: the menu and the editor open the same dialog (#68 #70)', () => {
  m.setUiLanguage('zh');
  const dialog = html(m.DeleteCardDialog, { card, onConfirm() {}, onClose() {} });
  assert.match(dialog, /删除这张卡片？/);
  assert.match(dialog, /sh-btn--quiet[^>]*>保留/);
  assert.match(dialog, /sh-btn--danger[^>]*>[^<]*(<[^>]+>)*确认删除/);
  assert.match(dialog, /读论文/);
  const purge = html(m.DeleteCardDialog, { card, purge: true, onConfirm() {}, onClose() {} });
  assert.match(purge, /永久删除这张卡片？/);
  has('ui/Board.jsx', /DeleteCardDialog/);
  has('ui/board/CardEditor.jsx', /DeleteCardDialog/);
  lacks('ui/Board.jsx', /<Dialog\b/, /\bsetTimeout\b/);
  lacks('ui/board/CardEditor.jsx', /alertdialog/, /board-editor__confirm/, /if \(!saving\) onClose/);
  const editor = html(m.CardEditor, { card, board, library: {}, today: '2026-10-02', onSave() {}, onArchive() {}, onDelete() {}, onClose() {} });
  assert.doesNotMatch(editor, /alertdialog/);
  assert.match(editor, /<button[^>]*>[^<]*(<[^>]+>)*删除<\/button>/, 'the delete trigger stays in the footer');
});

test('the board undo toast is a shared undo toast: timeout and hold come from Feedback (#90)', () => {
  const board = read('ui/Board.jsx');
  assert.match(board, /undo: true/);
  assert.match(board, /timeout: UNDO_TIMEOUT/);
  assert.doesNotMatch(board, /persistent: true/);
  assert.doesNotMatch(board, /setTimeout|clearTimeout/);
});

test('every confirmation dialog is a ConfirmDialog, none builds its own footer (#68)', () => {
  has('ui/tour/SampleControls.jsx', /ConfirmDialog/);
  has('ui/UsageSettings.jsx', /ConfirmDialog/);
  has('ui/WorkflowScope.jsx', /ConfirmDialog/);
  has('ui/CaseWorkspace.jsx', /SubmitBlanksDialog/);
  has('ui/Exam.jsx', /SubmitBlanksDialog/);
  lacks('ui/tour/SampleControls.jsx', /<Dialog\b/);
  lacks('ui/UsageSettings.jsx', /<Dialog\b/);
  lacks('ui/WorkflowScope.jsx', /<Dialog\b/);
  lacks('ui/CaseWorkspace.jsx', /<Dialog\b/);
  m.setUiLanguage('zh');
  const sample = html(m.RemoveSampleDialog, { onConfirm() {}, onClose() {} });
  assert.match(sample, /移除示例数据？/);
  assert.ok(sample.indexOf('取消') < sample.lastIndexOf('移除示例数据'), 'cancel before confirm');
  const usage = html(m.UsageSettingsView, { status: { enabled: true, hasData: true, daysWithData: 2, since: '2026-10-01' }, period: 30, confirming: true,
    onAskClear() {}, onCancelClear() {}, onClear() {} });
  assert.match(usage, /删除全部使用记录？/);
  assert.match(usage, /sh-btn--quiet[^>]*>取消/);
});

test('both exams ask the same blank-answer question (#70)', () => {
  m.setUiLanguage('zh');
  const out = html(m.SubmitBlanksDialog, { onConfirm() {}, onClose() {} }, h('p', null, '第 2 题还是空的。'));
  assert.match(out, /还有题目没有作答/);
  assert.match(out, /第 2 题还是空的/);
  assert.match(out, /sh-btn--quiet[^>]*>继续作答/);
  assert.match(out, /sh-btn--primary[^>]*>[^<]*仍然交卷/);
  lacks('ui/Exam.jsx', /exam-confirm/, /alertdialog/);
});

test('inline confirmations all use InlineConfirm and their CSS families are gone (#69)', () => {
  has('ui/CourseSettings.jsx', /InlineConfirm/);
  has('ui/Workflows.jsx', /InlineConfirm/);
  has('ui/MineruSettings.jsx', /InlineConfirm/);
  lacks('ui/CourseSettings.jsx', /course-settings__confirm/);
  lacks('ui/Workflows.jsx', /wf-confirm/);
  lacks('ui/MineruSettings.jsx', /mineru-confirm/);
  lacks('ui/course-settings.css', /course-settings__confirm/);
  lacks('ui/workflows.css', /wf-confirm/);
  lacks('ui/views.css', /exam-confirm/);
  lacks('ui/mineru.css', /\.mineru-confirm/);
  lacks('ui/board/board.css', /board-editor__confirm/, /\.board-menu/, /board-confirm__title/);
});

test('the skeleton delete is a ConfirmDialog, not a second tap on a changed label (#69)', () => {
  has('ui/Skeleton.jsx', /ConfirmDialog/);
  lacks('ui/Skeleton.jsx', /再点一次删除/);
});

test('a Dialog with busy replaces the hand-written onClose guards in the files this wave owns (#72)', () => {
  has('ui/CourseSettings.jsx', /busy=\{working\}/);
  lacks('ui/CourseSettings.jsx', /if \(!working\) onClose/);
  has('ui/board/CardEditor.jsx', /busy=\{saving\}/);
});

test('outside-click and Escape handling for popovers lives in useDismiss (#80)', () => {
  const files = ['ui/CourseField.jsx', 'ui/ReviewToolbar.jsx', 'ui/reading-settings/ReadingSettings.jsx', 'ui/document-preview/practice/ReadingPractice.jsx',
    'ui/document-preview/translation/TranslationMenu.jsx'];
  for (const file of files) {
    lacks(file, /document\.addEventListener\(['"](pointerdown|mousedown|click)['"]/);
    has(file, /useDismiss|<Popover\b|<Menu\b/);
  }
});

test('popover triggers never combine aria-pressed with aria-expanded (#82)', () => {
  for (const file of ['ui/reading-settings/ReadingSettings.jsx', 'ui/document-preview/translation/TranslationMenu.jsx']) {
    const text = read(file);
    for (const tag of text.match(/<(IconButton|Button|button)\b[^>]*aria-expanded[^>]*>/g) || []) assert.doesNotMatch(tag, /aria-pressed/, `${file}: ${tag.slice(0, 80)}`);
    assert.doesNotMatch(text, /aria-pressed=\{open\}/, file);
  }
});

test('no bare × glyph buttons remain in the files this wave owns (#83)', () => {
  for (const file of ['ui/board/CardEditor.jsx', 'ui/ShortcutHelp.jsx', 'ui/Board.jsx', 'ui/CourseSettings.jsx']) lacks(file, />×<\/button>/);
});

test('the shortcut sheet closes with the shared CloseButton (#83 #82)', () => {
  has('ui/ShortcutHelp.jsx', /CloseButton/);
  lacks('ui/ShortcutHelp.jsx', /coach-chip/);
  m.setUiLanguage('zh');
  const out = html(m.ShortcutHelp, { page: 'home', onClose() {} });
  assert.match(out, /aria-label="关闭快捷键"/);
  assert.match(out, /sh-btn--icon/);
  assert.match(out, /role="dialog"/);
  assert.doesNotMatch(out, />\s*Esc\s*<\/button>/);
});
