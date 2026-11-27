import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { Store } from '../lib/store.js';
import { collectCommits } from '../lib/runtime/commit-log.js';
import { createTaskService } from '../lib/runtime/tasks.js';
import { hostJobExecutor } from '../lib/jobs/executor.js';
import { MANIFEST_FILENAME, createLibraryWatcher, readLibraryMeta } from '../lib/runtime/library-watch.js';
import { DEBOUNCE_MS, eventArrives, hostFor, pause, seedDocument, watchedBus, withRoot } from './helpers/quiet-write.mjs';
import { until } from './helpers/wait.mjs';

/* The races around a quiet write (tests/library-quiet-write.test.mjs has the window itself): a watcher whose first stamp read is still out when the
   acknowledgement comes, acknowledgements outside any window (the desktop host and the TUI open none), another writer right after the action's own
   commit, a finished round, and background work started from inside the action, whose commits are not the action's. */

test('a fresh watcher whose first stamp read is still out when the own commit is acknowledged stays quiet', async (t) => {
  const root = await withRoot(t, 'quiet-fresh-');
  await writeFile(join(root, MANIFEST_FILENAME), JSON.stringify({ revision: 1 }));
  // A long-poll (library.events.wait) creates the watcher right before the action: its first stat of the manifest is slow and lands after the commit.
  let first = true;
  const statImpl = async (path, options) => {
    const info = await stat(path, options);
    if (first && path.endsWith(MANIFEST_FILENAME)) { first = false; await pause(300); }
    return info;
  };
  const { bus, events } = await watchedBus(t, root, { settle: false, statImpl });
  const release = bus.beginQuietWrite(root);
  const from = (await readLibraryMeta(root)).stamp;
  await writeFile(join(root, MANIFEST_FILENAME), JSON.stringify({ revision: 2 }));
  const to = (await readLibraryMeta(root)).stamp;
  bus.acknowledgeWrite(root, [{ from, to, revision: 2 }]);
  release();
  await pause(800);
  assert.deepEqual(events.map((event) => event.reason), [], 'the own commit must not come back once the first stamp is known');
});

test('outside a quiet window an acknowledgement that matches nothing is dropped, not kept for a later stamp', () => {
  const watcher = createLibraryWatcher({ root: process.cwd(), watchImpl: () => null });
  try {
    watcher.recordBroadcast('S0', 0);
    watcher.absorbCommits([{ from: 'S1', to: 'S2', revision: 2 }]); // built on a stamp the watcher never reported: someone else wrote first
    assert.equal(watcher.getMeta().stamp, 'S0');
    watcher.recordBroadcast('S1', 1); // that write is reported later
    watcher.absorbCommits([{ from: 'X', to: 'Y', revision: 9 }]); // any later acknowledgement
    assert.equal(watcher.getMeta().stamp, 'S1', 'a kept S1 -> S2 would now take S2 for told, and the next real change to it would be swallowed');
  } finally {
    watcher.dispose();
  }
});

test('a quiet host action during which another writer commits right after the action\'s own commit still wakes subscribers', async (t) => {
  const root = await withRoot(t, 'quiet-after-own-');
  await seedDocument(root);
  const { bus, events } = await watchedBus(t, root);
  let after = null;
  const commit = Store.prototype.commit;
  Store.prototype.commit = async function (...args) {
    const result = await commit.apply(this, args);
    if (after) { const write = after; after = null; write(); }
    return result;
  };
  t.after(() => { Store.prototype.commit = commit; });
  const call = hostFor(t, root, bus);
  const save = (read) => call('materials.reading.save', { documentId: 'doc-0', revision: 'rev-0', read });
  assert.equal((await save([{ id: 'ch-1', title: 'B' }])).ok, true);
  await pause(DEBOUNCE_MS * 6);
  assert.deepEqual(events, []);
  after = () => {
    const path = join(root, MANIFEST_FILENAME), manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.revision += 1;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  assert.equal((await save([])).ok, true);
  await eventArrives(events, 'the write after the own commit to be pushed').catch(() => {});
  assert.equal(events.length, 1, `what is on disk after the own commit is not the action's: ${JSON.stringify(events)}`);
});

async function seedDeck(root, cards = 1) {
  await new StudyService(root).store.update((state) => {
    state.decks.push({ id: 'd', title: '数学', course: '数学', cards: Array.from({ length: cards }, (_, i) => ({
      id: `d-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`, prompt: `题目 ${i}`, answer: '正确答案', explanation: '先核对条件，然后展开推理。',
      options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }] })) });
  });
}

test('the answer that finishes a round is not acknowledged: the finished round reaches subscribers', async (t) => {
  const root = await withRoot(t, 'quiet-complete-');
  await seedDeck(root, 2);
  const { bus, events } = await watchedBus(t, root);
  // Which answers finish a round is the study context's business; here the answer that commits says it did (value.complete), as the last one of a round does.
  const call = StudyService.prototype.call;
  let finishes = false;
  StudyService.prototype.call = async function (action, ...args) {
    const value = await call.call(this, action, ...args);
    return action === 'review.answer' && finishes ? { ...value, complete: true } : value;
  };
  t.after(() => { StudyService.prototype.call = call; });
  const host = hostFor(t, root, bus);
  const started = await host('review.start', { mode: 'new', deckId: 'd', count: 2 });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  await eventArrives(events, 'review.start (not quiet) to be pushed').catch(() => {});
  events.length = 0;
  const first = await host('review.answer', { runId: started.value.id, cardId: started.value.card.id, selected: ['a'] });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  await pause(DEBOUNCE_MS * 6);
  assert.deepEqual(events, [], 'an answer inside the round stays quiet');
  const moved = await host('review.move', { runId: started.value.id, direction: 1 });
  await pause(DEBOUNCE_MS * 6);
  events.length = 0;
  finishes = true;
  const last = await host('review.answer', { runId: started.value.id, cardId: moved.value.card.id, selected: ['a'] });
  assert.equal(last.ok, true, JSON.stringify(last.error));
  assert.equal(last.value.complete, true);
  await eventArrives(events, 'the finished round to be pushed').catch(() => {});
  assert.ok(events.length >= 1, 'a complete review.answer must not be swallowed as a quiet write');
});

test('background work started inside an action is not the action\'s: its commits are not collected, before or after the action returns', async (t) => {
  const root = await withRoot(t, 'quiet-detach-');
  await seedDeck(root, 1);
  const store = new StudyService(root).store;
  const write = (name) => store.update((state) => { state.courses = [...(state.courses || []), { name }]; });

  // A task of the runtime's task service (lib/runtime/tasks.js), finished before the action returns.
  const registry = { jobs: new Map(), generationControllers: new Map(), settled: new Map() };
  const tasks = createTaskService(root, registry).scoped(Symbol('owner'), 'test');
  const viaTask = await collectCommits(async () => {
    const task = tasks.start({ label: 'job' }, () => write('task'));
    await registry.settled.get(task.id);
  });
  assert.deepEqual(viaTask.commits, [], 'a task started inside the action commits on its own account');

  // A job of the in-process executor (lib/jobs/executor.js).
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const viaExecutor = await collectCommits(async () => {
    hostJobExecutor().start({ kind: 'test', title: 'job', run: async () => { await write('executor'); done(); return { status: 'completed' }; } });
    await finished;
  });
  assert.deepEqual(viaExecutor.commits, [], 'an executor job started inside the action commits on its own account');

  // Anything still running when the action returns: a commit after that is never added to the action's list.
  let late;
  const { commits } = await collectCommits(async () => {
    await write('own');
    late = Promise.resolve().then(() => pause(30)).then(() => write('late'));
  });
  assert.equal(commits.length, 1);
  await late;
  assert.equal(commits.length, 1, 'the list closes when the action returns');
});

test('a daily recap that review.answer starts inside a quiet window is pushed, not swallowed with the answer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T12:00:00+08:00') });
  const root = await withRoot(t, 'quiet-recap-');
  const writing = '# 今日学习总结\n\n' + '围绕已练习的知识点整理正确思路，核对条件与推理步骤。'.repeat(8);
  const service = new StudyService(root, { complete: async () => writing });
  t.after(() => service.dispose());
  await seedDeck(root, 12);
  let run = await service.call('review.start', { mode: 'new', deckId: 'd', count: 12, ordered: true });
  for (let i = 0; i < 10; i++) {
    await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['a'] });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  await service.call('settings', { dailyRecap: { automatic: true } });
  const { bus, events } = await watchedBus(t, root);
  const release = bus.beginQuietWrite(root);
  // The 11th answer starts the recap; the action waits for it here so that the recap's commits land inside the window, before it returns.
  const { commits } = await collectCommits(async () => {
    await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['a'] });
    const noteId = (await service.call('note.daily.status', { runId: run.id })).groups[0].noteId;
    await until(async () => (await service.call('note.get', { id: noteId })).generation?.status === 'done', 'the recap to be written', { timeoutMs: 10_000 });
  });
  bus.acknowledgeWrite(root, commits);
  release();
  assert.notEqual(commits.at(-1)?.to, (await readLibraryMeta(root)).stamp, 'the recap\'s commits are not the answer\'s');
  await eventArrives(events, 'the recap to be pushed').catch(() => {});
  assert.ok(events.length >= 1, 'the recap written by a background job must reach subscribers');
});
