/* WP15 · one-click upgrade: download the release package from its exact GitHub
   address, verify it against the published SHA256SUMS, then hand the verified
   file to DSH's plugin manager (ctx.pluginManager.installBundle). Running
   background jobs block the upgrade until the learner confirms. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { installUpdate, prepareVerifiedPackage, updateDownloadDir, pluginInstallSupport } from '../lib/update-install.js';
import { readUpdateView, releaseFromGithub, installedVersion, updateView, updateStatePath, checkForUpdate, setUpdatePreferences } from '../lib/update-check.js';
import { createHostHandler } from '../lib/host.js';
import { githubRelease } from './helpers/wp15-release.mjs';

const PACKAGE = Buffer.from('fake studyhub 99.0.0 tarball bytes');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const view = (extra = {}) => ({ current: '2.1.0', ...releaseFromGithub(githubRelease('v99.0.0')), newer: true, ...extra });
function releaseHost({ sums, bytes = PACKAGE } = {}) {
  const calls = [];
  const fetch = async url => {
    url = String(url); calls.push(url);
    if (url.endsWith('.tgz')) return new Response(bytes, { status: 200 });
    if (url.includes('SHA256SUMS')) return new Response(sums ?? `${sha(PACKAGE)}  ericwang1358-dsh-daily-flashcard-99.0.0.tgz\n${'0'.repeat(64)}  studyhub-setup-99.0.0.md\n`);
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}
function pluginManager(result = { application: 'restart-required', changed: true, stage: 'enable', target: '@ericwang1358/dsh-daily-flashcard', bundle: '@ericwang1358/dsh-daily-flashcard' }) {
  const installs = [];
  return { installs, installBundle: async (spec, options) => { installs.push({ spec, options, bytes: await readFile(spec) }); return typeof result === 'function' ? result(spec) : result; } };
}
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wp15-install-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('the package is downloaded from its exact release address and must match SHA256SUMS', async t => {
  const dir = await home(t);
  const net = releaseHost();
  const verified = await prepareVerifiedPackage({ view: view(), fetch: net.fetch });
  assert.deepEqual(net.calls, [view().sha256Url, view().assetUrl]);
  assert.equal(verified.sha256, sha(PACKAGE));
  assert.equal(verified.path, join(dir, 'study', 'updates', 'ericwang1358-dsh-daily-flashcard-99.0.0.tgz'));
  assert.equal(updateDownloadDir(), join(dir, 'study', 'updates'));
  assert.deepEqual(await readFile(verified.path), PACKAGE);
  const tampered = releaseHost({ bytes: Buffer.from('something else') });
  await assert.rejects(prepareVerifiedPackage({ view: view(), fetch: tampered.fetch }), error => error.code === 'UPDATE_CHECKSUM' && /校验/.test(error.message));
  const unlisted = releaseHost({ sums: `${'1'.repeat(64)}  other.tgz\n` });
  await assert.rejects(prepareVerifiedPackage({ view: view(), fetch: unlisted.fetch }), error => error.code === 'UPDATE_CHECKSUM');
  assert.deepEqual((await readdir(join(dir, 'study', 'updates'))).filter(name => name.endsWith('.tgz')), ['ericwang1358-dsh-daily-flashcard-99.0.0.tgz'], 'a rejected download leaves nothing behind');
});

test('a text-only HTTP helper (no arrayBuffer) is refused as a download failure instead of corrupting the package', async t => {
  await home(t);
  const textOnly = async () => ({ ok: true, status: 200, text: async () => 'x', json: async () => ({}) });
  await assert.rejects(prepareVerifiedPackage({ view: view(), fetch: textOnly }), error => error.code === 'UPDATE_DOWNLOAD');
});

test('an already installed release is refused before downloads or job cancellation, but a later release can replace it', async t => {
  await home(t);
  const manager = pluginManager(), net = releaseHost();
  let cancellations = 0;
  const installed = updateView({ pending: '99.0.0', release: releaseFromGithub(githubRelease('v99.0.0')) }, '98.0.0', '98.0.0');
  await assert.rejects(installUpdate({ view: installed, manager, fetch: net.fetch, activeJobs: 1, confirmJobs: true,
    cancelJobs: async () => { cancellations++; } }), error => error.code === 'UPDATE_UNAVAILABLE');
  assert.equal(cancellations, 0);
  assert.equal(net.calls.length, 0);
  assert.equal(manager.installs.length, 0);
  const later = updateView({ pending: '98.0.1', release: releaseFromGithub(githubRelease('v99.0.0')) }, '98.0.0', '98.0.0');
  const result = await installUpdate({ view: later, manager, fetch: net.fetch });
  assert.equal(result.version, '99.0.0');
  assert.equal(manager.installs.length, 1);
  assert.equal((await readUpdateView({ current: '98.0.0' })).pendingRestart, '99.0.0');
});

test('addresses outside this repository\'s release downloads are refused before any request', async t => {
  await home(t);
  const net = releaseHost();
  for (const bad of [{ assetUrl: 'https://evil.example/ericwang1358-dsh-daily-flashcard-99.0.0.tgz' }, { assetUrl: null }, { sha256Url: null },
    { assetName: '../escape.tgz' }, { newer: false }]) {
    await assert.rejects(prepareVerifiedPackage({ view: view(bad), fetch: net.fetch }), error => error.code === 'UPDATE_UNAVAILABLE', JSON.stringify(bad));
  }
  assert.equal(net.calls.length, 0);
});

test('installUpdate hands the verified file to the plugin manager and remembers the pending restart', async t => {
  await home(t);
  const net = releaseHost(), manager = pluginManager();
  const result = await installUpdate({ view: view(), manager, fetch: net.fetch, activeJobs: 0 });
  assert.equal(manager.installs.length, 1);
  assert.equal(basename(manager.installs[0].spec), 'ericwang1358-dsh-daily-flashcard-99.0.0.tgz');
  assert.deepEqual(manager.installs[0].bytes, PACKAGE, 'exactly the verified bytes are installed');
  assert.equal(manager.installs[0].options.enabled, true);
  assert.equal(net.calls.at(-1), 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v99.0.0/ericwang1358-dsh-daily-flashcard-99.0.0.tgz');
  assert.deepEqual({ status: result.status, version: result.version, restartRequired: result.restartRequired }, { status: 'installed', version: '99.0.0', restartRequired: true });
  assert.equal((await readUpdateView({ current: installedVersion() })).pendingRestart, '99.0.0');
  assert.equal((await readUpdateView({ current: '99.0.0' })).pendingRestart, null, 'cleared once the new version runs');
});

test('running background jobs stop the upgrade until the learner confirms; confirming cancels them first', async t => {
  await home(t);
  const net = releaseHost(), manager = pluginManager();
  const blocked = await installUpdate({ view: view(), manager, fetch: net.fetch, activeJobs: 2 });
  assert.deepEqual(blocked, { status: 'jobs-running', jobs: 2 });
  assert.equal(manager.installs.length, 0);
  assert.equal(net.calls.length, 0, 'nothing is downloaded either');
  const order = [];
  const confirmed = await installUpdate({ view: view(), manager: { installBundle: async spec => { order.push('install'); return pluginManager().installBundle(spec); } },
    fetch: net.fetch, activeJobs: 2, confirmJobs: true, cancelJobs: async () => { order.push('cancel'); } });
  assert.equal(confirmed.status, 'installed');
  assert.deepEqual(order, ['cancel', 'install']);
});

test('a failed DSH install is reported in plain language with the guided route as the fix', async t => {
  await home(t);
  const manager = pluginManager({ application: 'failed', changed: false, stage: 'install', target: 'x', error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_404' }, packageResult: { kind: 'network', exitCode: 1, output: '…' } });
  await assert.rejects(installUpdate({ view: view(), manager, fetch: releaseHost().fetch, activeJobs: 0 }),
    error => error.code === 'UPDATE_INSTALL' && error.kind === 'network' && /手动升级/.test(error.message));
  assert.equal((await readUpdateView({ current: installedVersion() })).pendingRestart, null);
});

test('pluginInstallSupport reads only DSH\'s plugin manager service and the desktop profile', () => {
  assert.deepEqual(pluginInstallSupport({ get: () => undefined }), { available: false, desktop: false });
  const manager = { installBundle() {} };
  assert.deepEqual(pluginInstallSupport({ get: name => name === 'pluginManager' ? manager : name === 'profileContext' ? { name: 'desktop' } : undefined }), { available: true, desktop: true });
  assert.deepEqual(pluginInstallSupport({ get: name => name === 'pluginManager' ? manager : name === 'profileContext' ? { name: 'web' } : undefined }), { available: true, desktop: false });
  assert.deepEqual(pluginInstallSupport({}), { available: false, desktop: false });
});

test('the host handler adds install support to update.check and installs through ctx.pluginManager', async t => {
  const dir = await home(t);
  const cwd = join(dir, 'workspace');
  await mkdir(cwd, { recursive: true });
  const net = releaseHost();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).startsWith('https://api.github.com/')
    ? new Response(JSON.stringify(githubRelease('v99.0.0')), { status: 200 }) : net.fetch(url, init);
  t.after(() => { globalThis.fetch = realFetch; });
  const manager = pluginManager();
  const ctx = { sessions: { get: () => ({ header: { cwd } }) }, get: name => name === 'pluginManager' ? manager : undefined };
  const handle = createHostHandler(ctx, { libraryRoot: join(dir, 'library') });
  const checked = await handle('call', { sessionId: 's', action: 'update.check', args: {} });
  assert.equal(checked.ok, true, checked.error?.message);
  assert.deepEqual(checked.value.install, { available: true, desktop: false });
  const stale = await handle('call', { sessionId: 's', action: 'update.install', args: { version: '99.0.1' } });
  assert.deepEqual(stale.value, { status: 'failed', code: 'UPDATE_STALE' }, 'the version the learner saw must still be the latest');
  assert.equal(manager.installs.length, 0);
  const installed = await handle('call', { sessionId: 's', action: 'update.install', args: { version: checked.value.latest } });
  assert.equal(installed.ok, true, installed.error?.message);
  assert.equal(installed.value.status, 'installed');
  assert.equal(manager.installs.length, 1);
  assert.ok(net.calls.includes(checked.value.assetUrl));
  const fetched = net.calls.length;
  const repeated = await handle('call', { sessionId: 's', action: 'update.install', args: { version: checked.value.latest } });
  assert.deepEqual(repeated.value, { status: 'failed', code: 'UPDATE_UNAVAILABLE' });
  assert.equal(manager.installs.length, 1, 'the host refuses an already installed release');
  assert.equal(net.calls.length, fetched, 'the refusal does not download any prerequisite package');
  const without = createHostHandler({ sessions: ctx.sessions, get: () => undefined }, { libraryRoot: join(dir, 'library') });
  assert.deepEqual((await without('call', { sessionId: 's', action: 'update.check', args: {} })).value.install, { available: false, desktop: false });
  const refused = await without('call', { sessionId: 's', action: 'update.install', args: { version: '99.0.0' } });
  assert.equal(refused.ok, true, 'an expected refusal is an answer, not a transport error');
  assert.deepEqual(refused.value, { status: 'failed', code: 'UPDATE_NO_INSTALLER' });
});

test('a finished upgrade removes only the older StudyHub packages, never the search extension\'s installer DSH still points at', async t => {
  const dir = await home(t), updates = join(dir, 'study', 'updates');
  await mkdir(updates, { recursive: true });
  const extension = 'ericwang1358-studyhub-retrieval-2.1.2.tgz', unrelated = 'notes.txt';
  for (const name of ['ericwang1358-dsh-daily-flashcard-98.0.0.tgz', extension, unrelated, 'ericwang1358-dsh-daily-flashcard-97.0.0.tgz.1234.part'])
    await writeFile(join(updates, name), name);
  const net = releaseHost(), manager = pluginManager();
  await installUpdate({ view: view(), manager, fetch: net.fetch, activeJobs: 0 });
  assert.deepEqual((await readdir(updates)).sort(), [extension, 'ericwang1358-dsh-daily-flashcard-99.0.0.tgz', unrelated].sort(),
    'the old StudyHub package and its leftover download are gone; the extension installer and other files stay');
});

for (const entry of ['read', 'cached-check', 'disabled-check', 'preferences']) {
  test(`a confirmed restart consumes the install marker before CLI rollback (${entry})`, async t => {
    await home(t);
    await installUpdate({ view: view(), manager: pluginManager(), fetch: releaseHost().fetch });
    const before = JSON.parse(await readFile(updateStatePath(), 'utf8'));
    Object.assign(before, { release: releaseFromGithub(githubRelease('v99.0.0')), autoCheck: entry !== 'disabled-check', nextCheckAt: Date.now() + 3600000, snoozed: '98.0.0' });
    await writeFile(updateStatePath(), JSON.stringify(before));
    const options = { current: '99.0.0', fetch: () => { throw new Error('cached or disabled checks must not fetch'); } };
    if (entry === 'read') await readUpdateView(options);
    else if (entry === 'preferences') await setUpdatePreferences({ autoCheck: false }, options);
    else await checkForUpdate(options);
    const saved = JSON.parse(await readFile(updateStatePath(), 'utf8'));
    const rolledBack = updateView(saved, '98.0.0', '98.0.0');
    assert.equal(rolledBack.upgradeAvailable, true, 'the old release must offer UI re-upgrade after CLI rollback');
    assert.equal(rolledBack.pendingRestart, null, 'a completed restart cannot become pending again');
    assert.equal(Object.hasOwn(saved, 'pending'), false, 'consume the persisted marker, not only its view');
    assert.equal(saved.installedAt, before.installedAt);
    assert.equal(saved.snoozed, before.snoozed);
    assert.deepEqual(saved.release, before.release);
  });
}

test('unconfirmed install markers survive reads and newer installs survive concurrent confirmation', async t => {
  await home(t);
  const { markUpdateInstalled } = await import('../lib/update-check.js');
  await markUpdateInstalled('99.0.0');
  for (const current of ['98.0.0', '99.0.0-rc.1', 'unknown']) {
    await readUpdateView({ current });
    assert.equal(JSON.parse(await readFile(updateStatePath(), 'utf8')).pending, '99.0.0');
  }
  await Promise.all([readUpdateView({ current: '99.0.0' }), markUpdateInstalled('100.0.0'), setUpdatePreferences({ autoCheck: false }, { current: '99.0.0' })]);
  const saved = JSON.parse(await readFile(updateStatePath(), 'utf8'));
  assert.equal(saved.pending, '100.0.0', 'confirmation must not overwrite a newer install receipt');
  assert.equal(saved.autoCheck, false);
});


test('a delayed release response preserves a newer install receipt and does not hold its lock', { timeout: 10000 }, async t => {
  await home(t);
  const { markUpdateInstalled } = await import('../lib/update-check.js');
  await markUpdateInstalled('99.0.0');
  let entered, respond;
  const fetching = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { respond = resolve; });
  const releaseResponse = () => respond(new Response(JSON.stringify(githubRelease('v101.0.0'))));
  t.after(releaseResponse);
  const checked = checkForUpdate({ force: true, current: '99.0.0', fetch: () => { entered(); return response; } });
  await fetching;
  try {
    await markUpdateInstalled('100.0.0');
    await setUpdatePreferences({ autoCheck: false }, { current: '99.0.0' });
  } finally { releaseResponse(); }
  assert.equal((await checked).pendingRestart, '100.0.0');
  const saved = JSON.parse(await readFile(updateStatePath(), 'utf8'));
  assert.equal(saved.pending, '100.0.0');
  assert.equal(saved.autoCheck, false);
  assert.equal(saved.release.latest, '101.0.0');
  await readUpdateView({ current: '101.0.0' });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(updateStatePath(), 'utf8')), 'pending'), false, 'a running version beyond the installed marker also confirms the restart');
});

test('transient CDN resets and 5xx answers retry automatically and resume partial downloads via HTTP Range', async t => {
  await home(t);
  const full = Buffer.from('0123456789abcdef'.repeat(64));
  const sums = `${sha(full)}  ericwang1358-dsh-daily-flashcard-99.0.0.tgz\n`;
  const seenRanges = [];
  let sumCalls = 0, pkgCalls = 0;
  const fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (String(url).includes('SHA256SUMS')) {
      if (++sumCalls === 1) return new Response('gateway timeout', { status: 504 });
      return new Response(sums, { status: 200 });
    }
    seenRanges.push(headers.get('range'));
    pkgCalls++;
    if (pkgCalls === 1) {
      let step = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (step++ === 0) controller.enqueue(full.subarray(0, 300));
          else controller.error(Object.assign(new TypeError('terminated'), { code: 'ECONNRESET' }));
        },
      });
      return new Response(body, { status: 200, headers: { etag: '"v99"' } });
    }
    if (pkgCalls === 2) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    assert.equal(headers.get('range'), 'bytes=300-');
    assert.equal(headers.get('if-range'), '"v99"');
    return new Response(full.subarray(300), {
      status: 206,
      headers: { 'content-range': `bytes 300-${full.length - 1}/${full.length}` },
    });
  };
  const verified = await prepareVerifiedPackage({ view: view(), fetch, sleep: async () => {} });
  assert.equal(verified.sha256, sha(full));
  assert.deepEqual(await readFile(verified.path), full);
  assert.equal(sumCalls, 2);
  assert.deepEqual(seenRanges, [null, 'bytes=300-', 'bytes=300-']);
});

test('an exhausted interrupted download keeps partial bytes on disk so clicking Retry upgrade resumes from where it stopped', async t => {
  const dir = await home(t);
  const full = Buffer.from('resumable-studyhub-tarball-payload-'.repeat(40));
  const sums = `${sha(full)}  ericwang1358-dsh-daily-flashcard-99.0.0.tgz\n`;
  let phase = 'drop';
  const ranges = [];
  const fetch = async (url, init = {}) => {
    if (String(url).includes('SHA256SUMS')) return new Response(sums, { status: 200 });
    const range = new Headers(init.headers).get('range');
    ranges.push(range);
    if (phase === 'drop') {
      let sent = false;
      const body = new ReadableStream({
        pull(controller) {
          if (!sent && !range) { sent = true; controller.enqueue(full.subarray(0, 500)); }
          else controller.error(new TypeError('terminated'));
        },
      });
      return new Response(body, { status: range ? 206 : 200, headers: range ? { 'content-range': `bytes 500-${full.length - 1}/${full.length}` } : {} });
    }
    assert.equal(range, 'bytes=500-', 'second click resumes from saved .part bytes');
    return new Response(full.subarray(500), { status: 206, headers: { 'content-range': `bytes 500-${full.length - 1}/${full.length}` } });
  };
  await assert.rejects(
    prepareVerifiedPackage({ view: view(), fetch, attempts: 2, sleep: async () => {} }),
    error => error.code === 'UPDATE_DOWNLOAD' && error.detail === 'network' && error.savedBytes === 500,
  );
  phase = 'finish';
  const verified = await prepareVerifiedPackage({ view: view(), fetch, attempts: 2, sleep: async () => {} });
  assert.equal(verified.sha256, sha(full));
  assert.deepEqual(await readFile(verified.path), full);
  const files = await readdir(join(dir, 'study', 'updates'));
  assert.deepEqual(files, ['ericwang1358-dsh-daily-flashcard-99.0.0.tgz'], 'the temporary .part file is cleaned up after verification');
});

test('a corrupted partial file on disk is discarded and re-downloaded cleanly from byte 0', async t => {
  const dir = await home(t), updates = join(dir, 'study', 'updates');
  await mkdir(updates, { recursive: true });
  const full = Buffer.from('clean-verified-release-archive-bytes');
  const digest = sha(full);
  await writeFile(join(updates, `ericwang1358-dsh-daily-flashcard-99.0.0.tgz.${digest.slice(0, 12)}.part`), Buffer.from('corrupt!'));
  const ranges = [];
  const fetch = async (url, init = {}) => {
    if (String(url).includes('SHA256SUMS')) return new Response(`${digest}  ericwang1358-dsh-daily-flashcard-99.0.0.tgz\n`, { status: 200 });
    const range = new Headers(init.headers).get('range');
    ranges.push(range);
    if (range === 'bytes=8-') {
      return new Response(full.subarray(8), { status: 206, headers: { 'content-range': `bytes 8-${full.length - 1}/${full.length}` } });
    }
    return new Response(full, { status: 200 });
  };
  const verified = await prepareVerifiedPackage({ view: view(), fetch, sleep: async () => {} });
  assert.deepEqual(ranges, ['bytes=8-', null], 'retries once from byte 0 when resumed bytes fail SHA-256');
  assert.equal(verified.sha256, digest);
});
