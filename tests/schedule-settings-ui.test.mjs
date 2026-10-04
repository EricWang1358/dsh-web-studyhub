import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { StudyService } from '../lib/service.js';
import { defaults } from '../lib/sm2.js';
import { syncScheduleSettings } from '../ui/schedule-settings.js';

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: "export { ScheduleSection } from './ui/settings/ScheduleSection.jsx';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
let active;
const slot = initial => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
const hooks = { ...React,
  useState: initial => { const owner = active, [index, value] = slot(() => typeof initial === 'function' ? initial() : initial);
    return [value, next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
  useContext: () => globalThis.__toast ?? null, useRef: initial => slot(() => ({ current: initial }))[1], useId: () => slot(() => `field-${active.cursor}`)[1],
  useEffect: (callback, dependencies) => { const [, effect] = slot(() => ({ dependencies: undefined, cleanup: null }));
    if (!effect.dependencies || dependencies.some((value, index) => value !== effect.dependencies[index])) {
      active.effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); }); effect.dependencies = dependencies;
    } },
};
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'react' ? hooks : require(name), module, module.exports);
const { ScheduleSection } = module.exports;
const keys = ['first_interval_days', 'second_interval_days', 'initial_ease_factor', 'minimum_ease_factor'];
const findAll = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props?.children).flatMap(child => findAll(child, predicate))];
};
function editor(overrides = {}) {
  let current = { root: '/temporary/library', saved: { ...defaults }, settings: { ...defaults }, busy: false, act() {}, ...overrides };
  const owner = { cursor: 0, slots: [], effects: [] };
  const setSettings = value => { current.settings = typeof value === 'function' ? value(current.settings) : value; };
  return {
    render(next = {}) { current = { ...current, ...next }; active = owner; owner.cursor = 0;
      try { return ScheduleSection({ ...current, setSettings }); } finally { active = null; } },
    effects() { owner.effects.splice(0).forEach(effect => effect()); },
    unmount() { owner.slots.forEach(value => value?.cleanup?.()); },
    settings: () => current.settings,
  };
}
const input = (view, key) => findAll(view.render(), node => node.props?.max === '365')[keys.indexOf(key)];
const edit = (view, key, value) => input(view, key).props.onChange({ target: { value } });
const submit = view => view.render().props.onSubmit({ preventDefault() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('snapshot scheduling synchronization works while the category is closed and preserves dirty fields and siblings', () => {
  const before = { ...defaults, generation: { concurrency: 3 } };
  const after = { ...defaults, first_interval_days: 5, second_interval_days: 9, generation: { concurrency: 6 } };
  const pristine = syncScheduleSettings(before, before, after);
  assert.equal(pristine.first_interval_days, 5);
  assert.equal(pristine.second_interval_days, 9);
  assert.equal(pristine.generation, before.generation);
  const dirty = syncScheduleSettings({ ...before, first_interval_days: 4 }, before, after);
  assert.equal(dirty.first_interval_days, 4);
  assert.equal(dirty.second_interval_days, 9);
  assert.equal(syncScheduleSettings(dirty, after, after), dirty, 'unchanged snapshots retain the editor object');
  assert.deepEqual(syncScheduleSettings({}, undefined, after), { ...defaults, first_interval_days: 5, second_interval_days: 9 });
});

test('saving review intervals preserves preferences already saved in another settings category', async t => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-settings-ui-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const opening = (await service.call('snapshot')).settings;
  const saved = await service.call('settings', { generation: { concurrency: 6, language: 'English', focus: 'Keep current preference' } });
  let writing, sent;
  const view = editor({ root, settings: opening, saved, act: (action, args, after) => {
    sent = args; writing = service.call(action, args).then(result => after(result)); return writing;
  } });
  view.render(); view.effects(); edit(view, 'first_interval_days', '3'); await submit(view); await writing;
  const settings = (await service.call('snapshot')).settings;
  assert.deepEqual(settings.generation, saved.generation);
  assert.equal(settings.first_interval_days, 3);
  assert.deepEqual(sent, { first_interval_days: 3 }, 'the interval form only writes fields the user changed');

  const quote = 'Active recall strengthens memory by retrieving a fact before seeing its explanation.';
  await service.call('source.add', { id: 's1', title: 'Synthetic memory fixture', text: quote });
  const draft = await service.call('draft.save', { deck: { id: 'd1', title: 'Synthetic review', cards: [{ id: 'c1', kind: 'flashcard', topic: 'Recall',
    objective: 'Explain why retrieving a fact helps memory', prompt: 'How does trying to retrieve a fact before checking it help memory?',
    answer: 'Retrieving the fact strengthens memory.', hint: 'Consider the act of retrieval.', explanation: 'Active recall strengthens memory through retrieval.',
    misconception: 'Rereading and retrieving have the same learning effect.', citations: [{ sourceId: 's1', quote }] }] } });
  await service.call('draft.publish', { id: draft.id });
  const run = await service.call('review.start', { deckId: 'd1', mode: 'flashcard' });
  await service.call('review.reveal', { runId: run.id, cardId: 'c1' });
  const result = await service.call('review.answer', { runId: run.id, cardId: 'c1', grade: 4 });
  const review = (await service.call('export')).decks.find(deck => deck.id === 'd1').cards[0].review;
  assert.equal(review.interval_days, 3, 'the saved interval reaches the real review scheduler');
  assert.equal(result.feedback.nextDue, review.due_at);
});

test('new scheduling snapshots refresh pristine fields but preserve an edited interval', () => {
  const view = editor(); view.render(); view.effects();
  view.render({ saved: { ...defaults, first_interval_days: 3 } }); view.effects();
  assert.equal(input(view, 'first_interval_days').props.value, 3);
  edit(view, 'first_interval_days', '4');
  view.render({ saved: { ...defaults, first_interval_days: 5, second_interval_days: 9 } }); view.effects();
  assert.equal(input(view, 'first_interval_days').props.value, 4);
  assert.equal(input(view, 'second_interval_days').props.value, 9);
});

test('a scheduling save applies the returned baseline without overwriting later edits', async () => {
  const response = deferred(); let writing;
  const view = editor({ act: (_action, args, after) => {
    writing = response.promise.then(() => after({ ...defaults, ...args, second_interval_days: 9 })); return writing;
  } });
  view.render(); view.effects(); edit(view, 'first_interval_days', '3'); const saving = submit(view);
  edit(view, 'first_interval_days', '4'); response.resolve(); await saving; await writing;
  assert.equal(input(view, 'first_interval_days').props.value, 4);
  assert.equal(input(view, 'second_interval_days').props.value, 9);
  const undo = findAll(view.render(), node => node.props?.children === '撤销未保存修改')[0];
  undo.props.onClick();
  assert.equal(input(view, 'first_interval_days').props.value, 3, 'undo uses the successful server response, even before a snapshot arrives');
});

test('departed scheduling saves and failures cannot change another library or show stale notices', async () => {
  for (const failure of [false, true]) {
    const response = deferred(), notices = []; let writing;
    globalThis.__toast = { success: text => notices.push(text) };
    const view = editor({ act: (_action, args, after) => {
      writing = response.promise.then(() => after({ ...defaults, ...args })); return writing;
    } });
    view.render(); view.effects(); edit(view, 'first_interval_days', '3'); const saving = submit(view);
    view.render({ root: '/another/library', settings: { ...defaults, first_interval_days: 7 }, saved: { ...defaults, first_interval_days: 7 } }); view.effects();
    if (failure) response.reject(new Error('old library save failed')); else response.resolve();
    await Promise.allSettled([saving, writing]);
    assert.equal(input(view, 'first_interval_days').props.value, 7);
    assert.deepEqual(notices, []);
    delete globalThis.__toast;
    assert.equal(findAll(view.render(), node => node.props?.role === 'alert').length, 0);
  }
});

test('a busy or repeated scheduling submission cannot issue another settings write', async () => {
  const response = deferred(); let writes = 0;
  const view = editor({ busy: true, act: async () => { writes++; await response.promise; } });
  view.render(); view.effects(); edit(view, 'first_interval_days', '3');
  const busy = submit(view); view.render({ busy: false });
  const first = submit(view), duplicate = submit(view);
  response.resolve(); await Promise.allSettled([busy, first, duplicate]);
  assert.equal(writes, 1);
});
