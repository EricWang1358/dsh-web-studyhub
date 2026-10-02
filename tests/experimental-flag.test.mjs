import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimentalPath, readExperimental, setExperimental } from '../lib/experimental.js';
import { StudyService } from '../lib/service.js';

/* The one switch that makes the experimental features visible at all: "Show experimental features" (Settings › Advanced). Off by default.
   It lives in the StudyHub settings folder of the DSH home next to the other plugin settings (not in the library, so a backup or export
   never turns it on somewhere else) and rides on the snapshot, so no surface needs a request of its own to know it. */

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-experimental-'));
  const before = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(async () => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true }); });
  return home;
}

test('off by default, switched by one boolean, stored in the DSH home and nowhere else', async t => {
  const home = await withHome(t);
  assert.equal(await readExperimental(), false);
  assert.equal(experimentalPath(), join(home, 'study', 'experimental.json'));
  assert.equal(await setExperimental(true), true);
  assert.equal(await readExperimental(), true);
  assert.equal(JSON.parse(await readFile(experimentalPath(), 'utf8')).enabled, true);
  assert.equal(await setExperimental(false), false);
  assert.equal(await readExperimental(), false);
  await assert.rejects(setExperimental('yes'), /true 或 false/);
  await writeFile(experimentalPath(), '{ not json');
  assert.equal(await readExperimental(), false, 'a damaged file means off');
  await writeFile(experimentalPath(), JSON.stringify({ enabled: 'true' }));
  assert.equal(await readExperimental(), false, 'only a real boolean true counts');
});

test('the service exposes it as experimental.get / experimental.set and the snapshot carries it, so turning it off hides everything again at once', async t => {
  await withHome(t);
  const root = await mkdtemp(join(tmpdir(), 'study-experimental-lib-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await service.call('snapshot')).experimental, false);
  assert.deepEqual(await service.call('experimental.get'), { enabled: false });
  assert.deepEqual(await service.call('experimental.set', { enabled: true }), { enabled: true });
  assert.equal((await service.call('snapshot')).experimental, true);
  await assert.rejects(service.call('experimental.set', { enabled: 'x' }), /true 或 false/);
  await service.call('experimental.set', { enabled: false });
  assert.equal((await service.call('snapshot')).experimental, false);
  // The library itself holds no trace of it (it is exported and backed up).
  assert.ok(!JSON.stringify(await service.call('export')).includes('experimental'));
});
