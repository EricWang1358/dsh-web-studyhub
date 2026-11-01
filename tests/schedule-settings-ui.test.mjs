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
const compiled = await build({ stdin: { contents: "export { ScheduleSection } from './ui/settings/ScheduleSection.jsx'; export { StudyServicesContext } from './ui/study-context.jsx';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
let active, studyContext;
const slot = initial => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
const hooks = { ...React,
  useState: initial => { const owner = active, [index, value] = slot(() => typeof initial === 'function' ? initial() : initial);
    return [value, next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
  useContext: context => (context === studyContext ? globalThis.__study ?? null : globalThis.__toast ?? null), useRef: initial => slot(() => ({ current: initial }))[1], useId: () => slot(() => `field-${active.cursor}`)[1],
  useInsertionEffect: () => {}, useEffect: (callback, dependencies) => { const [, effect] = slot(() => ({ dependencies: undefined, cleanup: null }));
    if (!effect.dependencies || dependencies.some((value, index) => value !== effect.dependencies[index])) {
      active.effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); }); effect.dependencies = dependencies;
    } },
};
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'react' ? hooks : require(name), module, module.exports);
const { ScheduleSection } = module.exports;
studyContext = module.exports.StudyServicesContext;
// The two FSRS-6 fields (lib/sm2.js): the target recall is shown as a percent (0.85 → 85), the maximum gap in days.
const keys = ['request_retention', 'maximum_interval'];
const findAll = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...React.Children.toArray(tree.props?.children).flatMap(child => findAll(child, predicate))];
};
function editor(overrides = {}) {
  let current = { root: '/temporary/library', saved: { ...defaults }, settings: { ...defaults }, busy: false, act() {}, ...overrides };
  const owner = { cursor: 0, slots: [], effects: [] };
  const setSettings = value => { current.settings = typeof value === 'function' ? value(current.settings) : value; };
  return {
    render(next = {}) { current = { ...current, ...next }; active = owner; owner.cursor = 0; globalThis.__study = current; // the services (act, busy) a page reads from useStudy()
      try { return ScheduleSection({ ...current, setSettings }); } finally { active = null; globalThis.__study = null; } },
    effects() { owner.effects.splice(0).forEach(effect => effect()); },
    unmount() { owner.slots.forEach(value => value?.cleanup?.()); },
    settings: () => current.settings,
  };
}
const input = (view, key) => findAll(view.render(), node => typeof node.props?.onChange === 'function' && node.props?.min !== undefined && node.props?.max !== undefined)[keys.indexOf(key)];
const edit = (view, key, value) => input(view, key).props.onChange({ target: { value } });
const submit = view => view.render().props.onSubmit({ preventDefault() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('snapshot scheduling synchronization works while the category is closed and preserves dirty fields and siblings', () => {
  const before = { ...defaults, generation: { concurrency: 3 } };
  const after = { ...defaults, maximum_interval: 500, request_retention: 0.89, generation: { concurrency: 6 } };
  const pristine = syncScheduleSettings(before, before, after);
  assert.equal(pristine.maximum_interval, 500);
  assert.equal(pristine.request_retention, 0.89);
  assert.equal(pristine.generation, before.generation);
  const dirty = syncScheduleSettings({ ...before, maximum_interval: 400 }, before, after);
  assert.equal(dirty.maximum_interval, 400);
  assert.equal(dirty.request_retention, 0.89);
  assert.equal(syncScheduleSettings(dirty, after, after), dirty, 'unchanged snapshots retain the editor object');
  assert.deepEqual(syncScheduleSettings({}, undefined, after), { ...defaults, maximum_interval: 500, request_retention: 0.89 });
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
  view.render(); view.effects(); edit(view, 'maximum_interval', '2'); await submit(view); await writing;
  const settings = (await service.call('snapshot')).settings;
  assert.deepEqual(settings.generation, saved.generation);
  assert.equal(settings.maximum_interval, 2);
  assert.deepEqual(sent, { maximum_interval: 2 }, 'the scheduling form only writes fields the user changed');

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
  assert.equal(review.interval_days, 2, 'the saved maximum reaches the real review scheduler (Good on a new question is 3 days uncapped)');
  assert.equal(result.feedback.nextDue, review.due_at);
});

test('new scheduling snapshots refresh pristine fields but preserve an edited interval', () => {
  const view = editor(); view.render(); view.effects();
  view.render({ saved: { ...defaults, maximum_interval: 300 } }); view.effects();
  assert.equal(input(view, 'maximum_interval').props.value, 300);
  edit(view, 'maximum_interval', '400');
  view.render({ saved: { ...defaults, maximum_interval: 500, request_retention: 0.89 } }); view.effects();
  assert.equal(input(view, 'maximum_interval').props.value, 400);
  assert.equal(input(view, 'request_retention').props.value, 89, 'the target recall shows as a percent');
});

test('a scheduling save applies the returned baseline without overwriting later edits', async () => {
  const response = deferred(); let writing;
  const view = editor({ act: (_action, args, after) => {
    writing = response.promise.then(() => after({ ...defaults, ...args, request_retention: 0.89 })); return writing;
  } });
  view.render(); view.effects(); edit(view, 'maximum_interval', '300'); const saving = submit(view);
  edit(view, 'maximum_interval', '400'); response.resolve(); await saving; await writing;
  assert.equal(input(view, 'maximum_interval').props.value, 400);
  assert.equal(input(view, 'request_retention').props.value, 89);
  const undo = findAll(view.render(), node => node.props?.children === '撤销未保存修改')[0];
  undo.props.onClick();
  assert.equal(input(view, 'maximum_interval').props.value, 300, 'undo uses the successful server response, even before a snapshot arrives');
});

test('departed scheduling saves and failures cannot change another library or show stale notices', async () => {
  for (const failure of [false, true]) {
    const response = deferred(), notices = []; let writing;
    globalThis.__toast = { success: text => notices.push(text) };
    const view = editor({ act: (_action, args, after) => {
      writing = response.promise.then(() => after({ ...defaults, ...args })); return writing;
    } });
    view.render(); view.effects(); edit(view, 'maximum_interval', '300'); const saving = submit(view);
    view.render({ root: '/another/library', settings: { ...defaults, maximum_interval: 700 }, saved: { ...defaults, maximum_interval: 700 } }); view.effects();
    if (failure) response.reject(new Error('old library save failed')); else response.resolve();
    await Promise.allSettled([saving, writing]);
    assert.equal(input(view, 'maximum_interval').props.value, 700);
    assert.deepEqual(notices, []);
    delete globalThis.__toast;
    assert.equal(findAll(view.render(), node => node.props?.role === 'alert').length, 0);
  }
});

test('a busy or repeated scheduling submission cannot issue another settings write', async () => {
  const response = deferred(); let writes = 0;
  const view = editor({ busy: true, act: async () => { writes++; await response.promise; } });
  view.render(); view.effects(); edit(view, 'maximum_interval', '300');
  const busy = submit(view); view.render({ busy: false });
  const first = submit(view), duplicate = submit(view);
  response.resolve(); await Promise.allSettled([busy, first, duplicate]);
  assert.equal(writes, 1);
});
