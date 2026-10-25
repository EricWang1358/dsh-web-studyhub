import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { INDEX_TOOLS, RESET_MARKER, manifestPath, readManifest, writeManifest } from '../lib/retrieval-index.js';
import { STARTUP_GRACE_MS, classifyRetrievalStatus } from '../lib/retrieval-extension.js';
import { resetStamp } from '../lib/contexts/generation/retrieval/repair-index.js';
import { RESET_MARKER as EXTENSION_MARKER, stamp as extensionStamp } from '../packages/studyhub-retrieval/heal.js';
import { nativeSelects } from './helpers/native-selects.mjs';

/* When the search extension is installed but its search service did not start (2026-10-23: a crash had left the index unreadable and the
   server stopped at every start), StudyHub said 「之前选择的检索工具…现在找不到…请确认它在 DSH 里已启用」, which sent the learner the wrong way.
   Now retrieval.status tells (a) an installed extension whose service is down from (b) a chosen provider that is really gone; for (a) the
   settings card says so, with the reason when StudyHub knows it (the index was reset), and offers one repair; after a reset the material rows
   say the index needs building again, and the next build sends every page again. */

const repo = fileURLToPath(new URL('../', import.meta.url));
const COMPANION = `mcp:${INDEX_TOOLS.query}`;

/* ---------- (a) and (b) ---------- */

const base = { selected: COMPANION, effective: 'builtin', missing: COMPANION, providers: [], otherTools: [], companion: { id: COMPANION, running: false } };
const installed = { canInstall: true, installed: true, enabled: true, version: '3.6.2', desktop: true };
const copy = value => JSON.parse(JSON.stringify(value));

test('(a) installed but its service is not running: not "missing", and said to be not started once DSH has been up a while', () => {
  const status = classifyRetrievalStatus(copy(base), installed, { uptimeMs: STARTUP_GRACE_MS + 1 });
  assert.equal(status.missing, undefined, 'the extension is not gone');
  assert.equal(status.companion.notStarted, true);
  assert.equal(status.extension, installed);
  const early = classifyRetrievalStatus(copy(base), installed, { uptimeMs: 1000 });
  assert.equal(early.missing, undefined);
  assert.equal(early.companion.notStarted, undefined, 'just after DSH starts the service may still be coming up');
});

test('(b) a provider that is really gone stays missing; a running extension is never "not started"', () => {
  const gone = classifyRetrievalStatus(copy(base), { canInstall: true, installed: false, enabled: false, desktop: true }, { uptimeMs: 120_000 });
  assert.equal(gone.missing, COMPANION, 'the extension was removed: the generic advice applies');
  assert.equal(gone.companion.notStarted, undefined);
  const other = classifyRetrievalStatus({ ...copy(base), missing: 'mcp:mcp__rag__search' }, installed, { uptimeMs: 120_000 });
  assert.equal(other.missing, 'mcp:mcp__rag__search', 'another chosen tool that is gone is still said to be gone');
  const up = classifyRetrievalStatus({ ...copy(base), missing: undefined, companion: { id: COMPANION, running: true } }, installed, { uptimeMs: 120_000 });
  assert.equal(up.companion.notStarted, undefined);
});

/* ---------- the service: reset marker, repair, the next build ---------- */

function server() {
  const state = { running: true, calls: [] };
  const port = {
    tools: () => (state.running ? Object.values(INDEX_TOOLS).map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })) : []),
    call: async (name, args) => { state.calls.push({ name, args }); return { content: [{ type: 'text', text: '{"ok":true}' }] }; },
  };
  return { state, port };
}

async function setup(t) {
  const dir = join(repo, 'output', 'test-retrieval-repair');
  await mkdir(dir, { recursive: true });
  const home = await mkdtemp(join(dir, 'home-')), root = await mkdtemp(join(dir, 'lib-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const fake = server();
  const service = new StudyService(root, { complete: createFakeModel(), coach: false, retrieval: fake.port });
  t.after(async () => {
    await service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const book = Array.from({ length: 6 }, (_, i) => `<!-- page: ${i + 1} -->\n第 ${i + 1} 页讲进程、线程和内存。`).join('\n\n');
  await service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'os.md', courses: ['操作系统'] });
  const data = join(home, 'study', 'retrieval');
  return { service, fake, root, data, table: join(data, 'lancedb', 'chunks.lance') };
}
const until = async check => { for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 25)); } throw new Error('timed out'); };
async function buildAll(service) {
  await service.call('retrieval.index.start', { course: '操作系统' });
  return until(async () => { const run = await service.call('retrieval.index.status', {}); return run.status === 'complete' ? run : null; });
}
const ingests = fake => fake.state.calls.filter(call => call.name === INDEX_TOOLS.ingest).length;
const exists = path => stat(path).then(() => true, () => false);
/** What the extension writes when it moved a broken table aside before its server started (packages/studyhub-retrieval/heal.js). */
const extensionReset = async data => {
  await new Promise(done => setTimeout(done, 5)); // after the pages already indexed, before any indexed later
  await writeFile(join(data, RESET_MARKER), JSON.stringify({ at: new Date().toISOString(), reason: 'no-text-field', movedTo: join(data, 'lancedb', 'chunks.lance.broken-x') }));
  await new Promise(done => setTimeout(done, 5));
};

test('after the extension reset the index, no page counts as indexed: rows say so, the status says why, and the next build sends every page again', async t => {
  const { service, fake, data } = await setup(t);
  await buildAll(service);
  assert.equal(ingests(fake), 6);
  assert.deepEqual((await service.call('retrieval.index.coverage', {})).indexed.length, 6);
  assert.equal((await service.call('retrieval.status', {})).companion.reset, undefined, 'nothing was reset');

  await extensionReset(data);
  const coverage = await service.call('retrieval.index.coverage', {});
  assert.deepEqual([coverage.indexed.length, coverage.missing.length, coverage.reset.length], [0, 6, 6], 'the rows must not claim the pages are indexed');
  const status = await service.call('retrieval.status', {});
  assert.deepEqual([status.companion.reset.reason, status.companion.reset.pages], ['no-text-field', 6]);
  const plan = await service.call('retrieval.index.plan', { course: '操作系统' });
  assert.deepEqual([plan.toIndex, plan.unchanged], [6, 0], 'regression: the old manifest used to say "up to date" over an empty index');

  await buildAll(service);
  assert.equal(ingests(fake), 12, 'every page was sent again');
  const after = await service.call('retrieval.index.coverage', {});
  assert.deepEqual([after.indexed.length, after.reset], [6, undefined]);
  assert.equal((await service.call('retrieval.status', {})).companion.reset, undefined, 'built again: nothing more to say');
});

test('repair: refused while the service runs; otherwise the index is moved aside (kept), reset.json written, this library\'s record emptied', async t => {
  const { service, fake, root, data, table } = await setup(t);
  await buildAll(service);
  await mkdir(join(table, '_versions'), { recursive: true });
  await writeFile(join(table, '_versions', '18446744073709551614.manifest'), Buffer.alloc(64));
  await assert.rejects(service.call('retrieval.index.repair', {}), error => error.code === 'retrieval-running');
  assert.equal(await exists(table), true);

  fake.state.running = false;
  const result = await service.call('retrieval.index.repair', {});
  assert.equal(await exists(table), false);
  assert.match(result.movedTo, /chunks\.lance\.broken-\d{8}T\d{6}Z$/);
  assert.deepEqual(await readdir(join(result.movedTo, '_versions')), ['18446744073709551614.manifest'], 'moved whole, nothing deleted');
  const marker = JSON.parse(await readFile(join(data, RESET_MARKER), 'utf8'));
  assert.deepEqual(marker, { at: result.at, reason: 'repair', movedTo: result.movedTo });
  const record = JSON.parse(await readFile(manifestPath(root), 'utf8'));
  assert.deepEqual([Object.keys(record.sources).length, record.reset.length], [0, 6]);
  const status = await service.call('retrieval.status', {});
  assert.deepEqual([status.companion.running, status.companion.reset.reason, status.companion.reset.pages], [false, 'repair', 6]);
  assert.equal((await service.call('retrieval.index.coverage', {})).reset.length, 6);

  // A second repair (nothing left to move) still answers, and DSH restarted: the next build sends every page again.
  const again = await service.call('retrieval.index.repair', {});
  assert.equal(again.movedTo, null);
  fake.state.running = true;
  assert.equal((await service.call('retrieval.index.plan', { course: '操作系统' })).toIndex, 6);
  await buildAll(service);
  assert.equal(ingests(fake), 12);
});

test('the manifest carries the pages a reset took until they are indexed again, and is written whole', async t => {
  const { root, data } = await setup(t);
  const at = new Date(Date.now() - 60_000).toISOString();
  await writeManifest(root, { sources: { a: { hash: 'h', at }, b: { hash: 'h', at } } });
  await extensionReset(data);
  const read = await readManifest(root);
  assert.deepEqual([Object.keys(read.sources), read.reset], [[], ['a', 'b']]);
  read.sources.a = { hash: 'h', at: new Date(Date.now() + 5000).toISOString() };
  await writeManifest(root, read);
  const stored = JSON.parse(await readFile(manifestPath(root), 'utf8'));
  assert.deepEqual(stored.reset, ['b'], 'a was indexed again; b still needs it');
  assert.deepEqual((await readManifest(root)).reset, ['b']);
  assert.deepEqual((await readdir(join(data, 'manifests'))).filter(name => name.endsWith('.tmp')), [], 'no half-written file left behind');
});

test('StudyHub and the extension move an index aside the same way and write the same marker', () => {
  const date = new Date('2026-10-23T10:15:30.456Z');
  assert.equal(resetStamp(date), extensionStamp(date));
  assert.equal(RESET_MARKER, EXTENSION_MARKER);
});

/* ---------- the words ---------- */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { default as ExtensionsSettings } from './ui/ExtensionsSettings.jsx';
  export { default as IndexBadge } from './ui/IndexBadge.jsx';
  export { documentIndexState } from './ui/index-coverage.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const ui = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, ui, ui.exports);
const { ExtensionPanel, ExtensionsSettings, IndexBadge, documentIndexState, setUiLanguage } = ui.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const notStarted = { ...base, missing: undefined, companion: { id: COMPANION, running: false, notStarted: true }, extension: installed };
const withReset = reason => ({ ...notStarted, companion: { ...notStarted.companion, reset: { at: '2026-10-23T10:00:00.000Z', reason, pages: 1228 } } });
const settings = (status, language) => render(h(ExtensionsSettings, { initialStatus: status, call: () => {}, courses: ['操作系统'] }), language);

test('(a) in Settings: the service did not start, what to do, one repair; never the advice to enable it in DSH', () => {
  const html = settings(notStarted);
  assert.match(html, /检索扩展装好了，但检索服务没有启动/);
  assert.match(html, /重启 DSH 后再看；还不行就点修复。/);
  assert.equal(html.match(/>修复</g)?.length, 1, 'one repair action');
  assert.doesNotMatch(html, /请确认它在 DSH 里已启用/);
  assert.doesNotMatch(html, /索引坏了/);
  assert.doesNotMatch(html, /title="/, 'hover text is a layered Tooltip, never title=');
});

test('(a) with the marker: the likely reason comes first', () => {
  assert.match(settings(withReset('no-text-field')), /索引坏了，已经重置，需要重新建立索引。[\s\S]*重启 DSH 后再看；还不行就点修复。/);
  assert.match(settings(withReset('repair')), /索引已经重置，需要重新建立索引。/);
});

test('(b) a chosen provider that is really gone keeps the generic advice', () => {
  const gone = { ...base, missing: 'mcp:mcp__rag__search', extension: { canInstall: true, installed: false, enabled: false, desktop: true } };
  assert.match(settings(gone), /请确认它在 DSH 里已启用/);
  assert.doesNotMatch(settings(gone), /检索服务没有启动/);
});

test('installed and still starting (just after DSH started or an install): the old quiet line, no alarm', () => {
  const starting = { ...notStarted, companion: { id: COMPANION, running: false } };
  const html = render(h(ExtensionPanel, { call: () => {}, status: starting }));
  assert.match(html, /检索扩展已安装/);
  assert.doesNotMatch(html, /检索服务没有启动/);
});

test('running after a reset: the panel says the index needs building again', () => {
  const running = { ...withReset('no-text-field'), companion: { ...withReset('no-text-field').companion, running: true, notStarted: undefined } };
  const html = render(h(ExtensionPanel, { call: () => {}, status: running, initialPlan: { pages: 6, toIndex: 6, unchanged: 0, toRemove: 0, canIndex: true } }));
  assert.match(html, /索引坏了，已经重置，需要重新建立索引。/);
});

test('a material row whose pages were in the index before the reset says it needs building again, not that it is indexed or never was', () => {
  const coverage = { indexed: [], stale: [], missing: ['a', 'b', 'c'], reset: ['a', 'b'], hasIndex: false, canIndex: true, building: null };
  const info = documentIndexState({ sourceIds: ['a', 'b'] }, coverage);
  assert.equal(info.state, 'reset');
  assert.equal(documentIndexState({ sourceIds: ['c'] }, coverage, { big: true }).state, 'missing', 'never indexed stays "not indexed yet"');
  const html = render(h(IndexBadge, { info, coverage, onIndex: () => {} }));
  assert.match(html, /需要重新建立索引/);
  assert.match(html, /建立索引/);
});

test('in English: no Chinese in any of these states', () => {
  for (const status of [notStarted, withReset('no-text-field'), withReset('repair')]) assert.doesNotMatch(settings(status, 'en'), han, JSON.stringify(status.companion));
  const coverage = { indexed: [], stale: [], missing: ['a'], reset: ['a'], canIndex: true, building: null };
  const en = render(h(IndexBadge, { info: documentIndexState({ sourceIds: ['a'] }, coverage), coverage, onIndex: () => {} }), 'en');
  assert.match(en, /Index needs rebuilding/);
  assert.doesNotMatch(en, han);
});
