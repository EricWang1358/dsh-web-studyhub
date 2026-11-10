/* Issue #951 · "restart DSH to finish the upgrade" must not stay for ever. The marker an install leaves in update.json (pending + installedAt) says
   "restart needed" only while THIS process started before the install. A process that started after it and still runs older code is a restart that
   did not take effect (DSH was not fully quit, another copy of StudyHub took the upgrade, the old package was put back): the view says so
   (`restartFailed`) and offers the install again, without touching the marker (another copy under the same DSH home may really be waiting). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateView, readUpdateView, checkForUpdate, setUpdatePreferences, markUpdateInstalled, releaseFromGithub, updateStatePath } from '../lib/update-check.js';
import { installUpdate } from '../lib/update-install.js';
import { createHostHandler } from '../lib/host.js';
import { githubRelease } from './helpers/wp15-release.mjs';

const T0 = Date.parse('2026-11-10T08:00:00Z');
const INSTALLED_AT = new Date(T0).toISOString();
const release = tag => releaseFromGithub(githubRelease(tag));
const before = T0 - 60_000, after = T0 + 60_000; // when the running process started, relative to the install
const state = (extra = {}) => ({ pending: '4.7.1', installedAt: INSTALLED_AT, release: release('v4.7.1'), ...extra });
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'restart-stuck-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  return dir;
}
const saved = async () => JSON.parse(await readFile(updateStatePath(), 'utf8'));

test('the process started before the install: a restart is still to come (today\'s behaviour)', () => {
  const view = updateView(state(), '4.7.0', '4.7.0', before);
  assert.equal(view.pendingRestart, '4.7.1');
  assert.equal(view.restartFailed, null);
  assert.equal(view.installed, '4.7.1');
  assert.equal(view.upgradeAvailable, false, 'the release that waits for its restart is not offered again');
});

test('the process started after the install and still runs older code: the restart did not take effect', () => {
  const view = updateView(state(), '4.7.0', '4.7.0', after);
  assert.deepEqual(view.restartFailed, { pending: '4.7.1', running: '4.7.0', installedAt: INSTALLED_AT });
  assert.equal(view.pendingRestart, null, 'one meaning per field: "waiting for a restart" is not said while the restart is known to have failed');
  assert.equal(view.current, '4.7.0');
  assert.equal(view.installed, '4.7.0', 'what this copy has: not the marker');
  assert.equal(view.newer, true);
  assert.equal(view.upgradeAvailable, true, 'the one-click install is offered again');
});

test('the on-disk version equal to the running one proves nothing before a restart: pnpm may leave the old package directory in place', () => {
  // Same disk and running version, process older than the install: still "restart needed" (not stuck, not cleared).
  assert.equal(updateView(state(), '4.7.0', '4.7.0', before).pendingRestart, '4.7.1');
  // Process younger than the install, disk equal to running: stuck. A newer package on disk does not clear the failure either.
  assert.equal(updateView(state(), '4.7.0', '4.7.0', after).restartFailed?.pending, '4.7.1');
  const diskNewer = updateView(state(), '4.7.0', '4.7.1', after);
  assert.equal(diskNewer.restartFailed?.pending, '4.7.1');
  assert.equal(diskNewer.installed, '4.7.1', 'this copy: the newer of the running and the on-disk version');
  assert.equal(diskNewer.upgradeAvailable, false, 'nothing newer than this copy to install');
});

test('a marker without a usable installedAt is never called a failed restart', () => {
  for (const installedAt of [undefined, null, '', 'yesterday', 0, {}]) {
    const view = updateView(state({ installedAt }), '4.7.0', '4.7.0', after);
    assert.equal(view.restartFailed, null, String(installedAt));
    assert.equal(view.pendingRestart, '4.7.1', String(installedAt));
  }
  const noStamp = state(); delete noStamp.installedAt;
  assert.equal(updateView(noStamp, '4.7.0', '4.7.0', after).restartFailed, null);
});

test('no marker, or a marker the running code has reached, is not a failed restart', () => {
  assert.equal(updateView({}, '4.7.0', '4.7.0', after).restartFailed, null);
  assert.equal(updateView({ installedAt: INSTALLED_AT }, '4.7.0', '4.7.0', after).restartFailed, null);
  assert.equal(updateView(state(), '4.7.1', '4.7.1', after).restartFailed, null);
  assert.equal(updateView(state(), '4.8.0', '4.8.0', after).restartFailed, null);
  assert.equal(updateView(state({ pending: 'soon' }), '4.7.0', '4.7.0', after).restartFailed, null);
});

test('a marker written by another copy with nothing newer to install is still reported, with nothing to offer', () => {
  for (const cache of [release('v4.7.0'), undefined]) {
    const view = updateView(state({ release: cache }), '4.7.0', '4.7.0', after);
    assert.equal(view.restartFailed?.pending, '4.7.1');
    assert.equal(view.upgradeAvailable, false);
    assert.equal(view.pendingRestart, null);
  }
});

test('stuck with a later release known: that release is the one to install', () => {
  const view = updateView(state({ release: release('v4.8.0') }), '4.7.0', '4.7.0', after);
  assert.equal(view.restartFailed?.pending, '4.7.1');
  assert.equal(view.upgradeAvailable, true);
  assert.equal(view.latest, '4.8.0');
});

test('reading a failed restart leaves the marker on disk; a satisfied marker is still removed (the 3.0.0 fix)', async t => {
  await home(t);
  await markUpdateInstalled('99.0.0', { now: () => T0 });
  const stuck = await readUpdateView({ current: '98.0.0', startedAt: after });
  assert.equal(stuck.restartFailed?.pending, '99.0.0');
  const file = await saved();
  assert.equal(file.pending, '99.0.0', 'another copy under the same DSH home may really be waiting for its restart');
  assert.equal(file.installedAt, INSTALLED_AT);
  for (const read of [() => readUpdateView({ current: '99.0.0', startedAt: after }), () => checkForUpdate({ current: '99.0.0', startedAt: after, fetch: async () => new Response(JSON.stringify(githubRelease('v99.0.0'))), now: () => T0 }),
    () => setUpdatePreferences({ autoCheck: false }, { current: '99.0.0', startedAt: after })]) {
    await markUpdateInstalled('99.0.0', { now: () => T0 });
    const view = await read();
    assert.equal(view.restartFailed, null);
    assert.equal(Object.hasOwn(await saved(), 'pending'), false, 'the running version reached the marker: it is consumed');
  }
});

test('every way the host answers a view carries the same verdict', async t => {
  await home(t);
  await markUpdateInstalled('99.0.0', { now: () => T0 });
  const net = () => new Response(JSON.stringify(githubRelease('v99.0.0')), { status: 200 });
  assert.equal((await checkForUpdate({ force: true, current: '98.0.0', startedAt: after, fetch: async () => net(), now: () => T0 + 1000 })).restartFailed?.pending, '99.0.0');
  assert.equal((await setUpdatePreferences({ autoCheck: true }, { current: '98.0.0', startedAt: after })).restartFailed?.pending, '99.0.0');
  assert.equal((await readUpdateView({ current: '98.0.0', startedAt: before })).restartFailed, null);
});

test('a new install while stuck is "restart needed" again, because it is newer than this process', async t => {
  await home(t);
  await markUpdateInstalled('99.0.0', { now: () => T0 });
  assert.equal((await readUpdateView({ current: '98.0.0', startedAt: after })).restartFailed?.pending, '99.0.0');
  await markUpdateInstalled('99.0.0', { now: () => after + 1000 });
  const again = await readUpdateView({ current: '98.0.0', startedAt: after });
  assert.equal(again.restartFailed, null);
  assert.equal(again.pendingRestart, '99.0.0');
});

test('the one-click install accepts the reinstall of a failed restart, and still refuses a real pending install', async t => {
  await home(t);
  const PACKAGE = Buffer.from('fake studyhub 99.0.0 tarball bytes');
  const sha = createHash('sha256').update(PACKAGE).digest('hex');
  const fetch = async url => String(url).endsWith('.tgz') ? new Response(PACKAGE) : new Response(`${sha}  ericwang1358-dsh-daily-flashcard-99.0.0.tgz\n`);
  const installs = [];
  const manager = { installBundle: async spec => { installs.push(spec); return { application: 'restart-required' }; } };
  const marker = { pending: '99.0.0', installedAt: INSTALLED_AT, release: release('v99.0.0') };
  // Waiting for a restart that has not happened: refused, nothing downloaded.
  await assert.rejects(installUpdate({ view: updateView(marker, '98.0.0', '98.0.0', before), manager, fetch }), error => error.code === 'UPDATE_UNAVAILABLE');
  assert.equal(installs.length, 0);
  // The restart happened and did not take effect: the reinstall goes through and rewrites the marker.
  const stuck = updateView(marker, '98.0.0', '98.0.0', after);
  const result = await installUpdate({ view: stuck, manager, fetch });
  assert.equal(result.status, 'installed');
  assert.equal(installs.length, 1);
  const file = await saved();
  assert.equal(file.pending, '99.0.0');
  assert.notEqual(file.installedAt, INSTALLED_AT, 'the receipt carries the time of the new install');
  assert.ok(Number.isFinite(Date.parse(file.installedAt)));
  // Failed restart with nothing newer than this copy: still refused.
  const nothing = updateView({ ...marker, release: release('v98.0.0') }, '98.0.0', '98.0.0', after);
  await assert.rejects(installUpdate({ view: nothing, manager, fetch }), error => error.code === 'UPDATE_UNAVAILABLE');
  assert.equal(installs.length, 1);
});

test('the host answers update.install for a failed restart and then reports the new install as waiting for a restart', async t => {
  const dir = await home(t);
  const cwd = join(dir, 'workspace');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(dir, 'study'), { recursive: true });
  // A marker written long before this test process started, for a version this copy has not reached.
  await writeFile(updateStatePath(), JSON.stringify({ pending: '99.0.0', installedAt: '2020-01-01T00:00:00.000Z' }));
  const PACKAGE = Buffer.from('fake studyhub 99.0.0 tarball bytes');
  const sha = createHash('sha256').update(PACKAGE).digest('hex');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    url = String(url);
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(githubRelease('v99.0.0')), { status: 200 });
    if (url.endsWith('.tgz')) return new Response(PACKAGE);
    return new Response(`${sha}  ericwang1358-dsh-daily-flashcard-99.0.0.tgz\n`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const installs = [];
  const manager = { installBundle: async spec => { installs.push(spec); return { application: 'restart-required' }; } };
  const ctx = { sessions: { get: () => ({ header: { cwd } }) }, get: name => name === 'pluginManager' ? manager : undefined };
  const handle = createHostHandler(ctx, { libraryRoot: join(dir, 'library') });
  const checked = (await handle('call', { sessionId: 's', action: 'update.check', args: {} })).value;
  assert.equal(checked.restartFailed?.pending, '99.0.0');
  assert.equal(checked.pendingRestart, null);
  assert.equal(checked.upgradeAvailable, true);
  assert.deepEqual(checked.install, { available: true, desktop: false });
  const installed = (await handle('call', { sessionId: 's', action: 'update.install', args: { version: checked.latest } })).value;
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  assert.equal(installs.length, 1);
  const next = (await handle('call', { sessionId: 's', action: 'update.check', args: {} })).value;
  assert.equal(next.restartFailed, null, 'the new receipt is newer than this process: a restart is still to come');
  assert.equal(next.pendingRestart, '99.0.0');
});
