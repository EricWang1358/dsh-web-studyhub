import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { MANIFEST_FILENAME, readLibraryMeta } from '../lib/runtime/library-watch.js';
import { DEBOUNCE_MS, eventArrives, foreignWrite, hostFor, ownCommit, pause, seedDocument, watchedBus, withRoot } from './helpers/quiet-write.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/* A quiet local write (lib/host.js QUIET_LOCAL_MUTATIONS) holds the disk watcher back so StudyHub's own commit is not echoed as a full reload.
   The window must swallow only that commit: a write by another process or a background job inside it is still reported, at the latest when it ends.
   The races around it (a fresh watcher, background work started inside the action, a finished round) are in library-quiet-write-races.test.mjs. */

test('a quiet window swallows its own commit even when the acknowledgement comes after the debounce', async (t) => {
  const root = await withRoot(t, 'quiet-own-');
  await writeFile(join(root, MANIFEST_FILENAME), JSON.stringify({ revision: 1 }));
  const { bus, events } = await watchedBus(t, root);

  const release = bus.beginQuietWrite?.(root) ?? (() => {});
  const commit = await ownCommit(root, 2);
  await pause(DEBOUNCE_MS * 5); // a slow action: the watcher has long seen the rename
  bus.acknowledgeWrite(root, [commit]);
  release();
  await pause(DEBOUNCE_MS * 5);
  assert.deepEqual(events, [], 'StudyHub\'s own quiet commit must not come back as a library-changed event');
});

test('a foreign write inside a quiet window is reported when the window ends, not swallowed with the own commit after it', async (t) => {
  const root = await withRoot(t, 'quiet-foreign-');
  await writeFile(join(root, MANIFEST_FILENAME), JSON.stringify({ revision: 1 }));
  const { bus, events } = await watchedBus(t, root);

  const release = bus.beginQuietWrite?.(root) ?? (() => {});
  foreignWrite(root);
  await pause(DEBOUNCE_MS * 5);
  const commit = await ownCommit(root, 3);
  await pause(DEBOUNCE_MS * 5);
  assert.deepEqual(events, [], 'nothing is sent while the quiet write is in flight');
  bus.acknowledgeWrite(root, [commit]);
  release();
  await eventArrives(events, 'the foreign write to be reported');
  assert.deepEqual(events.map(({ revision, reason }) => ({ revision, reason })), [{ revision: 3, reason: 'disk' }],
    'one event once the window ends, carrying what is on disk now');
});

test('a quiet host action (materials.reading.save) during which another writer commits still wakes subscribers; alone it stays quiet', async (t) => {
  const root = await withRoot(t, 'quiet-host-');
  await seedDocument(root);
  const { bus, events } = await watchedBus(t, root);
  let duringWindow = null;
  // The other writer lands after the window opened and before StudyHub's own commit: the race the window must not hide.
  const libraryEvents = { ...bus, beginQuietWrite(at) {
    const release = bus.beginQuietWrite(at);
    duringWindow?.();
    return release;
  } };
  const call = hostFor(t, root, libraryEvents);
  const save = (read) => call('materials.reading.save', { documentId: 'doc-0', revision: 'rev-0', read });

  const alone = await save([{ id: 'ch-1', title: 'B' }]);
  assert.equal(alone.ok, true, JSON.stringify(alone.error));
  await pause(DEBOUNCE_MS * 6);
  assert.deepEqual(events, [], 'the action\'s own commit stays quiet');

  duringWindow = () => foreignWrite(root);
  const raced = await save([]);
  assert.equal(raced.ok, true, JSON.stringify(raced.error));
  await eventArrives(events, "the other writer's change to be pushed").catch(() => {});
  assert.equal(events.length, 1, `the other writer's change must be pushed, got ${JSON.stringify(events)}`);
  assert.equal(events[0].reason, 'disk');
  assert.equal(events[0].revision, (await readLibraryMeta(root)).revision);

  // A background job of this same process commits through the store too; its commit is not the action's, so it is not swallowed either.
  events.length = 0;
  let job = null;
  duringWindow = () => { job = new StudyService(root).store.update((state) => { state.courses = [...(state.courses || []), { name: 'Job course' }]; }); };
  const queued = await save([{ id: 'ch-1', title: 'B' }]);
  assert.equal(queued.ok, true, JSON.stringify(queued.error));
  await job;
  await eventArrives(events, "the background job's commit to be pushed").catch(() => {});
  assert.equal(events.length, 1, `the background job's commit must be pushed, got ${JSON.stringify(events)}`);
  assert.equal(events[0].revision, (await readLibraryMeta(root)).revision);
});
