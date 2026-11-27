import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LATEST_VERSION, Store } from '../../../../../../lib/store.js';
import { StudyService } from '../../../../../../lib/service.js';

const code = await readFile(new URL('../../main/resources/io/studyhub/gateway/desktop-history-source.mjs', import.meta.url), 'utf8');
const sidecar = process.env.STUDYHUB_TEST_SIDECAR_ENTRY || fileURLToPath(
  new URL('../../../../../../packages/studyhub-desktop/entry/sidecar.mjs', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studyhub-history-test-'));
  const root = join(directory, '库 space');
  await mkdir(root);
  const cleanup = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
  });
  return { root, cleanup, store: new Store(root) };
}
function start({ root, cleanup }) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, sidecar, root], {
    cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const exited = once(proc, 'close');
  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let errors = '';
  proc.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  cleanup.push(async () => {
    if (proc.exitCode == null && !proc.signalCode) proc.kill();
    await exited;
  });
  return {
    ack() { proc.stdin.write('ack\n'); },
    async identity() {
      proc.stdin.write('identity\n');
      const line = await lines.next();
      return JSON.parse(line.value).identity;
    },
    async scan() {
      proc.stdin.write('scan\n');
      const rows = [];
      for (;;) {
        const line = await lines.next();
        assert.equal(line.done, false, 'Unexpected helper exit: ' + errors);
        const row = JSON.parse(line.value);
        if (row.error) throw new Error(row.error);
        if (row.done) return rows;
        rows.push(row);
      }
    },
    async close() { proc.stdin.end(); assert.deepEqual(await exited, [0, null], errors); },
  };
}

test('source streams exact committed rows, replays unacknowledged scans and observes real correction and undo', { timeout: 90_000 }, async t => {
  const env = await fixture(t);
  const service = new StudyService(env.root);
  env.cleanup.push(() => service.dispose());
  const timestamp = '2025-08-01T09:00:00.000Z';
  const card = { id: 'quiz', kind: 'open', topic: '共识', prompt: 'Define quorum.', answer: 'A majority.' };
  const assisted = { used: true, hinted: true, unseenStatus: 'unknown' };
  const longId = '历史/long id:' + '问'.repeat(400);
  await env.store.update(state => {
    state.decks.push({ id: 'd', title: '题组', course: 'Consensus', cards: [card] });
    state.runs.push({ id: 'r', mode: 'path', deckId: 'd', index: 0, entries: [{
      card, deckId: 'd', revealed: true, feedback: { grade: 4, correct: true, gradedAt: timestamp, rubric: { total: 2, max: 2 } },
    }] });
    state.attempts.push({ id: longId, runId: 'r', entryIndex: 0, deckId: 'd', quiz_id: card.id, timestamp, grade: 4,
      assessment: 'rubric', assistance: assisted, criteria: { literal: 'line one\nline two' }, future: { text: '大'.repeat(98_000) } });
    // Cross a real Store ATTEMPT_CHUNK boundary; later updates change this first, full chunk in place.
    for (let i = 0; i < 1001; i++) state.attempts.push({ id: 'old-' + i, deckId: 'orphan', courseId: 'deleted-course' });
    state.attempts.push({ quiz_id: 'orphan', legacy: { z: 1, a: 2 } }, { legacy: { a: 2, z: 1 }, quiz_id: 'orphan' });
  });
  const helper = start(env);
  const directory = await stat(env.root, { bigint: true });
  assert.equal(await helper.identity(), directory.dev + ':' + directory.ino);
  const exported = await env.store.read();
  const initial = await helper.scan();
  assert.deepEqual(initial.map(row => row.attempt), exported.attempts);
  assert.equal(initial[0].course, exported.decks[0].courseId);
  assert.equal(initial[0].deck, 'd');
  assert.deepEqual(initial[1], { attempt: exported.attempts[1], course: 'deleted-course', deck: 'orphan' });
  assert.deepEqual(initial.slice(-2).map(({ course, deck, occurrence }) => [course, deck, occurrence]), [[null, null, 0], [null, null, 1]]);
  assert.deepEqual(await helper.scan(), initial);
  helper.ack();
  assert.deepEqual(await helper.scan(), []);
  helper.ack();
  await env.store.update(state => { state.notes.push({ id: 'unrelated', note: 'no history changes' }); });
  assert.deepEqual(await helper.scan(), []);
  helper.ack();
  await service.call('review.grade.adjust', { runId: 'r', entryIndex: 0, cardId: 'quiz', grade: 2 });
  const delta = await helper.scan();
  assert.equal(delta.length, 1, 'adjusting one of 1004 attempts sends one row to Java');
  const adjusted = delta[0].attempt;
  assert.deepEqual(adjusted, (await env.store.read()).attempts[0]);
  assert.equal(adjusted.gradeOriginal, 4);
  assert.equal(adjusted.grade, 2);
  assert.ok(adjusted.adjustedAt);
  assert.deepEqual(adjusted.assistance, assisted);
  helper.ack();
  await service.call('review.undo', { runId: 'r', attemptId: longId });
  const undoDelta = await helper.scan();
  assert.equal(undoDelta.length, 1);
  const committed = (await env.store.read()).attempts;
  assert.deepEqual(undoDelta[0].attempt, committed[0]);
  assert.ok(undoDelta[0].attempt.voidedAt);
  const unacked = await helper.scan();
  assert.deepEqual(unacked.map(row => row.attempt), committed, 'unacknowledged delta causes full recovery replay');
  await helper.close();
  const restarted = start(env);
  assert.equal(await restarted.identity(), directory.dev + ':' + directory.ino);
  assert.deepEqual(await restarted.scan(), unacked);
  await restarted.close();
});

test('physical library binding, historical scopes and read-only failure recovery', { timeout: 45_000 }, async t => {
  const env = await fixture(t);
  const { root } = env;
  const helper = start(env);
  assert.deepEqual(await helper.scan(), []);
  assert.deepEqual(await readdir(root), []);
  helper.ack();
  const manifest = join(root, 'study-workspace.json');
  const record = { quiz_id: 'q', id: '', deckId: 'd', course: 'stale-name', grade: 0 };
  const saved = { version: LATEST_VERSION, courses: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    decks: [{ id: 'd', courseId: 'a' }, { id: 'd', courseId: 'b' }], attempts: [
      record, { id: 'saved', deckId: 'missing', courseId: 'b' }, { id: 'null', deckId: 'd', courseId: null },
      { id: 'orphan', deckId: 'missing', course: 'A' }, { id: 'blank-scope', deckId: '', courseId: '' },
    ] };
  const write = async value => {
    const temp = manifest + '.new';
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, manifest);
  };
  await write(saved);
  const rows = await helper.scan();
  assert.deepEqual(rows.map(row => row.course), [null, 'b', null, null, null]);
  assert.deepEqual(rows[4], { attempt: saved.attempts[4], deck: null, course: null });
  assert.equal(rows[0].occurrence, 0);
  assert.deepEqual(rows[0].attempt, record);
  helper.ack();
  for (const invalid of [{ ...saved, version: LATEST_VERSION + 1 }, { ...saved, format: 'unknown-storage' }]) {
    await write(invalid);
    const before = await readFile(manifest);
    await assert.rejects(helper.scan(), /newer|Unsupported/);
    assert.deepEqual(await readFile(manifest), before);
    helper.ack();
    await write(saved);
    assert.deepEqual(await helper.scan(), rows);
    helper.ack();
  }
  await write({ version: 1, attempts: [{ id: 'legacy', grade: 1 }] });
  const legacyBytes = await readFile(manifest);
  assert.deepEqual(await helper.scan(), [{ attempt: { id: 'legacy', grade: 1 }, course: null, deck: null }]);
  assert.deepEqual(await readFile(manifest), legacyBytes);
  helper.ack();
  await rename(root, root + '-old');
  await mkdir(root);
  await assert.rejects(helper.scan(), /replaced/);
  assert.deepEqual(await readdir(root), []);
  await helper.close();
});

test('a damaged attempt shard cannot be acknowledged and its repair is visible without rewriting the manifest', { timeout: 45_000 }, async t => {
  const env = await fixture(t);
  const { root, store } = env;
  await store.update(state => {
    state.decks.push({ id: 'deck', course: 'A', cards: [] });
    state.attempts.push({ id: 'a', deckId: 'deck', grade: 1, course: 'obsolete label' });
  });
  const manifest = join(root, 'study-workspace.json');
  const manifestBytes = await readFile(manifest);
  const shard = join(root, 'shards', JSON.parse(manifestBytes).shards.attempts[0]);
  const shardBytes = await readFile(shard);
  await writeFile(shard, '{');
  const helper = start(env);
  await assert.rejects(helper.scan(), /unreadable shards/);
  helper.ack();
  assert.deepEqual(await readFile(manifest), manifestBytes);
  assert.equal(await readFile(shard, 'utf8'), '{');
  await writeFile(shard, shardBytes);
  const [original] = await helper.scan();
  assert.equal(original.course, (await store.read()).decks[0].courseId);
  helper.ack();
  await store.update(state => { state.decks[0].course = 'B'; });
  const [moved] = await helper.scan();
  assert.deepEqual(moved.attempt, original.attempt);
  assert.equal(moved.course, (await store.read()).decks[0].courseId);
  assert.notEqual(moved.course, original.course);
  helper.ack();
  await store.update(state => { state.decks.length = 0; });
  assert.deepEqual(await helper.scan(), [{ attempt: original.attempt, course: null, deck: 'deck' }]);
  await helper.close();
});

test('a restored library may reuse a named scoped attempt ID; each occurrence retains its identity on restart', { timeout: 45_000 }, async t => {
  const env = await fixture(t);
  const shared = { id: 'duplicate', quiz_id: 'card', deckId: 'deck' };
  await env.store.restore({ version: LATEST_VERSION, sources: [], decks: [], drafts: [], runs: [], attempts: [
    { ...shared, grade: 1 }, { ...shared, grade: 4 }, { ...shared, grade: 2, deckId: 'separate' },
  ] });
  const helper = start(env);
  const initial = await helper.scan();
  assert.deepEqual(initial.map(row => row.occurrence), [undefined, 1, undefined]);
  helper.ack();
  await env.store.update(state => { state.attempts[1].grade = 5; });
  const delta = await helper.scan();
  assert.deepEqual(delta, [{ ...initial[1], attempt: { ...shared, grade: 5 } }]);
  helper.ack();
  assert.deepEqual(await helper.scan(), []);
  await helper.close();
  const restarted = start(env);
  assert.deepEqual(await restarted.scan(), [initial[0], delta[0], initial[2]]);
  await restarted.close();
});
