import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { createHostHandler } from '../../lib/host.js';
import { MANIFEST_FILENAME, createLibraryEventBus, readLibraryMeta } from '../../lib/runtime/library-watch.js';
import { until } from './wait.mjs';

/* Shared by the quiet-write tests (tests/library-quiet-write*.test.mjs): a library on disk, a watched event bus, writers that are not StudyHub's own. */

export const DEBOUNCE_MS = 40;
export const pause = (ms) => new Promise((done) => setTimeout(done, ms));
// An expected event is waited for (a loaded machine delivers fs.watch late); an event that must not come gets a few debounce windows to show up.
export const eventArrives = (events, what) => until(() => events.length > 0, what, { timeoutMs: 10_000 }).then(() => pause(DEBOUNCE_MS * 5));

export async function withRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}

/** Another writer (CLI, main chat, a desktop sidecar) bumps the revision without writing the refresh signal. */
export function foreignWrite(root) {
  const path = join(root, MANIFEST_FILENAME);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.revision += 1;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.revision;
}

/** A plain-file stand-in for the store's own commit: the record the store gives for it ({from, to, revision}). */
export async function ownCommit(root, revision) {
  const from = (await readLibraryMeta(root)).stamp;
  await writeFile(join(root, MANIFEST_FILENAME), JSON.stringify({ revision, own: true }));
  return { from, to: (await readLibraryMeta(root)).stamp, revision };
}

/** A bus watching `root`, its events collected; `settle` waits for the watcher's first stamp read. */
export async function watchedBus(t, root, { settle = true, ...options } = {}) {
  const bus = createLibraryEventBus({ debounceMs: DEBOUNCE_MS, ...options });
  const events = [];
  t.after(() => bus.dispose());
  bus.subscribe(root, (event) => events.push(event));
  if (settle) await pause(300);
  return { bus, events };
}

/** A library with one document (for materials.reading.save). */
export async function seedDocument(root) {
  const now = new Date().toISOString();
  await new StudyService(root).store.update((state) => {
    state.sources = [{ id: 'src-0', title: 'a.md', text: '# A\n\n## B\n\nbody\n', format: 'markdown', createdAt: now, importedAt: now,
      document: { materialId: 'doc-0', materialRevision: 'rev-0', format: 'md', filename: 'a.md' } }];
    state.documents = [{ id: 'doc-0', title: 'a.md', filename: 'a.md', format: 'md', currentRevision: 'rev-0',
      versions: [{ revision: 'rev-0', sourceIds: ['src-0'], importedAt: now, attachment: null }] }];
  });
}

/** The panel's host handler over `root`, with `libraryEvents` as its bus: call(action, args). */
export function hostFor(t, root, libraryEvents) {
  const cleanups = [];
  const sessions = new Map([['s', { header: { cwd: root } }]]);
  const ctx = { sessions, get: (name) => (name === 'sessions' ? sessions : undefined),
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') cleanups.push(dispose); } };
  t.after(() => Promise.allSettled(cleanups.map((fn) => fn())));
  const handler = createHostHandler(ctx, {}, undefined, { owner: ctx, libraryEvents });
  return (action, args) => handler('call', { action, sessionId: 's', args });
}
