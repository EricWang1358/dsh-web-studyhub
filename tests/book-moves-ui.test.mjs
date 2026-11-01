/* #461 on the book page: after the outline was organised again, the notice says how many points' notes moved and how many wait in 未归位, and the whole list (old
   title -> new title with the first line of the body under it; held points never drawn as moves) can always be opened again: 知道了 only folds the notice to one line.
   Static markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookMoves, MovesList, MovesReview, rememberMovesSeen } from './ui/book/BookMoves.jsx';
  export { default as BookRebuildPreview } from './ui/book/BookRebuildPreview.jsx';
  export { rebuildFailureText } from './ui/book/use-book-rebuild.js';
  export { qaAddFailureText } from './ui/book/BookQaButton.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const draw = (moves, props = {}) => renderToStaticMarkup(h(ui.BookMoves, { course: 'SA', moves, ...props }));
const list = moves => renderToStaticMarkup(h(ui.MovesList, { moves }));

test('the notice says how many moved and how many wait, and opens the whole list; held points are never drawn as moves; nothing to say draws nothing', () => {
  const both = draw({ at: '2026-10-25T00:00:00.000Z', list: [{ from: 'Lecture one', to: 'What architects do', folded: false, share: 1 }], total: 1, held: 2,
    heldList: [{ from: 'Cloud native', closest: 'Databases', share: 0.1 }, { from: 'Edge', closest: 'Databases', share: 0.05 }] });
  assert.match(both, /data-book-moves/);
  assert.match(both, /1 个知识点的笔记被移到了新位置/);
  assert.match(both, /data-book-held="">2 个知识点的笔记对不上新的知识点，放在「未归位」里/);
  assert.match(both, />查看每一处</);
  assert.match(both, />知道了</);
  assert.doesNotMatch(both, /Cloud native|Databases/, 'a held point is not drawn as a move to the closest point');
  const heldOnly = draw({ at: '2026-10-25T00:00:00.000Z', list: [], held: 1, heldList: [{ from: 'Cloud native', closest: 'Databases', share: 0.1 }] });
  assert.match(heldOnly, /1 个知识点的笔记对不上新的知识点/);
  assert.doesNotMatch(heldOnly, /被移到了新位置/);
  assert.equal(draw({ at: 'x', list: [], held: 0 }), '');
  assert.match(draw({ at: 'g', list: [], held: 0, gone: 2, goneList: [{ from: 'A' }, { from: 'B' }] }), /2 个知识点在新总纲里没有了/);
  ui.setUiLanguage('en');
  try {
    assert.match(draw({ at: 'y', list: [], held: 3 }), /The notes of 3 knowledge point\(s\) match no new point; they wait in Not placed/);
  } finally { ui.setUiLanguage('zh'); }
});

test('a move can always be reviewed: every stored row is drawn (no short cut), with the first line of its body; a cut list says so; old records without a first line still draw', () => {
  const rows = Array.from({ length: 636 }, (_, at) => ({ from: `Old ${at}`, to: `New ${at}`, folded: false, first: `Body ${at}` }));
  const whole = list({ at: 'z', total: 636, list: rows, held: 0 });
  assert.equal((whole.match(/data-book-move=/g) || []).length, 636);
  assert.match(whole, /「Old 635」→「New 635」/);
  assert.match(whole, /Body 635/);
  assert.doesNotMatch(whole, /还有|这里列出/);
  assert.match(list({ at: 'z', total: 250, list: rows.slice(0, 200), held: 0 }), /这里列出 200 个，一共 250 个/);
  const old = list({ at: 'o', revisionAfter: 3, list: [{ from: 'A', to: 'B', folded: true, share: 0.33 }], held: 1, heldList: [{ from: 'C', closest: 'D', share: 0.1, first: 'Note on C' }], gone: 1, goneList: [{ from: 'E', first: 'Note on E' }] });
  assert.match(old, /「A」并入「B」/);
  assert.match(old, /33%/);
  assert.match(old, /还没有正文/);
  assert.match(old, /「C」最接近「D」/);
  assert.match(old, /Note on C/);
  assert.match(old, /「E」/);
  assert.match(old, /Note on E/);
});

test('a record from before first lines existed does not say a body is missing: that would read like lost text', () => {
  const old = list({ at: 'o', list: [{ from: 'A', to: 'B', folded: false }], total: 1, held: 1, heldList: [{ from: 'C', closest: 'D', share: 0.1 }] });
  assert.doesNotMatch(old, /还没有正文/);
  assert.match(old, /「A」→「B」/);
});

test('a Q&A add refused while a rebuild waits says so in plain words: the op\'s name is for the main chat', () => {
  const refused = { code: 'course-book-rebuild-pending', message: '… course.book.rebuild {action, outlineId} …' };
  assert.match(ui.qaAddFailureText(refused), /打开复习全书/);
  assert.doesNotMatch(ui.qaAddFailureText(refused), /course\.book|outlineId/);
  assert.equal(ui.qaAddFailureText({ message: 'Other failure' }), 'Other failure');
  ui.setUiLanguage('en');
  try { assert.match(ui.qaAddFailureText(refused), /review book/); } finally { ui.setUiLanguage('zh'); }
});

test('知道了 folds the notice to one line that stays, with the way to the list', () => {
  const moves = { at: 'seen-1', list: [{ from: 'A', to: 'B' }], total: 1, held: 1 };
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key), key: at => [...storage.keys()][at] ?? null, get length() { return storage.size; } };
  globalThis.window ??= globalThis;
  try {
    assert.match(draw(moves), /data-book-moves=""/);
    ui.rememberMovesSeen('SA', moves.at);
    const line = draw(moves);
    assert.doesNotMatch(line, /data-book-moves=""/);
    assert.match(line, /data-book-moves-line/);
    assert.match(line, />查看</);
    assert.match(line, /1 个知识点的笔记换了位置/);
    assert.match(line, /1 个放在「未归位」/);
    // A new rebuild says it again.
    assert.match(draw({ ...moves, at: 'seen-2' }), /data-book-moves=""/);
  } finally { delete globalThis.localStorage; }
});

test('the review offers the undo only while it can work, and says why not', () => {
  const review = moves => renderToStaticMarkup(h(ui.MovesReview, { moves, onUndo() {} }));
  const open = { at: 'u', outlineId: 'o2', list: [{ from: 'A', to: 'B' }], total: 1, held: 0, undoable: true, revisionAfter: 5 };
  assert.match(review(open), />撤销这次整理</);
  const late = review({ ...open, undoable: false });
  assert.doesNotMatch(late, />撤销这次整理</);
  assert.match(late, /之后书又改过了/);
  // A record of a release that kept no state to go back to says nothing about an undo.
  const older = review({ at: 'u', list: [{ from: 'A', to: 'B' }], total: 1, held: 0, undoable: false });
  assert.doesNotMatch(older, /撤销/);
});

test('the preview before the text moves: the list, one main button, a quiet way out; the rules of both behind a Tooltip, no title on text', () => {
  const page = renderToStaticMarkup(h(ui.BookRebuildPreview, { moves: { at: 'p', outlineId: 'o2', list: [{ from: 'Cloud native', to: 'Databases', folded: false, share: 0.6, own: true, first: 'DDD 全套' }], total: 1, held: 1,
    heldList: [{ from: 'Edge', closest: 'Networks', share: 0.1 }] }, onApply() {}, onDiscard() {} }));
  assert.match(page, /data-book-rebuild-preview/);
  assert.match(page, /「Cloud native」→「Databases」/);
  assert.match(page, /DDD 全套/);
  assert.match(page, />按这样放</);
  assert.match(page, />放弃这次整理</);
  assert.doesNotMatch(page, /title="/);
  assert.match(page, /role="tooltip"/);
});

test('a refused undo says why in the learner\'s words, in either language', () => {
  assert.match(ui.rebuildFailureText({ code: 'course-book-rebuild-conflict' }), /之后.*改过/);
  assert.match(ui.rebuildFailureText({ code: 'course-book-rebuild-no-undo' }), /没有留下/);
  ui.setUiLanguage('en');
  try {
    assert.match(ui.rebuildFailureText({ code: 'course-book-rebuild-conflict' }), /changed/);
    assert.match(ui.rebuildFailureText({ code: 'course-book-rebuild-no-undo' }), /kept/);
  } finally { ui.setUiLanguage('zh'); }
});
