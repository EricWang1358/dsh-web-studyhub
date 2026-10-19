import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveDirectory } from '../lib/working-directory.js';
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
