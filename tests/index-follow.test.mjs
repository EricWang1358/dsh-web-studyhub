/* 新资料自动补建索引 (docs/large-documents.md): new materials of a course that already has an index are added to it by the ordinary index build, once
   for a burst of imports, one follow-up after a build that was going, never for a course without an index, never without the extension, never when the
   learner turned it off. The search extension is a fake port; nothing is indexed anywhere, no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { INDEX_TOOLS, contentHash, writeManifest } from '../lib/retrieval-index.js';
import { coursesToFollow, followIndex, setFollowTiming, stopFollow } from '../lib/contexts/generation/retrieval/index-follow.js';
import { indexPort } from './helpers/book-index-port.mjs';
import { sleep, until } from './helpers/wait.mjs';
import { SWITCH_MODES, switchOptions } from './helpers/runtime-switch.mjs';

setFollowTiming({ quietMs: 120, pollMs: 40 });

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'study-follow-home-')), before = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return dir;
}
const page = (id, course, text = `${id} text`) => ({ id, title: id, text, courses: [course] });

test('which courses are followed: those with some pages indexed and some new or changed; parents first', () => {
  const state = { sources: [page('a1', 'A'), page('a2', 'A'), page('b1', 'B'), page('c1', 'C')], decks: [], courses: [] };
  const manifest = { sources: { a1: { hash: contentHash('a1 text') }, b1: { hash: contentHash('b1 text') }, c1: { hash: 'old' } } };
  assert.deepEqual(coursesToFollow(state, manifest), ['A', 'C'], 'A has a new page, C an edited one; B is complete; a course never indexed is not there');
  assert.deepEqual(coursesToFollow(state, { sources: {} }), []);
});

/** The follow over fake ports and fake index runs: { starts, setRunning, ports }. */
async function fakeFollow(t, { running = false, indexed = true, extension = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-follow-lib-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { sources: [page('a1', 'A'), page('a2', 'A'), page('z1', 'Z')], decks: [], courses: [] };
  if (indexed) await writeManifest(root, { sources: { a1: { hash: contentHash('a1 text') } } });
  const starts = [];
  let busy = running;
  const runs = { building: async () => (busy ? { course: 'X', done: 0, total: 1 } : null), start: async ({ course }) => { starts.push(course); busy = true; } };
  const ports = { state: { root, read: async () => state }, retrieval: extension ? indexPort() : { tools: () => [] } };
  return { root, starts, setRunning: value => { busy = value; }, follow: () => followIndex(ports, { runsOf: () => runs }) };
}

test('a burst of arrivals starts ONE build, after the last one; a course never indexed is left alone', async t => {
  await home(t);
  const f = await fakeFollow(t);
  for (let i = 0; i < 4; i++) { assert.deepEqual(await f.follow(), { following: true }); await sleep(20); }
  assert.deepEqual(f.starts, [], 'nothing while imports keep coming');
  await until(() => f.starts.length === 1, 'the build');
  f.setRunning(false);
  await sleep(300);
  assert.deepEqual(f.starts, ['A'], 'one build, of the indexed course only (Z has no index)');
});

test('a build that is going is followed by one more after it ends', async t => {
  await home(t);
  const f = await fakeFollow(t, { running: true });
  await f.follow();
  await sleep(400);
  assert.deepEqual(f.starts, [], 'never a second build beside one that is going');
  f.setRunning(false);
  await until(() => f.starts.length === 1, 'the follow-up build');
  f.setRunning(false);
  await sleep(300);
  assert.deepEqual(f.starts, ['A']);
});

test('nothing automatic without the extension, without an index, or with the setting off', async t => {
  await home(t);
  const bare = await fakeFollow(t, { extension: false });
  assert.deepEqual(await bare.follow(), { following: false });
  const unindexed = await fakeFollow(t, { indexed: false });
  await unindexed.follow();
  await sleep(400);
  assert.deepEqual(unindexed.starts, []);
  // The library's context goes away before the quiet time is over: no build after it.
  const closing = await fakeFollow(t);
  await closing.follow();
  stopFollow(closing.root);
  await sleep(400);
  assert.deepEqual(closing.starts, []);
});

for (const mode of SWITCH_MODES) {
  test(`${mode}: imports into an indexed course are indexed by themselves, once; another course and the switch turned off are not`, { timeout: 120000 }, async t => {
    await home(t);
    const root = await mkdtemp(join(tmpdir(), 'study-follow-'));
    const port = indexPort();
    const study = new StudyService(root, { coach: false, retrieval: port, ...switchOptions(mode, { paths: ['retrievalIndex'] }) });
    t.after(async () => { await study.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
    const book = name => Array.from({ length: 3 }, (_, i) => `<!-- page: ${i + 1} -->\n${name} 第 ${i + 1} 页讲进程。`).join('\n\n');
    const importBook = (name, course) => study.call('materials.document.import', { dataBase64: Buffer.from(book(name), 'utf8').toString('base64'), filename: `${name}.md`, courses: [course] });
    await importBook('OS', 'OS');
    assert.equal((await study.call('retrieval.status')).autoIndex, true, 'on by default');
    await sleep(400);
    assert.deepEqual(port.ingested(), [], 'a course without an index is not indexed by itself');
    await study.call('retrieval.index.start', { course: 'OS' });
    await until(async () => (await study.call('retrieval.index.plan', { course: 'OS' })).toIndex === 0 && !(await study.call('retrieval.index.coverage')).building, 'the first build');
    const first = port.ingested().length;
    await importBook('OS2', 'OS');
    await importBook('OS3', 'OS');
    await study.call('source.add', { title: 'OS note', text: 'Processes and threads.', courses: ['OS'] });
    await until(async () => (await study.call('retrieval.index.plan', { course: 'OS' })).toIndex === 0, 'the new pages to be indexed by themselves');
    await until(async () => !(await study.call('retrieval.index.coverage')).building, 'the build to end');
    const added = port.ingested().slice(first);
    assert.equal(added.length, 7, `3 + 3 pages and one note, each once: ${added.join(' ')}`);
    assert.equal(new Set(added).size, added.length);
    await study.call('retrieval.auto.set', { on: false });
    assert.equal((await study.call('retrieval.status')).autoIndex, false);
    await importBook('OS4', 'OS');
    await sleep(500);
    assert.equal(port.ingested().length, first + 7, 'turned off: nothing more');
    assert.ok(port.calls.every(call => call.name !== INDEX_TOOLS.query), 'only writes, no search');
  });
}
