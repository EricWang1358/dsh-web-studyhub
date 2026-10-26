import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/* The two tiers of deletion (ui/DESIGN.md Confirmations, 3.7.0 D1). Tier 1 (资料, 题目 / 题组) keeps archive-first and PermanentDeleteDialog; a draft asks once,
   in DeleteDraftDialog; everything else is one click with 撤销 (ui/undoable.js). These guards keep a new irreversible deletion off InlineConfirm and off a
   "tap twice" label swap, and keep the pages that were moved to 撤销 on it. */

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(jsx?|mjs)$/.test(name) ? [path.replace(/\\/g, '/')] : [];
});
const read = (file) => readFileSync(file, 'utf8');
const files = walk('ui').filter((file) => !file.includes('/locales/'));

test('no InlineConfirm asks about a deletion: an irreversible one is a ConfirmDialog, any other one is 删除 with 撤销', () => {
  const offenders = [];
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/<InlineConfirm\b[\s\S]*?(?:\/>|<\/InlineConfirm>)/g))
      if (/删除|清空|永久/.test(match[0])) offenders.push(`${file}: ${match[0].slice(0, 120)}`);
  }
  assert.deepEqual(offenders, []);
});

test('no "tap twice to confirm": a button never swaps its label to 确认删除 / 确认清空 / 确认移除, and nothing is "armed" for a deletion', () => {
  const offenders = files.filter((file) => /\?\s*(?:ui|uiFormat)\(\s*["'`]确认(?:删除|清空|移除|永久删除)/.test(read(file)) || /\b(?:delete|remove|clear)Armed/i.test(read(file)));
  assert.deepEqual(offenders, []);
});

test('tier 2 pages delete through the shared undo (commitLater), with no dialog of their own for it', () => {
  const pages = {
    'ui/tasks/TaskConsole.jsx': /job\.dismiss|batchRun\('delete'/,
    'ui/BlogNotes.jsx': /note\.delete/,
    'ui/Workflows.jsx': /workflow\.session\.delete/,
    'ui/PdfConvertJob.jsx': /mineru\.history\.clear/,
    'ui/LiveClass.jsx': /live\.delete/,
    'ui/document-preview/DocumentLearning.jsx': /materials\.annotation\.delete/,
    'ui/SkeletonDiagrams.jsx': /skeleton\.diagram\.remove/,
  };
  for (const [file, operation] of Object.entries(pages)) {
    const source = read(file);
    assert.match(source, /useUndoable\(\)/, `${file} uses the shared undo`);
    assert.match(source, /commitLater\(/, `${file} sends its deletion when the 撤销 time is over`);
    assert.match(source, operation, `${file} still deletes through its own operation`);
  }
  assert.equal(existsSync('ui/tasks/DeleteTasksDialog.jsx'), false);
  assert.doesNotMatch(read('ui/LiveHistory.jsx'), /live-history-confirm|永久删除/);
  assert.doesNotMatch(read('ui/document-preview/AskThread.jsx'), /ConfirmDialog/);
  assert.doesNotMatch(read('ui/SkeletonDiagrams.jsx'), /ConfirmDialog/);
});

test('a draft asks once, in the one DeleteDraftDialog, from the draft page and from the 待发布 row', () => {
  const dialog = read('ui/DeleteDraftDialog.jsx');
  assert.match(dialog, /<ConfirmDialog/);
  assert.match(dialog, /draftVersion: draft\.draftVersion/, 'the version check stays');
  assert.match(dialog, /cancelLabel=\{ui\('保留'\)\}/);
  for (const file of ['ui/Draft.jsx', 'ui/study-map/HomeActivity.jsx']) assert.match(read(file), /<DeleteDraftDialog/, file);
  assert.doesNotMatch(read('ui/Draft.jsx'), /确认删除草稿（无法撤销）|deleteArmed/);
});

test('tier 1 is not loosened: sources and decks are deleted for good only from the archive, through PermanentDeleteDialog; an archive offers 撤销 and 永久删除…', () => {
  const sources = read('ui/Sources.jsx'), decks = read('ui/RemoveDeckDialog.jsx'), manage = read('ui/Manage.jsx');
  assert.match(sources, /<PermanentDeleteDialog/);
  assert.match(sources, /const blocked = item\.usedBy\.length > 0 \|\| !item\.archived/);
  assert.match(decks, /<PermanentDeleteDialog/);
  assert.match(decks, /const eligible = deck\.archived && !deck\.systemKind/);
  for (const [file, source] of [['ui/Sources.jsx', sources], ['ui/Manage.jsx', manage]]) {
    assert.match(source, /offerRestore\(toast/, `${file}: the archive says so with 撤销`);
    assert.match(source, /ui\(['"]永久删除…['"]\)/, `${file}: and offers the second step`);
  }
  assert.match(manage, /结束了 \{1\} 轮进行中的练习/, 'the deck archive says how many practice runs it ended');
});

test('the words: 永久删除 is irreversible, 移除 takes out of a container; the source dialog no longer mixes them', () => {
  const sources = read('ui/Sources.jsx');
  assert.doesNotMatch(sources, /从资料列表移除|不能移除|再移除资料|已移除「/);
  assert.match(sources, /已永久删除「\{0\}」/);
  for (const file of ['ui/tasks/TaskConsole.jsx', 'ui/tasks/CompactJobCard.jsx']) assert.doesNotMatch(read(file), />\{ui\(['"]知道了['"]\)\}</, `${file}: the archive button says 归档`);
});
