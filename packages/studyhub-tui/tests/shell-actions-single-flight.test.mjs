// #1747 / PR #1762: `createDefaultShellActions` used to close over its own private `snapshot` refresh and had no
// re-entrancy guard on `loadSample`, so one sample load ran two `snapshot` RPCs (its own plus the host-sync one
// `App.tsx` already coalesces) and a double press sent two `sample.load` RPCs. The fix wires `refreshOverride`
// through `App.tsx` / `AppShell.tsx` and adds the `sampleLoadInFlight` single-flight guard. Every case drives the
// real actions factory with a fake host that records each RPC; nothing here is timing based.
// Run: node --test tests/shell-actions-single-flight.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => unregisterTsx?.());

const [{ createDefaultShellActions }, { useTuiStore }] = await Promise.all([
  import('../src/shell/actions.ts'),
  import('../src/state/store.ts'),
]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Fake host: records every RPC name. `handlers[action]` may return a result, a promise, or throw;
 * unhandled actions answer `{ ok: true, value: {} }`.
 */
function makeHost(handlers = {}) {
  const calls = [];
  return {
    calls,
    count: (action) => calls.filter((c) => c.action === action).length,
    call: async (action, args = {}) => {
      calls.push({ action, args });
      const handler = handlers[action];
      if (handler) return handler(args, calls.filter((c) => c.action === action).length);
      return { ok: true, value: {} };
    },
    subscribeEvents: () => () => {},
    getLibraryRoot: () => 'fake-root',
    getConfig: () => null,
  };
}

function makeOverride() {
  const state = { calls: 0 };
  const refresh = async () => {
    state.calls += 1;
  };
  return { state, refresh };
}

describe('createDefaultShellActions refresh override', () => {
  test('with refreshOverride, loadSample / setCourse / createCourse send 0 snapshot RPCs and call the override', async () => {
    const host = makeHost({ 'course.save': async (args) => ({ ok: true, value: { name: args.name } }) });
    const { state, refresh } = makeOverride();
    const actions = createDefaultShellActions(host, () => {}, refresh);

    assert.equal(actions.refresh, refresh, 'the exposed refresh is the override itself');

    await actions.loadSample();
    assert.equal(host.count('sample.load'), 1);
    assert.equal(state.calls, 1, 'loadSample refreshes through the override once');

    await actions.setCourse('Algorithms');
    assert.equal(host.count('focus.set'), 1);
    assert.equal(state.calls, 2, 'setCourse refreshes through the override once');

    await actions.createCourse('Networks');
    assert.equal(host.count('course.save'), 1);
    assert.equal(host.count('focus.set'), 2);
    assert.equal(state.calls, 3, 'createCourse refreshes through the override once');

    assert.equal(host.count('snapshot'), 0, 'no private duplicate snapshot RPC while an override is wired');
  });

  test('without an override the default refresh still sends one snapshot RPC per action (control)', async () => {
    const host = makeHost({ 'course.save': async (args) => ({ ok: true, value: { name: args.name } }) });
    const actions = createDefaultShellActions(host, () => {});

    await actions.loadSample();
    await actions.setCourse('Algorithms');
    await actions.createCourse('Networks');

    assert.equal(host.count('snapshot'), 3);
  });
});

describe('createDefaultShellActions loadSample single-flight guard', () => {
  test('two concurrent loadSample() calls send exactly one sample.load; a later call sends a new one', async () => {
    const gate = deferred();
    const host = makeHost({ 'sample.load': () => gate.promise });
    const { state, refresh } = makeOverride();
    const actions = createDefaultShellActions(host, () => {}, refresh);

    const first = actions.loadSample();
    const second = actions.loadSample();
    assert.equal(host.count('sample.load'), 1, 'the second concurrent call joins the in-flight load');

    gate.resolve({ ok: true, value: {} });
    await Promise.all([first, second]);
    assert.equal(host.count('sample.load'), 1);
    assert.equal(state.calls, 1, 'the shared load refreshes once, not once per caller');

    await actions.loadSample();
    assert.equal(host.count('sample.load'), 2, 'a call after completion starts a fresh load');
    assert.equal(state.calls, 2);
  });

  test('the guard clears after host.call throws: both callers reject and the next call goes through', async () => {
    const gate = deferred();
    const host = makeHost({
      'sample.load': (_args, n) => (n === 1 ? gate.promise : { ok: true, value: {} }),
    });
    const { refresh } = makeOverride();
    const actions = createDefaultShellActions(host, () => {}, refresh);

    const first = actions.loadSample();
    const second = actions.loadSample();
    const firstOutcome = assert.rejects(first, /host exploded/);
    const secondOutcome = assert.rejects(second, /host exploded/);
    assert.equal(host.count('sample.load'), 1);

    gate.reject(new Error('host exploded'));
    await Promise.all([firstOutcome, secondOutcome]);

    await actions.loadSample();
    assert.equal(host.count('sample.load'), 2, 'the next call is not stuck behind the failed run');
  });

  test('the guard clears after an ok:false answer: both callers resolve and the next call goes through', async () => {
    const gate = deferred();
    const host = makeHost({
      'sample.load': (_args, n) => (n === 1 ? gate.promise : { ok: true, value: {} }),
    });
    const { state, refresh } = makeOverride();
    const actions = createDefaultShellActions(host, () => {}, refresh);

    const first = actions.loadSample();
    const second = actions.loadSample();
    assert.equal(host.count('sample.load'), 1);

    gate.resolve({ ok: false, error: { message: 'no sample available' } });
    await Promise.all([first, second]);
    assert.equal(state.calls, 0, 'a failed load never refreshes');
    const toasts = useTuiStore.getState().toasts ?? [];
    assert.ok(
      JSON.stringify(toasts).includes('no sample available'),
      'the failure is surfaced as an error toast',
    );

    await actions.loadSample();
    assert.equal(host.count('sample.load'), 2, 'the next call is not stuck behind the failed run');
    assert.equal(state.calls, 1);
  });
});

/**
 * Text of the argument list of the first `createDefaultShellActions(` call in `source`
 * (balanced parentheses, so nested `() => rawQuitRef.current()` does not end it early).
 */
function firstCallArgs(source) {
  const start = source.indexOf('createDefaultShellActions(');
  assert.ok(start >= 0, 'createDefaultShellActions( call not found');
  const open = start + 'createDefaultShellActions'.length;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail('unbalanced createDefaultShellActions( call');
}

// The factory test above proves the behavior; these two shapes prove the two call sites still feed it the
// refresh that coalesces with the host sync. Source-shape checks, because rendering the whole shell needs a PTY.
describe('shell call sites wire the refresh override into createDefaultShellActions', () => {
  const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  test('App.tsx passes its single-flight syncFromHost refresh as the third argument and exposes the same function', async () => {
    const source = await read('../src/App.tsx');
    const args = firstCallArgs(source);
    assert.match(args, /,\s*syncRefresh\s*$/, 'third argument must be the syncFromHost-backed refresh');
    assert.match(source, /const syncRefresh = async \(\) => \{\s*await syncFromHost\(false\);\s*\};/);
    assert.match(source, /refresh:\s*syncRefresh\s*,/, 'the exposed refresh is the same function the factory received');
  });

  test('AppShell.tsx forwards actionOverrides.refresh to the factory so overrides and the factory share one refresh', async () => {
    const source = await read('../src/shell/AppShell.tsx');
    const args = firstCallArgs(source);
    assert.match(args, /,\s*actionOverrides\?\.refresh\s*$/);
  });
});
