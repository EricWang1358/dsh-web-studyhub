import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveDirectory, currentDirectory } from '../lib/working-directory.js';
import { createHostHandler } from '../lib/host.js';

/* DSH 0.2.1 lets a conversation change its folder (the host-wide working_directory tool); the session header keeps
   the folder it started in (@deepseek-ai/dsh-working-directory 0.2.1-rc.2). A path the learner names is relative to
   the current folder, as DSH's own @ mentions are; the StudyHub library stays bound to the original one. */
function host021(session, current) {
  return { get: name => name === 'workingDirectory' ? { get: () => current }
    : name === 'sessionProjections' ? { stateOf: (of, key) => of === session && key === 'workingDirectory' ? current : undefined } : undefined };
}

test('the current folder follows a change the conversation made on DSH 0.2.1', () => {
  const session = { header: { cwd: join(tmpdir(), 'started-here') } };
  const moved = join(tmpdir(), 'moved-here');
  assert.equal(effectiveDirectory(host021(session, moved), session), moved);
});

test('without the DSH 0.2.1 service, or without a usable answer, the header folder is the folder', () => {
  const session = { header: { cwd: join(tmpdir(), 'started-here') } };
  assert.equal(effectiveDirectory({ get: () => undefined }, session), session.header.cwd, 'DSH 0.2.0');
  assert.equal(effectiveDirectory(host021(session, null), session), session.header.cwd, 'no recorded change');
  assert.equal(effectiveDirectory(host021(session, 'relative/dir'), session), session.header.cwd);
  const throwing = { get: name => name === 'workingDirectory' ? {} : { stateOf() { throw new Error('not live'); } } };
  assert.equal(effectiveDirectory(throwing, session), session.header.cwd);
  assert.equal(effectiveDirectory(host021(session, '/x'), undefined, '/fallback'), '/fallback', 'a session that is not live');
});

test("the panel's audio picker lists the conversation's current folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-wd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = join(root, 'course'), moved = join(root, 'course', 'week-3');
  await mkdir(moved, { recursive: true });
  await writeFile(join(started, 'old.mp3'), 'x');
  await writeFile(join(moved, 'lecture.mp3'), 'x');
  const session = { header: { cwd: started } };
  const ctx = { sessions: { get: () => session }, ...host021(session, moved) };
  const handle = createHostHandler(ctx, { libraryRoot: join(root, 'library') }, () => async () => '{}');
  const answer = await handle('call', { sessionId: 'learner', action: 'audio.files', args: {} });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.value.files.map(file => file.name || file.path).map(name => name.split(/[\\/]/).pop()), ['lecture.mp3']);
});

/* A cold panel: the conversation is not live, so its folder is read from the projection DSH 0.2.1 checkpoints when a session
   detaches (@deepseek-ai/dsh-session-projection-cache 0.2.1-rc.2 `cachedSnapshot(header, keys)`, zero I/O), never by replaying
   the whole log. Without that row, or on DSH 0.2.0, the folder the conversation started in is used. */
function coldHost(header, current, { cache = true, service = true } = {}) {
  const stats = [];
  return { stats, ctx: { sessions: { get: () => undefined }, get: name => name === 'workingDirectory' ? (service ? {} : undefined)
    : name === 'sessionPersistence' ? { stat: async id => { stats.push(id); return id === header.id ? { header } : undefined; } }
    : name === 'sessionProjectionCache' && cache ? { cachedSnapshot: (meta, keys) => meta === header && keys.includes('workingDirectory')
      ? { asOfSeq: 4, values: { workingDirectory: current } } : undefined } : undefined } };
}

test('a cold panel reads the folder the conversation moved to from DSH 0.2.1\'s stored projection', async () => {
  const header = { id: 'learner', cwd: join(tmpdir(), 'started-here') };
  const moved = join(tmpdir(), 'moved-here');
  assert.equal(await currentDirectory(coldHost(header, moved).ctx, 'learner', header.cwd), moved);
  assert.equal(await currentDirectory(coldHost(header, moved, { cache: false }).ctx, 'learner', header.cwd), header.cwd, 'no stored projection');
  assert.equal(await currentDirectory(coldHost(header, moved, { service: false }).ctx, 'learner', header.cwd), header.cwd, 'DSH 0.2.0');
  assert.equal(await currentDirectory(coldHost(header, null).ctx, 'learner', header.cwd), header.cwd, 'never changed');
  assert.equal(await currentDirectory(coldHost(header, 'relative').ctx, 'learner', header.cwd), header.cwd);
  assert.equal(await currentDirectory(coldHost(header, moved).ctx, 'someone-else', header.cwd), header.cwd, 'an unknown session');
  const live = { header: { cwd: header.cwd } };
  const liveCtx = { sessions: { get: () => live }, ...host021(live, moved) };
  assert.equal(await currentDirectory(liveCtx, 'learner', header.cwd), moved, 'a live session reads its projection directly');
});

test("a cold panel's audio picker lists the folder the conversation moved to", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-wd-cold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = join(root, 'course'), moved = join(root, 'course', 'week-3');
  await mkdir(moved, { recursive: true });
  await writeFile(join(started, 'old.mp3'), 'x');
  await writeFile(join(moved, 'lecture.mp3'), 'x');
  const header = { id: 'learner', cwd: started };
  const { ctx } = coldHost(header, moved);
  const handle = createHostHandler(ctx, { libraryRoot: join(root, 'library') }, () => async () => '{}');
  const answer = await handle('call', { sessionId: 'learner', action: 'audio.files', args: {} });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.value.files.map(file => file.name || file.path).map(name => name.split(/[\\/]/).pop()), ['lecture.mp3']);
});
