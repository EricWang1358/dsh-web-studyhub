import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_PACKAGE, extensionAssetName, extensionRelease, extensionState, installExtension, uninstallExtension } from '../lib/retrieval-extension.js';
import { createHostHandler } from '../lib/host.js';
import { INDEX_TOOLS } from '../lib/retrieval-index.js';
import { RELEASE_DOWNLOAD_PREFIX } from '../lib/update-check.js';
import { readRetrievalSettings, saveRetrievalSettings } from '../lib/retrieval-settings.js';

/* WP28b: one-click install of the search extension through DSH's plugin manager (the WP15 path):
   a verified release asset, a confirmation for the build scripts pnpm holds back, a restart notice only when needed. */

const VERSION = '2.1.1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('fake tgz bytes');

function fetchOf({ asset = bytes, sums, missing = false } = {}) {
  const requested = [];
  const fetch = async url => {
    requested.push(url);
    if (missing) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = url.endsWith('.tgz') ? asset : Buffer.from(sums ?? `${sha(bytes)}  ${extensionAssetName(VERSION)}\n`);
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  return { fetch, requested };
}
function managerOf(results, bundles = []) {
  const calls = [];
  return { calls, installBundle: async (spec, options) => { calls.push(['install', spec, options]); return typeof results === 'function' ? results(options) : results; },
    removeBundle: async name => { calls.push(['remove', name]); return { changed: true, application: 'applied', stage: 'remove', target: name }; },
    listBundles: async () => bundles };
}
const dir = async t => { const path = await mkdtemp(join(tmpdir(), 'wp28b-ext-')); t.after(() => rm(path, { recursive: true, force: true })); return path; };
const applied = { changed: true, application: 'applied', stage: 'enable', target: EXTENSION_PACKAGE, bundle: EXTENSION_PACKAGE };

test('the asset is the one of this StudyHub version, from the project\'s own release', () => {
  assert.equal(EXTENSION_PACKAGE, '@ericwang1358/studyhub-retrieval');
  assert.equal(extensionAssetName('2.1.1'), 'ericwang1358-studyhub-retrieval-2.1.1.tgz');
  const release = extensionRelease('2.1.1');
  assert.equal(release.assetUrl, `${RELEASE_DOWNLOAD_PREFIX}v2.1.1/ericwang1358-studyhub-retrieval-2.1.1.tgz`);
  assert.equal(release.sha256Url, `${RELEASE_DOWNLOAD_PREFIX}v2.1.1/SHA256SUMS-2.1.1.txt`);
  assert.throws(() => extensionRelease('../../evil'), /version/);
});

test('install: download, verify SHA-256, then hand the verified file to DSH; nothing else is touched', async t => {
  const { fetch, requested } = fetchOf(), manager = managerOf(applied), where = await dir(t);
  const result = await installExtension({ manager, version: VERSION, fetch, dir: where });
  assert.deepEqual(result, { status: 'installed', restartRequired: false, application: 'applied', version: VERSION });
  assert.deepEqual(requested, [extensionRelease(VERSION).sha256Url, extensionRelease(VERSION).assetUrl]);
  const [[, spec, options]] = manager.calls;
  assert.equal(spec, join(where, extensionAssetName(VERSION)));
  assert.deepEqual(options, { enabled: true });
  assert.deepEqual(await readFile(spec), bytes);
});

test('install: a package that does not match its checksum is never installed', async t => {
  const manager = managerOf(applied);
  await assert.rejects(installExtension({ manager, version: VERSION, fetch: fetchOf({ asset: Buffer.from('tampered') }).fetch, dir: await dir(t) }), error => error.code === 'EXTENSION_CHECKSUM');
  await assert.rejects(installExtension({ manager, version: VERSION, fetch: fetchOf({ sums: `${'0'.repeat(64)}  other.tgz\n` }).fetch, dir: await dir(t) }), error => error.code === 'EXTENSION_CHECKSUM');
  assert.equal(manager.calls.length, 0);
});

test('install: an unpublished or unreachable release is explained', async t => {
  await assert.rejects(installExtension({ manager: managerOf(applied), version: VERSION, fetch: fetchOf({ missing: true }).fetch, dir: await dir(t) }),
    error => error.code === 'EXTENSION_DOWNLOAD' && /GitHub/.test(error.message));
  await assert.rejects(installExtension({ manager: managerOf(applied), version: VERSION, fetch: async () => { throw new Error('offline'); }, dir: await dir(t) }),
    error => error.code === 'EXTENSION_DOWNLOAD' && /网络/.test(error.message));
});

test('install: build scripts pnpm holds back need the learner\'s yes; the retry carries exactly the approved names', async t => {
  const { fetch } = fetchOf(), where = await dir(t);
  const manager = managerOf(options => options.approvedBuilds
    ? applied : { changed: false, application: 'failed', stage: 'install', target: 'x', pendingBuilds: ['onnxruntime-node', 'sharp'], packageResult: { kind: 'build-blocked', exitCode: 1, output: '' } });
  const first = await installExtension({ manager, version: VERSION, fetch, dir: where });
  assert.deepEqual(first, { status: 'needs-approval', pending: ['onnxruntime-node', 'sharp'] });
  const second = await installExtension({ manager, version: VERSION, fetch, dir: where, approvedBuilds: first.pending });
  assert.equal(second.status, 'installed');
  assert.deepEqual(manager.calls.at(-1)[2], { enabled: true, approvedBuilds: ['onnxruntime-node', 'sharp'] });
});

test('install: a reinstall says DSH must restart; a failure is explained by its kind', async t => {
  const { fetch } = fetchOf(), where = await dir(t);
  assert.equal((await installExtension({ manager: managerOf({ ...applied, application: 'restart-required' }), version: VERSION, fetch, dir: where })).restartRequired, true);
  const failed = kind => managerOf({ changed: false, application: 'failed', stage: 'install', target: 'x', packageResult: { kind, exitCode: 1, output: '' } });
  await assert.rejects(installExtension({ manager: failed('network'), version: VERSION, fetch, dir: where }), error => error.code === 'EXTENSION_INSTALL' && /网络/.test(error.message));
  await assert.rejects(installExtension({ manager: failed('disk-full'), version: VERSION, fetch, dir: where }), error => /磁盘/.test(error.message));
  await assert.rejects(installExtension({ manager: failed('weird'), version: VERSION, fetch, dir: where }), error => error.code === 'EXTENSION_INSTALL' && /weird/.test(error.message));
  await assert.rejects(installExtension({ manager: managerOf({ changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'incompatible-version' } }), version: VERSION, fetch, dir: where }),
    error => /版本/.test(error.message));
  await assert.rejects(installExtension({ manager: {}, version: VERSION, fetch, dir: where }), error => error.code === 'EXTENSION_NO_INSTALLER');
});

test('state: whether this DSH can install, and whether the extension is installed and switched on', async () => {
  assert.deepEqual(await extensionState({ get: () => undefined }), { canInstall: false, installed: false, enabled: false, desktop: false });
  const manager = managerOf(applied, [{ name: EXTENSION_PACKAGE, version: '2.1.1', enabled: true, installed: true }, { name: 'other', enabled: true, installed: true }]);
  const ctx = { get: name => name === 'pluginManager' ? manager : name === 'profileContext' ? { name: 'desktop' } : undefined };
  assert.deepEqual(await extensionState(ctx), { canInstall: true, installed: true, enabled: true, version: '2.1.1', desktop: true });
  const off = managerOf(applied, [{ name: EXTENSION_PACKAGE, enabled: false, installed: true, error: { code: 'operation-error' } }]);
  const state = await extensionState({ get: name => name === 'pluginManager' ? off : undefined });
  assert.deepEqual([state.installed, state.enabled, state.error], [true, false, 'operation-error']);
  assert.equal((await extensionState({ get: name => name === 'pluginManager' ? { installBundle() {}, listBundles: async () => { throw new Error('x'); } } : undefined })).canInstall, true, 'a listing failure is not a refusal');
});

test('uninstall removes the bundle and forgets it as the chosen provider', async () => {
  const manager = managerOf(applied);
  assert.deepEqual(await uninstallExtension({ manager }), { status: 'removed', application: 'applied' });
  assert.deepEqual(manager.calls, [['remove', EXTENSION_PACKAGE]]);
  await assert.rejects(uninstallExtension({ manager: {} }), error => error.code === 'EXTENSION_NO_INSTALLER');
});

/* ---------- through the host ---------- */

async function host(t, { manager, tools = [] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'wp28b-host-')), root = await mkdtemp(join(tmpdir(), 'wp28b-lib-'));
  const before = process.env.DSH_HOME, realFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  const disposers = [];
  const ctx = { sessions: { get: () => ({ header: { cwd: root } }) }, effect: setup => disposers.push(setup()),
    get: name => name === 'pluginManager' ? manager : name === 'profileContext' ? { name: 'web' } : undefined,
    tools: { schemas: () => tools, execute: async () => ({ isError: false, value: { content: [] }, content: [] }) } };
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose?.();
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const handle = createHostHandler(ctx, { libraryRoot: root }, undefined, { owner: ctx });
  return { call: (action, args = {}) => handle('call', { sessionId: 's', action, args }), home };
}

test('the host answers install, the approval round trip and uninstall; status carries the extension\'s state', async t => {
  const manager = managerOf(options => options.approvedBuilds ? applied : { changed: false, application: 'failed', stage: 'install', target: 'x', pendingBuilds: ['sharp'] });
  const { call } = await host(t, { manager });
  const mock = fetchOf();
  globalThis.fetch = mock.fetch;
  const status = await call('retrieval.status');
  assert.equal(status.ok, true, status.error?.message);
  assert.equal(status.value.extension.canInstall, true);
  assert.equal(status.value.extension.installed, false);
  const first = await call('retrieval.extension.install');
  assert.equal(first.ok, true, first.error?.message);
  assert.deepEqual(first.value, { status: 'needs-approval', pending: ['sharp'] });
  const second = await call('retrieval.extension.install', { approvedBuilds: ['sharp'] });
  assert.equal(second.value.status, 'installed');
  await saveRetrievalSettings({ provider: `mcp:${INDEX_TOOLS.query}`, explicit: true });
  const removed = await call('retrieval.extension.uninstall');
  assert.equal(removed.value.status, 'removed');
  assert.equal((await readRetrievalSettings()).provider, 'builtin', 'the removed extension is no longer the chosen provider');
});

test('a failure comes back as a coded error the page can show; a host without a plugin manager is refused plainly', async t => {
  const { call } = await host(t, { manager: managerOf({ changed: false, application: 'failed', stage: 'install', target: 'x', packageResult: { kind: 'network' } }) });
  globalThis.fetch = fetchOf().fetch;
  const failed = await call('retrieval.extension.install');
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'extension-install');
  assert.match(failed.error.message, /网络/);
  const bare = await host(t, {});
  const refused = await bare.call('retrieval.extension.install');
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'extension-no-installer');
});

test('the status says the extension is running once DSH exposes its tools, and picks it only after an index exists', async t => {
  const tools = Object.values(INDEX_TOOLS).map(name => ({ name, description: name === INDEX_TOOLS.query ? 'Search ingested documents' : name, parameters: { type: 'object', properties: { query: { type: 'string' } } } }));
  const { call } = await host(t, { manager: managerOf(applied, [{ name: EXTENSION_PACKAGE, enabled: true, installed: true, version: VERSION }]), tools });
  const status = (await call('retrieval.status')).value;
  assert.equal(status.extension.installed, true);
  assert.equal(status.companion.running, true);
  assert.equal(status.effective, 'builtin', 'an empty index is not searched');
  assert.deepEqual(await readRetrievalSettings().then(s => s.explicit), undefined);
});
