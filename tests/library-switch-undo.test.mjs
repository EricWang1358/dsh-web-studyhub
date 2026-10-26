import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLibraryReset, useLibraryReset } from '../ui/app/library-state.js';

/* The library tie of 删除 with 撤销 (ui/undoable.js), at the two places the app changes library: a switch that already happened drops what was waiting and
   says so (createLibraryReset → abandonPending, unsentText → setError), and a move the learner makes sends what was waiting first (updateBinding awaits
   flushUndoable before binding.set). Review of #506, round 2: without these checks the wiring could go and every test stayed green. */

const deps = (log, extra = {}) => ({
  refs: { epoch: { current: 1 }, navigation: { current: 1 }, leaveTimer: { current: 0 }, examLocation: { current: null }, actRunner: { current: null } },
  quick: { reset() {} }, resetLibrary() {}, session: { reset() {} }, clearTimer() {}, setPageTarget() {}, setBusy() {}, setNotice() {}, setPage() {},
  setError: (value) => log.push(['error', value]),
  ...extra,
});

test('a library that changed by itself: the waiting deletions are abandoned before the epoch moves, and the learner is told how many', () => {
  const log = [];
  let epochWhenAbandoned = null;
  const fake = deps(log, {
    abandonPending: () => { epochWhenAbandoned = fake.refs.epoch.current; return 3; },
    unsentText: (count) => `学习库已更换：刚才的 ${count} 项删除没有执行，它们还在原来的学习库里。`,
  });
  createLibraryReset(fake)('switch');
  assert.equal(epochWhenAbandoned, 1, 'abandoned while the old epoch still stands');
  assert.equal(fake.refs.epoch.current, 2);
  assert.deepEqual(log.at(-1), ['error', '学习库已更换：刚才的 3 项删除没有执行，它们还在原来的学习库里。']);
});

test('nothing waiting: the error slot is simply cleared', () => {
  const log = [];
  createLibraryReset(deps(log, { abandonPending: () => 0, unsentText: () => 'never' }))('switch');
  assert.deepEqual(log.at(-1), ['error', '']);
});

test('useLibraryReset hands abandonPending and unsentText to the reset (App wires abandonUndoable)', () => {
  const app = readFileSync('ui/App.jsx', 'utf8');
  assert.match(app, /useLibraryReset\(\{[^}]*abandonPending: abandonUndoable/s);
  assert.match(app, /unsentText: \(count\) => uiFormat\('学习库已更换：刚才的 \{0\} 项删除没有执行，它们还在原来的学习库里。'/);
  assert.match(useLibraryReset.toString(), /abandonPending: \(\) => latest\.current\.abandonPending/);
});

test('a library move the learner makes sends what is waiting first: updateBinding awaits flushUndoable before epoch++ and binding.set', () => {
  const source = readFileSync('ui/app/use-library-connection.js', 'utf8');
  const body = source.slice(source.indexOf('async function updateBinding'), source.indexOf("call('binding.set'"));
  const flush = body.indexOf('await flushUndoable()'), epoch = body.indexOf('refs.epoch.current++');
  assert.ok(flush > 0, 'updateBinding awaits flushUndoable');
  assert.ok(epoch > flush, 'before the library epoch moves (a late answer would otherwise turn a done deletion into a false failure)');
});
