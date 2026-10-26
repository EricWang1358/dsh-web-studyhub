import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// ui/undoable.js: 删除 with 撤销 (commitLater) and 撤销 of an operation that has an inverse (restoreWith). The fake toast below is the app's one notice slot:
// a newer notice, a close or a timeout makes the one that was up leave, and leaving calls its onLeave (ui/ActionFeedback.jsx useNotice).
const m = await loadUi(`export { createUndoable, registerUndoable, flushUndoable, abandonUndoable, UNDO_TIMEOUT } from './ui/undoable.js'; export { setUiLanguage } from './ui/i18n.js';`);

function fakeToast() {
  const log = { shown: [], errors: [], current: null };
  const leave = () => { const was = log.current; log.current = null; was?.onLeave?.(); };
  return {
    log,
    show(notice) { leave(); log.current = notice; log.shown.push(notice); },
    error(error) { log.errors.push(typeof error === 'string' ? error : error?.message); },
    dismiss() { leave(); },
    timeout() { leave(); },
  };
}
const tick = () => new Promise((done) => setImmediate(done));

function setup() {
  const toast = fakeToast(), calls = [];
  let changes = 0;
  const unit = m.createUndoable({ toast, onChange: () => { changes++; } });
  const commit = (name, result = { ok: true }) => async () => { calls.push(name); if (result instanceof Error) throw result; return result; };
  return { toast, unit, calls, commit, changes: () => changes };
}

test('commitLater hides at once, shows 撤销, and sends nothing until the notice leaves', async () => {
  const { toast, unit, calls, commit } = setup();
  const entry = unit.commitLater({ keys: ['n1'], message: '已删除「笔记」', commit: commit('n1') });
  assert.ok(entry);
  assert.equal(unit.hidden('n1'), true);
  assert.equal(unit.hidden('n2'), false);
  assert.equal(toast.log.current.message, '已删除「笔记」');
  assert.equal(toast.log.current.undo, true);
  assert.equal(toast.log.current.timeout, m.UNDO_TIMEOUT);
  assert.equal(toast.log.current.action.label, '撤销');
  await tick();
  assert.deepEqual(calls, [], 'nothing is sent while 撤销 is still possible');
  toast.timeout();
  await tick();
  assert.deepEqual(calls, ['n1'], 'the time ran out: the host is asked once');
  assert.equal(unit.hidden('n1'), true, 'a committed item stays hidden (the next snapshot no longer has it)');
});

test('撤销 shows the item again and the host is never asked, even when the notice leaves afterwards', async () => {
  const { toast, unit, calls, commit } = setup();
  unit.commitLater({ keys: ['t1', 't2'], message: '已删除 2 个任务', commit: commit('t') });
  const undo = toast.log.current.action;
  assert.equal(undo.onClick(), true);
  assert.equal(unit.hidden('t1'), false);
  assert.equal(unit.hidden('t2'), false);
  assert.equal(toast.log.current.message, '已撤销', 'the undo is said');
  assert.equal(undo.onClick(), false, 'a second press does nothing');
  toast.timeout();
  await unit.flush();
  assert.deepEqual(calls, []);
});

test('flush (page hidden, closed, component gone) commits what waits, once, and takes the dead 撤销 away', async () => {
  const { toast, unit, calls, commit } = setup();
  unit.commitLater({ keys: ['a'], message: 'A', commit: commit('a') });
  const offer = toast.log.current;
  await unit.flush();
  assert.deepEqual(calls, ['a']);
  assert.equal(toast.log.current, null, 'the notice with 撤销 is gone');
  assert.equal(offer.action.onClick(), false, '撤销 after the commit does nothing');
  await unit.flush();
  offer.onLeave();
  await tick();
  assert.deepEqual(calls, ['a'], 'never twice: flush again, leave again');
});

test('a second delete of the same item while it waits is ignored', async () => {
  const { unit, calls, commit } = setup();
  assert.ok(unit.commitLater({ keys: ['x'], message: 'x', commit: commit('x1') }));
  assert.equal(unit.commitLater({ keys: ['x'], message: 'x', commit: commit('x2') }), null);
  await unit.flush();
  assert.deepEqual(calls, ['x1']);
  assert.equal(unit.commitLater({ keys: ['x'], message: 'x', commit: commit('x3') }), null, 'nor after it was deleted');
});

test('two overlapping deletes: the newer notice commits the older one at once, and keeps its own 撤销', async () => {
  const { toast, unit, calls, commit } = setup();
  unit.commitLater({ keys: ['first'], message: 'first', commit: commit('first') });
  unit.commitLater({ keys: ['second'], message: 'second', commit: commit('second') });
  await tick();
  assert.deepEqual(calls, ['first']);
  assert.equal(unit.hidden('first'), true);
  assert.equal(toast.log.current.message, 'second');
  toast.log.current.action.onClick();
  assert.equal(unit.hidden('second'), false);
  await unit.flush();
  assert.deepEqual(calls, ['first']);
});

test('a commit that fails (rejects, false or { ok: false }) puts the item back and says why', async () => {
  for (const result of [new Error('磁盘已满'), false, { ok: false, message: '磁盘已满' }]) {
    const { toast, unit, commit } = setup();
    unit.commitLater({ keys: ['k'], message: 'k', commit: commit('k', result), failed: (reason) => `没能删除「k」：${reason}` });
    const ok = await unit.flush();
    assert.deepEqual(ok, [false]);
    assert.equal(unit.hidden('k'), false, 'visible again');
    assert.equal(toast.log.errors.length, 1);
    if (result !== false) assert.match(toast.log.errors[0], /没能删除「k」：磁盘已满/);
  }
});

test('abandon (the library already changed) sends nothing and shows the items again', async () => {
  const { toast, unit, calls, commit } = setup();
  unit.commitLater({ keys: ['p'], message: 'p', commit: commit('p') });
  assert.equal(unit.abandon(), 1);
  assert.equal(unit.hidden('p'), false);
  toast.dismiss();
  await unit.flush();
  assert.deepEqual(calls, []);
});

test('the registry: flushUndoable before a move, abandonUndoable after a switch, for every mounted unit', async () => {
  const a = setup(), b = setup();
  const offA = m.registerUndoable(a.unit), offB = m.registerUndoable(b.unit);
  a.unit.commitLater({ keys: ['1'], message: '1', commit: a.commit('1') });
  b.unit.commitLater({ keys: ['2'], message: '2', commit: b.commit('2') });
  await m.flushUndoable();
  assert.deepEqual([...a.calls, ...b.calls], ['1', '2']);
  b.unit.commitLater({ keys: ['3'], message: '3', commit: b.commit('3') });
  assert.equal(m.abandonUndoable(), 1);
  offA(); offB();
  assert.equal(m.abandonUndoable(), 0);
});

test('restoreWith offers the inverse, says it worked, and runs it once; a failed inverse leaves the offer usable', async () => {
  const { toast, unit } = setup();
  let restored = 0;
  unit.restoreWith({ message: '已归档「期中」', restore: async () => { restored++; return { ok: true }; }, restored: '已恢复「期中」' });
  const offer = toast.log.current;
  assert.equal(offer.undo, true);
  assert.equal(offer.action.label, '撤销');
  assert.equal(await offer.action.onClick(), true);
  assert.equal(await offer.action.onClick(), false);
  assert.equal(restored, 1);
  assert.equal(toast.log.current.message, '已恢复「期中」');

  let tries = 0;
  unit.restoreWith({ message: 'm', restore: async () => (++tries === 1 ? undefined : true) });
  const second = toast.log.current;
  assert.equal(await second.action.onClick(), false, 'act() resolves undefined when it failed (it shows the error itself)');
  assert.equal(await second.action.onClick(), true);
});

test('restoreWith passes a second action (永久删除…) that closes the notice and opens what it names', () => {
  const { toast, unit } = setup();
  let opened = 0;
  unit.restoreWith({ message: 'm', restore: async () => true, secondary: { label: '永久删除…', onClick: () => { opened++; } } });
  assert.equal(toast.log.current.secondary.label, '永久删除…');
  toast.log.current.secondary.onClick();
  assert.equal(opened, 1);
  assert.equal(toast.log.current, null);
});

test('English: the undo action is "Undo"', () => {
  m.setUiLanguage('en');
  try {
    const { toast, unit } = setup();
    unit.commitLater({ keys: ['e'], message: 'Deleted', commit: async () => true });
    assert.equal(toast.log.current.action.label, 'Undo');
    toast.log.current.action.onClick();
    assert.equal(toast.log.current.message, 'Undone');
  } finally { m.setUiLanguage('zh'); }
});
