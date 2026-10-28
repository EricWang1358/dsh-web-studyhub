import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename as fsRename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLiveLocalInstaller, effectiveLiveLocal, liveLocalLayout } from '../lib/live-local-install.js';
import { LIVE_LOCAL_MESSAGES } from '../lib/live-local-install-text.js';
import { fakeFetch, fakePins, liveLocalHome } from './helpers/live-local-fakes.mjs';

/* The local engine's install after the security gate review: the space check needs only what is left to do, a damaged engine is noticed and 修复 restores
   just that step, a move removes the broken folder it leaves, downloads are capped at their pinned size, a full disk is reported as a full disk, a pin
   without a checksum is refused, and the folder rename survives a scanner holding the files for a moment. Tiny pinned files; nothing downloaded. */

const MB = 1_048_576;
const exists = file => stat(file).then(() => true, () => false);
const drives = async () => [{ root: 'C:\\', freeMb: 50_000, totalMb: 100_000, system: true }];

async function harness(t, { pins: pinOptions, seams: extra = {} } = {}) {
  const where = await liveLocalHome(t), fake = fakePins(pinOptions), net = fakeFetch(fake.files);
  const space = { freeMb: 50_000 };
  const seams = { arch: 'x64', pins: { ...fake.pins, platforms: { [`${process.platform}-x64`]: fake.pins.platforms['win32-x64'] } }, fetch: net.fetch, drives,
    freeMegabytes: async () => space.freeMb, checkEngine: async () => ({ version: 'fake' }), legacyModelFolders: [], marginMb: 1, ...extra };
  const installer = createLiveLocalInstaller(seams);
  const ended = async () => { await installer.idle(); return installer.status(); };
  const layout = folder => liveLocalLayout(folder || where.location, { arch: 'x64', seams });
  return { ...where, fake, net, seams, space, installer, ended, layout, start: (args = {}) => installer.start({ confirm: true, location: where.location, ...args }) };
}
const nativeOf = h => join(h.layout().nativePath, 'sherpa-onnx.node');

test('the space check needs only what is left: a partly downloaded model continues on a disk a fresh install would not fit, the model counted once', async t => {
  const h = await harness(t, { pins: { modelBytes: 3 * MB } });
  const fresh = (await h.installer.plan({ location: h.location })).disk.neededMb;
  const model = h.fake.pins.model[0];
  h.net.rules.set(model.url, { cutAfter: Math.round(2.5 * MB) });
  await h.start();
  assert.equal((await h.ended()).error.code, 'network');
  const left = (await h.installer.plan({ location: h.location })).disk.neededMb;
  assert.ok(left < fresh, `${left} MB left < ${fresh} MB for a fresh install`);
  assert.ok(fresh <= Math.ceil((3 * MB + 20_000 + 4000 + 100_000) / MB) + 1, 'the model is counted once (its .part is renamed, not copied)');
  h.space.freeMb = left;
  const elsewhere = await h.installer.plan({ location: join(h.dir, 'E', 'LiveLocal') });
  assert.equal(elsewhere.problems[0]?.code, 'no-space', 'a fresh install does not fit');
  h.net.rules.delete(model.url);
  await h.start();
  assert.equal((await h.ended()).status, 'complete', '继续安装 is not refused for space');
});

test('repair after a failed check needs only the margin: every file is already in place', async t => {
  let broken = true;
  const h = await harness(t, { seams: { checkEngine: async () => { if (broken) throw new Error('DLL load failed: vcruntime140.dll'); return {}; } } });
  await h.start();
  assert.equal((await h.ended()).error.code, 'vc-runtime');
  const plan = await h.installer.plan({ location: h.location });
  assert.equal(plan.disk.neededMb, 1, 'only the margin');
  h.space.freeMb = 1; broken = false;
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
});

test('a damaged engine is noticed (deleted or altered native file): not ready, needs repair, and 修复 restores only the engine', async t => {
  const h = await harness(t);
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
  const good = await readFile(nativeOf(h));
  await rm(nativeOf(h));
  let view = await h.installer.status();
  assert.equal(view.installed, false);
  assert.equal(view.ready, false);
  assert.equal(view.needsRepair, true);
  assert.equal(view.folder, h.location);
  assert.equal(await effectiveLiveLocal({ seams: h.seams }), null, '课堂实录 does not start on a broken engine');
  const before = h.net.requests.length;
  await h.start({ location: view.folder });
  view = await h.ended();
  assert.equal(view.status, 'complete');
  assert.equal(view.installed, true);
  assert.deepEqual(await readFile(nativeOf(h)), good);
  const again = h.net.requests.slice(before).map(request => request.url);
  assert.ok(again.some(url => url.includes('sherpa-onnx-win-x64')), 'the native package came again');
  assert.equal(again.some(url => url.startsWith('https://models.test/')), false, 'the model was not downloaded again');
  // Altered in place, same size: the hash tells.
  const dll = join(h.layout().nativePath, 'onnxruntime.dll');
  await writeFile(dll, Buffer.alloc(4096, 6));
  assert.equal((await h.installer.status()).needsRepair, true);
});

test('moving a broken install with removePrevious removes the old folder once the new one works', async t => {
  const h = await harness(t);
  await h.start();
  await h.ended();
  await rm(nativeOf(h));
  const moved = join(h.dir, 'E', 'StudyHub', 'LiveLocal');
  await h.installer.start({ confirm: true, location: moved, removePrevious: true });
  const view = await h.ended();
  assert.equal(view.status, 'complete');
  assert.equal(await exists(h.location), false, 'the old 250 MB folder does not stay behind');
  assert.equal((await effectiveLiveLocal({ seams: h.seams })).folder, moved);
});

test('a download larger than its pinned size stops and leaves nothing; a full disk is a full disk, not the network', async t => {
  const h = await harness(t);
  const model = h.fake.pins.model[0], layout = h.layout();
  h.net.rules.set(model.url, { oversize: 50_000 });
  await h.start();
  let view = await h.ended();
  assert.equal(view.error.code, 'checksum');
  assert.equal(await exists(join(layout.modelDir, `${model.name}.part`)), false);
  assert.equal(await exists(join(layout.modelDir, model.name)), false);
  h.net.rules.set(model.url, { failCode: 'ENOSPC' });
  await h.start();
  view = await h.ended();
  assert.equal(view.error.code, 'no-space');
  assert.equal(view.error.message, LIVE_LOCAL_MESSAGES.noSpaceShort);
  const native = h.seams.pins.platforms[`${process.platform}-x64`];
  const other = await harness(t);
  other.net.rules.set(`https://mirror.test/${native.path}`, { failCode: 'EDQUOT' });
  await other.start();
  assert.equal((await other.ended()).error.code, 'no-space');
  assert.equal(other.net.requests.some(request => request.url === `https://registry.test/${native.path}`), false, 'a full disk is not retried on another source');
});

test('a pin without a checksum is refused before anything is downloaded', async t => {
  const h = await harness(t);
  const [first, second, third] = h.seams.pins.model;
  h.seams.pins.model = [first, { ...second, sha256: undefined }, third];
  await h.start();
  const view = await h.ended();
  assert.equal(view.error.code, 'checksum');
  assert.equal(h.net.requests.some(request => request.url === second.url), false);
});

test('the unpacked folder is renamed into place even while a scanner holds it for a moment (EPERM, EBUSY retried)', async t => {
  let failures = 0;
  const rename = async (from, to) => {
    if (from.endsWith('.staging') && failures < 3) { failures += 1; throw Object.assign(new Error('operation not permitted'), { code: failures === 2 ? 'EBUSY' : 'EPERM' }); }
    return fsRename(from, to);
  };
  const h = await harness(t, { seams: { rename } });
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
  assert.equal(failures, 3);
});
