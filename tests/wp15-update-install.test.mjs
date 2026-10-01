/* WP15 · one-click upgrade: download the release package from its exact GitHub
   address, verify it against the published SHA256SUMS, then hand the verified
   file to DSH's plugin manager (ctx.pluginManager.installBundle). Running
   background jobs block the upgrade until the learner confirms. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { installUpdate, prepareVerifiedPackage, updateDownloadDir, pluginInstallSupport } from '../lib/update-install.js';
import { readUpdateView, releaseFromGithub, installedVersion } from '../lib/update-check.js';
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
  const without = createHostHandler({ sessions: ctx.sessions, get: () => undefined }, { libraryRoot: join(dir, 'library') });
  assert.deepEqual((await without('call', { sessionId: 's', action: 'update.check', args: {} })).value.install, { available: false, desktop: false });
  const refused = await without('call', { sessionId: 's', action: 'update.install', args: { version: '99.0.0' } });
  assert.equal(refused.ok, true, 'an expected refusal is an answer, not a transport error');
  assert.deepEqual(refused.value, { status: 'failed', code: 'UPDATE_NO_INSTALLER' });
});
