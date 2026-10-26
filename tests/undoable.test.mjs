import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// ui/undoable.js: 删除 with 撤销 (commitLater) and 撤销 of an operation that has an inverse (restoreWith). The fake toast below is the app's one notice slot:
// a newer notice, a close or a timeout makes the one that was up leave, and leaving calls its onLeave (ui/ActionFeedback.jsx useNotice).
const m = await loadUi(`export { createUndoable, registerUndoable, flushUndoable, abandonUndoable, UNDO_TIMEOUT, COMMITTED_HOLD } from './ui/undoable.js'; export { setUiLanguage } from './ui/i18n.js';`);

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
/** A scheduler the test runs by hand: `run()` fires what is due (the hold of a committed item, a refocus try). */
function manualLater() {
  const queue = [];
  const later = (work) => { queue.push(work); };
  return { later, run: () => { for (const work of queue.splice(0)) work(); } };
}

function setup(options = {}) {
  const toast = fakeToast(), calls = [], clock = manualLater();
  let changes = 0;
  const unit = m.createUndoable({ toast, onChange: () => { changes++; }, later: clock.later, ...options });
  const commit = (name, result = { ok: true }) => async () => { calls.push(name); if (result instanceof Error) throw result; return result; };
  return { toast, unit, calls, commit, clock, changes: () => changes };
}

test('commitLater hides at once, shows 撤销 with the time it lasts, and sends nothing until the notice leaves', async () => {
  const { toast, unit, calls, commit } = setup();
  const entry = unit.commitLater({ keys: ['n1'], message: '已删除「笔记」', commit: commit('n1') });
  assert.ok(entry);
  assert.equal(unit.hidden('n1'), true);
  assert.equal(unit.hidden('n2'), false);
  assert.equal(toast.log.current.message, '已删除「笔记」（8 秒内可撤销）', 'a mouse-started notice names its window');
  assert.equal(toast.log.current.undo, true);
  assert.equal(toast.log.current.timeout, m.UNDO_TIMEOUT);
  assert.notEqual(toast.log.current.persistent, true);
  assert.equal(toast.log.current.action.label, '撤销');
  await tick();
  assert.deepEqual(calls, [], 'nothing is sent while 撤销 is still possible');
  toast.timeout();
  await tick();
  assert.deepEqual(calls, ['n1'], 'the time ran out: the host is asked once');
  assert.equal(unit.hidden('n1'), true, 'a committed item stays hidden until the next snapshot drops it');
});

test('a deletion started from the keyboard waits for the learner: no timeout, no time in its words', () => {
  const { toast, unit, commit } = setup({ keyboard: () => true });
  unit.commitLater({ keys: ['k'], message: '已删除「k」', commit: commit('k') });
  assert.equal(toast.log.current.message, '已删除「k」');
  assert.equal(toast.log.current.persistent, true);
  assert.equal(toast.log.current.timeout, undefined);
  unit.restoreWith({ message: '已归档「k」', restore: async () => true });
  assert.equal(toast.log.current.persistent, true);
});

test('撤销 shows the item again, sends nothing even when the notice leaves afterwards, and puts the focus back', async () => {
  const { toast, unit, calls, commit, clock } = setup();
  const target = { focused: 0, focus() { this.focused++; } };
  unit.commitLater({ keys: ['t1', 't2'], message: '已删除 2 个任务', commit: commit('t'), focus: () => target });
  const undo = toast.log.current.action;
  assert.equal(undo.onClick(), true);
  assert.equal(unit.hidden('t1'), false);
  assert.equal(unit.hidden('t2'), false);
  assert.equal(toast.log.current.message, '已撤销', 'the undo is said');
  clock.run();
  assert.equal(target.focused, 1, 'the keyboard focus goes back to the item');
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

test('flush waits for a commit already on its way (a library move must not overtake it)', async () => {
  const { toast, unit } = setup();
  let release, answered = false;
  unit.commitLater({ keys: ['note-1'], message: 'x', commit: () => new Promise((done) => { release = () => { answered = true; done(true); }; }) });
  toast.timeout();
  await tick();
  let flushed = false;
  const waiting = unit.flush().then(() => { flushed = true; });
  await tick(); await tick();
  assert.equal(flushed, false, 'flush is still waiting for the host');
  release();
  await waiting;
  assert.equal(answered, true);
  assert.equal(flushed, true);
  assert.equal(unit.hidden('note-1'), true, 'deleted, not put back');
  assert.deepEqual(toast.log.errors, []);
});

test('a delete is fenced to its library: a commit after the library changed is not sent and the item shows again', async () => {
  let root = 'A';
  const { toast, unit, calls, commit } = setup({ scope: () => root });
  unit.commitLater({ keys: ['coach:2026-10-01'], message: 'x', commit: commit('day') });
  root = 'B';
  toast.timeout();
  await tick(); await tick();
  assert.deepEqual(calls, []);
  assert.equal(unit.hidden('coach:2026-10-01'), false);
  assert.match(toast.log.errors[0], /学习库已更换/);
});

test('a committed item is forgotten after the hold: one that comes back under the same key shows and can be deleted again', async () => {
  const { toast, unit, calls, commit, clock } = setup();
  unit.commitLater({ keys: ['annotation:P'], message: 'x', commit: commit('first') });
  toast.timeout(); await tick(); await tick();
  assert.equal(unit.hidden('annotation:P'), true);
  assert.equal(unit.commitLater({ keys: ['annotation:P'], message: 'y', commit: commit('again') }), null, 'not while the first is still held');
  clock.run();
  assert.equal(unit.hidden('annotation:P'), false, 'released');
  assert.ok(unit.commitLater({ keys: ['annotation:P'], message: 'y', commit: commit('second') }));
  await unit.flush();
  assert.deepEqual(calls, ['first', 'second']);
});

test('what the host kept (a task that started running) shows again at once, and the notice says how many', async () => {
  const { toast, unit, commit } = setup();
  unit.commitLater({ keys: ['job-7', 'job-8'], message: 'x', commit: commit('jobs', { ok: true, kept: ['job-7'] }), kept: (count) => `${count} 个任务正在运行，没有删除` });
  await unit.flush();
  assert.equal(unit.hidden('job-7'), false, 'the running one is back');
  assert.equal(unit.hidden('job-8'), true);
  assert.equal(toast.log.current.message, '1 个任务正在运行，没有删除');
});

test('a second delete of the same item while it waits is ignored', async () => {
  const { unit, calls, commit } = setup();
  assert.ok(unit.commitLater({ keys: ['x'], message: 'x', commit: commit('x1') }));
  assert.equal(unit.commitLater({ keys: ['x'], message: 'x', commit: commit('x2') }), null);
  await unit.flush();
  assert.deepEqual(calls, ['x1']);
  assert.equal(unit.commitLater({ keys: ['x'], message: 'x', commit: commit('x3') }), null, 'nor right after it was deleted');
});

test('two overlapping deletes: the newer notice commits the older one at once, and keeps its own 撤销', async () => {
  const { toast, unit, calls, commit } = setup();
  unit.commitLater({ keys: ['first'], message: 'first', commit: commit('first') });
  unit.commitLater({ keys: ['second'], message: 'second', commit: commit('second') });
  await tick();
  assert.deepEqual(calls, ['first']);
  assert.equal(unit.hidden('first'), true);
  assert.match(toast.log.current.message, /^second/);
  toast.log.current.action.onClick();
  assert.equal(unit.hidden('second'), false);
  await unit.flush();
  assert.deepEqual(calls, ['first']);
});

test('a commit that fails (rejects, false or { ok: false }) puts the item back and says why', async () => {
  for (const result of [new Error('磁盘已满'), false, { ok: false, message: '磁盘已满' }]) {
    const { toast, unit, commit } = setup();
    let restored = 0;
    unit.commitLater({ keys: ['k'], message: 'k', commit: commit('k', result), failed: (reason) => `没能删除「k」：${reason}`, onRestore: () => { restored++; } });
    const ok = await unit.flush();
    assert.deepEqual(ok, [false]);
    assert.equal(unit.hidden('k'), false, 'visible again');
    assert.equal(restored, 1);
    assert.equal(toast.log.errors.length, 1);
    if (result !== false) assert.match(toast.log.errors[0], /没能删除「k」：磁盘已满/);
  }
});

test('abandon (the library already changed) sends nothing, shows the items again and counts items, not entries', async () => {
  const { toast, unit, calls, commit } = setup();
  unit.commitLater({ keys: ['p', 'q', 'r'], message: 'p', commit: commit('p') });
  assert.equal(unit.abandon(), 3);
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

test('restoreWith offers the inverse, keeps the notice up while it runs, says it worked, and runs it once; a failed inverse leaves the offer usable', async () => {
  const { toast, unit } = setup();
  let restored = 0, release;
  unit.restoreWith({ message: '已归档「期中」', restore: () => new Promise((done) => { restored++; release = () => done({ ok: true }); }), restored: '已恢复「期中」' });
  const offer = toast.log.current;
  assert.equal(offer.undo, true);
  assert.equal(offer.action.label, '撤销');
  const running = offer.action.onClick();
  assert.equal(toast.log.current, offer, 'the notice stays while the inverse runs');
  assert.equal(await offer.action.onClick(), false, 'a second press while it runs does nothing');
  release();
  assert.equal(await running, true);
  assert.equal(restored, 1);
  assert.equal(toast.log.current.message, '已恢复「期中」');

  let tries = 0;
  unit.restoreWith({ message: 'm', restore: async () => (++tries === 1 ? undefined : true) });
  const second = toast.log.current;
  assert.equal(await second.action.onClick(), false, 'act() resolves undefined when it failed (it shows the error itself)');
  assert.equal(toast.log.current, second, 'the offer is still on screen');
  assert.equal(await second.action.onClick(), true, 'and a second try works');
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

test('English: the undo action is "Undo" and the window is said', () => {
  m.setUiLanguage('en');
  try {
    const { toast, unit } = setup();
    unit.commitLater({ keys: ['e'], message: 'Deleted', commit: async () => true });
    assert.equal(toast.log.current.message, 'Deleted (undo within 8 s)');
    assert.equal(toast.log.current.action.label, 'Undo');
    toast.log.current.action.onClick();
    assert.equal(toast.log.current.message, 'Undone');
  } finally { m.setUiLanguage('zh'); }
});
