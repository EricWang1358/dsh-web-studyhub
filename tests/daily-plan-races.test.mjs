import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { useDailyPlan, useStudyReferenceHandoff } from './ui/daily-plan.js';
  export { default as Workflows } from './ui/Workflows.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const plan = (tag, tasks = []) => ({ tag, tasks, budgetMinutes: 40, profile: { weekdayMinutes: 40, weekendMinutes: 60 }, proposal: null });

// Run real hook lifetimes with controlled transport responses and a local clock.
function harness() {
  let active, clock = new Date(2026, 9, 4, 12).getTime();
  const timers = new Set(), listeners = new Set();
  const slot = initial => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
  const memo = (create, deps) => {
    const [, value] = slot(() => ({ deps: undefined }));
    if (!value.deps || deps.some((item, index) => item !== value.deps[index])) { value.current = create(); value.deps = deps; }
    return value.current;
  };
  const hooks = { ...React,
    useState: initial => { const owner = active, [index, value] = slot(() => typeof initial === 'function' ? initial() : initial);
      return [value, next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
    useRef: value => slot(() => ({ current: value }))[1],
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps),
    useSyncExternalStore: (subscribe, get) => get(), useContext: () => null,
    useInsertionEffect: () => {}, useEffect: (callback, deps) => {
      const [, value] = slot(() => ({ deps: undefined, cleanup: null }));
      if (!value.deps || deps.some((item, index) => item !== value.deps[index])) {
        active.effects.push(() => { value.cleanup?.(); value.cleanup = callback(); }); value.deps = deps;
      }
    },
  };
  const document = { compatMode: 'CSS1Compat', hidden: false, addEventListener: (type, listener) => listeners.add(listener), removeEventListener: (type, listener) => listeners.delete(listener) };
  const module = { exports: {} };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } }
  // The 15 s poll (usePolling) is a chain of timeouts it takes from globalThis: a fake one that advanceDay fires.
  const fakeSetTimeout = callback => { timers.add(callback); return callback; }, fakeClearTimeout = callback => timers.delete(callback);
  const fakeGlobal = Object.assign(Object.create(globalThis), { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout });
  new Function('require', 'module', 'exports', 'document', 'setTimeout', 'clearTimeout', 'globalThis', 'Date', compiled.outputFiles[0].text)(
    name => name === 'react' ? hooks : require(name), module, module.exports, document, fakeSetTimeout, fakeClearTimeout, fakeGlobal, Clock);
  return { ...module.exports,
    advanceDay: () => { clock += 86400000; for (const timer of timers) timer(); },
    render(component, props) {
      const owner = { cursor: 0, slots: [], effects: [] };
      return {
        render(next = {}) { props = { ...props, ...next }; active = owner; owner.cursor = 0;
          try { return component(props); } finally { active = null; } },
        effects() { owner.effects.splice(0).forEach(callback => callback()); },
        unmount() { owner.slots.forEach(value => value?.cleanup?.()); },
      };
    },
  };
}
const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const value = find(child, predicate); if (value) return value; }
  return null;
};

test('a source handoff waits for library bootstrap and uses the current opener', () => {
  const api = harness(), opened = [];
  const reference = { root: 'library', kind: 'source', id: 'source' };
  let subscribed = 0, cleaned = 0;
  const take = listener => { subscribed++; listener(reference); return () => cleaned++; };
  const useHandoff = props => api.useStudyReferenceHandoff(props.take, props.root, props.onOpen);
  const view = api.render(useHandoff, { take, root: undefined, onOpen: () => opened.push('before bootstrap') });
  view.render(); view.effects();
  assert.equal(subscribed, 0, 'a queued reference must not be consumed before the library loads');
  view.render({ root: 'library', onOpen: ref => opened.push(ref) }); view.effects();
  assert.equal(subscribed, 1);
  assert.deepEqual(opened, [reference]);
  view.unmount();
  assert.equal(cleaned, 1);
});

test('switching libraries reads immediately and an old mutation cannot unlock a new mutation', async () => {
  const api = harness(), oldResponse = deferred(), newResponse = deferred(), calls = [];
  const call = root => async action => { calls.push([root, action]); return action === 'daily.plan.get' ? plan(root) : (root === 'old' ? oldResponse.promise : newResponse.promise); };
  const view = api.render(api.useDailyPlan, { root: 'old', visible: false, call: call('old') });
  await view.render().refresh();
  const oldMutation = view.render().suggest();
  await view.render({ root: 'new', call: call('new') }).refresh();
  assert.equal(view.render().state.tag, 'new');
  assert.equal(view.render().busy, '');
  const newMutation = view.render().suggest();
  oldResponse.resolve(plan('old proposal'));
  assert.equal(await oldMutation, false);
  assert.equal(view.render().busy, 'suggest');
  assert.equal(await view.render().accept('another'), false);
  assert.equal(calls.filter(([, action]) => action === 'daily.plan.accept').length, 0);
  newResponse.resolve(plan('new proposal'));
  assert.equal(await newMutation, true);
  assert.equal(view.render().state.tag, 'new proposal');
  assert.equal(view.render().busy, '');
});

test('midnight loads the new day while yesterday\'s start is still pending', async () => {
  const api = harness(), response = deferred(), calls = [], launched = [];
  const view = api.render(api.useDailyPlan, { root: 'library', visible: true, onLaunch: value => launched.push(value),
    call: async (action, args) => { calls.push([action, args.date]); return action === 'daily.plan.get' ? plan(args.date) : response.promise; } });
  view.render(); view.effects(); await settle();
  const before = view.render().date, pending = view.render().start('task');
  api.advanceDay(); view.render(); view.effects(); await settle();
  const after = view.render().date;
  assert.notEqual(after, before);
  assert.equal(view.render().state.tag, after);
  assert.equal(view.render().busy, '');
  assert.ok(calls.some(([action, date]) => action === 'daily.plan.get' && date === after));
  response.resolve({ run: { id: 'yesterday' } });
  assert.equal(await pending, false);
  assert.deepEqual(launched, []);
  view.unmount();
});

test('progress invalidates an older coalesced read and queues one fresh read', async () => {
  const api = harness(), oldRead = deferred(), freshRead = deferred();
  let calls = 0;
  const view = api.render(api.useDailyPlan, { root: 'library', visible: true, progressKey: '',
    call: () => (++calls === 1 ? oldRead.promise : freshRead.promise) });
  view.render(); view.effects();
  const shared = view.render().refresh();
  void view.render().refresh();
  assert.equal(calls, 1);
  view.render({ progressKey: 'run:1:false' }); view.effects();
  view.render({ progressKey: 'run:2:false' }); view.effects();
  assert.equal(calls, 1, 'invalidations wait for the existing read');
  oldRead.resolve(plan('before answers'));
  await settle();
  assert.equal(view.render().state, null, 'pre-answer snapshot must never be displayed');
  assert.equal(calls, 2);
  freshRead.resolve(plan('after answers'));
  await shared;
  assert.equal(view.render().state.tag, 'after answers');
  view.unmount();
});

test('progress arriving during a mutation refreshes after it completes', async () => {
  const api = harness(), response = deferred();
  let reads = 0;
  const view = api.render(api.useDailyPlan, { root: 'library', visible: true, progressKey: '',
    call: action => action === 'daily.plan.get' ? Promise.resolve(plan(`read ${++reads}`)) : response.promise });
  view.render(); view.effects(); await settle();
  const mutation = view.render().complete('task');
  view.render({ progressKey: 'run:5:true' }); view.effects();
  assert.equal(reads, 1);
  response.resolve(plan('mutation'));
  await mutation; await settle();
  assert.equal(reads, 2);
  assert.equal(view.render().state.tag, 'read 2');
  view.unmount();
});

test('a newer navigation suppresses late launch while retaining the completed start', async () => {
  const api = harness(), response = deferred(), launches = [], changes = [];
  let navigation = 0;
  const task = { id: 'task', status: 'todo' };
  const view = api.render(api.useDailyPlan, { root: 'library', visible: false, navigation: () => navigation,
    onLaunch: value => launches.push(value), onChanged: () => changes.push('changed'),
    call: action => action === 'daily.plan.get' ? Promise.resolve(plan('accepted', [task])) : response.promise });
  await view.render().refresh();
  const start = view.render().start('task');
  navigation++;
  response.resolve({ task: { ...task, status: 'doing' }, run: { id: 'run' } });
  assert.equal(await start, true);
  assert.deepEqual(launches, []);
  assert.equal(view.render().state.tasks[0].status, 'doing');
  assert.deepEqual(changes, ['changed']);
});

test('related workflow tasks follow the actual portal, disappear on back, and follow another session', () => {
  const api = harness(), related = [];
  const listing = { sessions: [{ id: 'first', topic: 'First', status: 'active', updatedAt: '2026-10-04' },
    { id: 'second', topic: 'Second', status: 'completed', updatedAt: '2026-10-03' }], templates: [], components: [],
    limit: 5, suggested: { title: 'Default', description: '', steps: [] } };
  const view = api.render(api.Workflows, { data: { root: 'library' }, openSession: 'first', initialListing: listing,
    call: async () => listing, renderRelated: sessionId => { related.push(sessionId); return React.createElement('aside', { 'data-session': sessionId }); } });
  let tree = view.render();
  assert.equal(find(tree, node => node.type === 'aside').props['data-session'], 'first');
  find(tree, node => node.props?.id === 'first' && node.props.onBack).props.onBack();
  tree = view.render();
  assert.equal(find(tree, node => node.type === 'aside'), null);
  assert.deepEqual(related, ['first']);
  const second = find(tree, node => node.type === 'li' && find(node, child => child.type === 'strong' && child.props.children === 'Second'));
  find(second, node => node.props?.children === '查看记录' && node.props.onClick).props.onClick();
  tree = view.render();
  assert.equal(find(tree, node => node.type === 'aside').props['data-session'], 'second');
});
