import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { INDEX_TOOLS, RESET_MARKER } from '../lib/retrieval-index.js';
import { classifyRetrievalStatus, STARTUP_GRACE_MS } from '../lib/retrieval-extension.js';
import { readRetrievalSettings } from '../lib/retrieval-settings.js';
import { MAX_INSTALL_RUNNING_MS, classifyFailure, createToolInstaller, pidAlive } from '../lib/tool-install.js';
import { nativeSelects } from './helpers/native-selects.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const exists = file => stat(file).then(() => true, () => false);
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

async function toySpec(t, { hold = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shared-home-install-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gate = { hold };
  const stage = (id, { mutating = true } = {}) => ({
    id, mutating,
    isDone: async ctx => exists(join(ctx.folder, id, 'done')),
    run: async ctx => {
      await mkdir(join(ctx.folder, id), { recursive: true });
      await writeFile(join(ctx.folder, id, 'part'), 'downloading');
      while (gate.hold && id === 'two') await wait(20, ctx.signal);
      await writeFile(join(ctx.folder, id, 'done'), 'ok');
    },
  });
  const spec = {
    id: 'toy', versionKey: 'markerInstall', label: 'Toy install state',
    stateFile: () => join(dir, 'state', 'toy-install.json'),
    sentinel: '.toy.json', createdBy: 'toy-installer', folderName: 'Toy',
    children: ['one', 'two', 'three'], trackParents: true,
    messages: { needConfirm: 'confirm', needConfirmUninstall: 'confirm', busy: 'busy', uninstallBusy: 'busy', notOurs: 'not ours', interrupted: 'interrupted', cancelled: 'cancelled' },
    explain: (_stage, text) => ({ code: classifyFailure(text) || 'toy-failed', message: 'failed' }),
    unknownFailure: () => ({ code: 'toy-failed', message: 'failed' }),
    plan: async (args, { live }) => ({
      ok: live?.()?.state?.status !== 'running',
      problems: live?.()?.state?.status === 'running' ? [{ code: 'busy', message: 'busy' }] : [],
      folder: args.location,
    }),
    installedProgram: async folder => exists(join(folder, 'three', 'done')),
    view: (state, { status, error, installed }) => ({ status, stage: state.stage, done: state.done || [], error, installed, installedFolder: installed ? state.installedFolder : '', folder: state.folder || '', log: state.log || [] }),
    stages: [stage('one'), stage('two'), stage('three', { mutating: false })],
  };
  return { dir, spec, gate, location: join(dir, 'Apps', 'Toy'), stateFile: spec.stateFile() };
}

test('pidAlive detects a live child process and returns false once it exits or for invalid PIDs', async t => {
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-5), false);
  assert.equal(pidAlive(Number.NaN), false);
  assert.equal(pidAlive(process.pid), true);

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* exited */ } });
  assert.equal(pidAlive(child.pid), true);

  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  // Give the OS process table a brief moment on Windows to reap the handle if needed.
  for (let i = 0; i < 40 && pidAlive(child.pid); i++) await wait(25);
  assert.equal(pidAlive(child.pid), false);
});

test('tool-install cross-process liveness: Instance B sees running + otherProcess while PID is alive and blocks concurrent start/uninstall; dead or stale PID becomes interrupted', async t => {
  const h = await toySpec(t, { hold: true });
  const alivePids = new Set([1001]);
  let clock = Date.parse('2026-11-10T12:00:00.000Z');

  const instanceA = createToolInstaller(h.spec, {
    pid: 1001,
    isPidAlive: pid => alivePids.has(pid),
    now: () => clock,
    live: new Map(),
  });
  const instanceB = createToolInstaller(h.spec, {
    pid: 2002,
    isPidAlive: pid => alivePids.has(pid),
    now: () => clock,
    live: new Map(),
  });

  await instanceA.start({ confirm: true, location: h.location });
  for (let i = 0; i < 200 && !(await exists(join(h.location, 'two', 'part'))); i++) await wait(10);

  const onDisk = JSON.parse(await readFile(h.stateFile, 'utf8'));
  assert.equal(onDisk.version, 1, 'stored-version remains v1');
  assert.equal(onDisk.pid, 1001, 'running state records owning PID');
  assert.equal(typeof onDisk.startedAt, 'string');

  const viewB = await instanceB.status();
  assert.equal(viewB.status, 'running', 'Instance B does not falsely report interrupted while Instance A is alive');
  assert.equal(viewB.otherProcess, true, 'Instance B flags that another process owns the run');
  assert.equal(viewB.error, null);

  const plannedB = await instanceB.plan({ location: h.location });
  assert.equal(plannedB.ok, false, 'plan() in Instance B sees the active cross-process run');
  assert.equal(plannedB.problems[0]?.code, 'busy');

  await assert.rejects(instanceB.start({ confirm: true, location: h.location }), error => error.code === 'busy');
  await assert.rejects(instanceB.uninstall({ confirm: true }), error => error.code === 'busy');

  // If the timestamp is older than MAX_INSTALL_RUNNING_MS (e.g. PID wraparound days later), treat as interrupted.
  clock += MAX_INSTALL_RUNNING_MS + 1000;
  const staleView = await instanceB.status();
  assert.equal(staleView.status, 'interrupted');
  assert.equal(staleView.otherProcess, undefined);
  clock -= MAX_INSTALL_RUNNING_MS + 1000;

  // Finish Instance A cleanly: pid is cleared from the completed state file.
  h.gate.hold = false;
  await instanceA.idle();
  const completedDisk = JSON.parse(await readFile(h.stateFile, 'utf8'));
  assert.equal(completedDisk.status, 'complete');
  assert.equal(completedDisk.pid, undefined);

  // Simulate Instance A crashing mid-install (dead PID on disk): Instance B converts to interrupted and can resume.
  await writeFile(h.stateFile, JSON.stringify({ version: 1, status: 'running', stage: 'two', pid: 9999, startedAt: new Date(clock).toISOString(), folder: h.location }));
  const crashedView = await instanceB.status();
  assert.equal(crashedView.status, 'interrupted');
  assert.equal(crashedView.error?.code, 'interrupted');
  assert.equal(crashedView.otherProcess, undefined);
});

/* ---------- Shared retrieval/reset.json across libraries ---------- */

function fakeRetrievalServer(extraTools = []) {
  const state = { running: true, extra: true };
  const port = {
    tools: () => [
      ...(state.running ? Object.values(INDEX_TOOLS).map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })) : []),
      ...(state.extra ? extraTools : []),
    ],
    call: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  };
  return { state, port };
}

const until = async check => {
  for (let i = 0; i < 400; i++) {
    const value = await check();
    if (value) return value;
    await wait(25);
  }
  throw new Error('timed out');
};

test('shared retrieval/reset.json does not raise a false reset alarm on a brand-new or unindexed library, while still reporting for the library that lost pages or ran repair', async t => {
  const baseDir = join(repo, 'output', 'test-shared-home-state');
  await mkdir(baseDir, { recursive: true });
  const home = await mkdtemp(join(baseDir, 'home-'));
  const rootA = await mkdtemp(join(baseDir, 'libA-'));
  const rootB = await mkdtemp(join(baseDir, 'libB-'));
  const rootC = await mkdtemp(join(baseDir, 'libC-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const serverA = fakeRetrievalServer(), serverB = fakeRetrievalServer(), serverC = fakeRetrievalServer();
  const serviceA = new StudyService(rootA, { complete: createFakeModel(), coach: false, retrieval: serverA.port });
  const serviceB = new StudyService(rootB, { complete: createFakeModel(), coach: false, retrieval: serverB.port });
  const serviceC = new StudyService(rootC, { complete: createFakeModel(), coach: false, retrieval: serverC.port });

  t.after(async () => {
    await serviceA.dispose();
    await serviceB.dispose();
    await serviceC.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    for (const dir of [rootA, rootB, rootC, home]) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const book = Array.from({ length: 4 }, (_, i) => `<!-- page: ${i + 1} -->\n第 ${i + 1} 页操作系统内容。`).join('\n\n');
  await serviceA.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'os.md', courses: ['操作系统'] });
  await serviceC.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'db.md', courses: ['数据库'] });

  await serviceA.call('retrieval.index.start', { course: '操作系统' });
  await until(async () => (await serviceA.call('retrieval.index.status', {})).status === 'complete');

  // Extension self-heals a broken table -> writes global reset.json.
  await wait(10);
  await writeFile(join(home, 'study', 'retrieval', RESET_MARKER), JSON.stringify({
    at: new Date().toISOString(),
    reason: 'no-text-field',
    movedTo: join(home, 'study', 'retrieval', 'lancedb', 'chunks.lance.broken-1'),
  }));

  const statusA = await serviceA.call('retrieval.status', {});
  assert.deepEqual([statusA.companion.reset?.reason, statusA.companion.reset?.pages], ['no-text-field', 4], 'Library A lost 4 indexed pages and must report it');

  const statusB = await serviceB.call('retrieval.status', {});
  assert.equal(statusB.companion.reset, undefined, 'Brand-new empty Library B never indexed anything and must not inherit reset.json');

  const statusC = await serviceC.call('retrieval.status', {});
  assert.equal(statusC.companion.reset, undefined, 'Unindexed Library C never indexed anything and must not inherit reset.json');

  // Explicitly clicking repair in empty Library B records reset for Library B, without polluting unindexed Library C.
  serverB.state.running = false;
  await wait(10);
  await serviceB.call('retrieval.index.repair', {});
  const repairedB = await serviceB.call('retrieval.status', {});
  assert.equal(repairedB.companion.reset?.reason, 'repair', 'Library B ran repair itself and reports its repair marker');

  const statusCAfter = await serviceC.call('retrieval.status', {});
  assert.equal(statusCAfter.companion.reset, undefined, 'Library C still has no false reset alarm');
});

/* ---------- Shared retrieval.json custom mcp:<server> across profiles/libraries ---------- */

test('shared retrieval.json custom mcp:<tool> warns when missing in the library that chose it, and silently falls back to builtin in another profile/library that never had it', async t => {
  const baseDir = join(repo, 'output', 'test-shared-home-state');
  await mkdir(baseDir, { recursive: true });
  const home = await mkdtemp(join(baseDir, 'home-mcp-'));
  const rootA = await mkdtemp(join(baseDir, 'profA-'));
  const rootB = await mkdtemp(join(baseDir, 'profB-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const ragTool = { name: 'mcp__rag__query_documents', description: 'Search docs', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
  const serverA = fakeRetrievalServer([ragTool]);
  const serverB = fakeRetrievalServer([]);
  serverA.state.running = false;
  serverB.state.running = false;

  const serviceA = new StudyService(rootA, { complete: createFakeModel(), coach: false, retrieval: serverA.port });
  const serviceB = new StudyService(rootB, { complete: createFakeModel(), coach: false, retrieval: serverB.port });

  t.after(async () => {
    await serviceA.dispose();
    await serviceB.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    for (const dir of [rootA, rootB, home]) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const chosenA = await serviceA.call('retrieval.set', { provider: 'mcp:mcp__rag__query_documents' });
  assert.equal(chosenA.effective, 'mcp:mcp__rag__query_documents');
  assert.equal(chosenA.missing, undefined);

  // Profile B shares DSH_HOME, never configured mcp__rag__query_documents: falls back cleanly without missing warning or clobbering Profile A's file.
  const statusB = await serviceB.call('retrieval.status', {});
  assert.equal(statusB.effective, 'builtin');
  assert.equal(statusB.missing, undefined, 'Profile B must not warn about a custom MCP tool it never had');
  assert.equal((await readRetrievalSettings()).provider, 'mcp:mcp__rag__query_documents', 'Profile A choice stays intact on disk');

  // When mcp__rag__query_documents disappears in Profile A itself, Profile A DOES report missing.
  serverA.state.extra = false;
  const brokenA = await serviceA.call('retrieval.status', {});
  assert.equal(brokenA.effective, 'builtin');
  assert.equal(brokenA.missing, 'mcp:mcp__rag__query_documents');
});

/* ---------- UI cards for cross-process running installs ---------- */

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as MineruInstallCard } from './ui/MineruInstallCard.jsx';
      export { default as MarkerInstall } from './ui/MarkerInstall.jsx';
      export { default as LiveLocalCard } from './ui/LiveLocalCard.jsx';
      export { default as LiveLoopbackCard } from './ui/LiveLoopbackCard.jsx';
      export { default as ExtensionsSettings } from './ui/ExtensionsSettings.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react-dom'], plugins: [nativeSelects],
  loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent',
});
const uiMod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, uiMod, uiMod.exports);
const { MineruInstallCard, MarkerInstall, LiveLocalCard, LiveLoopbackCard, ExtensionsSettings, setUiLanguage } = uiMod.exports;
const h = React.createElement;
const han = /[\u3400-\u9fff]/;
const render = (el, lang = 'zh') => { setUiLanguage(lang); try { return renderToStaticMarkup(el); } finally { setUiLanguage('zh'); } };

test('all four tool-install cards render cross-process running state without false interrupted error or local pause/cancel button, in zh and en', () => {
  const mineruLocal = {
    state: 'installing',
    install: { status: 'running', otherProcess: true, stage: 'models', done: ['tools', 'python', 'package'], tier: 'basic', folder: 'D:\\StudyHub\\MinerU', log: [], error: null },
  };
  const markerInstall = {
    status: 'running', otherProcess: true, stage: 'install-marker', stages: ['create-venv', 'install-marker', 'verify-marker', 'save-command'],
    done: ['create-venv'], folder: 'D:\\StudyHub\\Marker', log: [], error: null,
  };
  const liveLocalStatus = {
    status: 'running', otherProcess: true, stage: 'model', done: ['engine'], supported: true, ready: false,
    modelId: 'sense-voice', selectedModelId: 'sense-voice', folder: 'D:\\StudyHub\\LiveLocal', downloadMb: 240, diskMb: 260, modelMb: 228, log: [], error: null,
  };
  const liveLoopbackStatus = {
    status: 'running', otherProcess: true, stage: 'compile', done: [], supported: true, ready: false,
    folder: 'D:\\StudyHub\\LiveLoopback', downloadMb: 0, diskMb: 1, log: [], error: null,
  };

  const mineruZh = render(h(MineruInstallCard, { initialLocal: mineruLocal }));
  assert.match(mineruZh, /另一个 StudyHub 窗口正在安装/);
  assert.doesNotMatch(mineruZh, /被中断|>继续安装<|>暂停</);

  const markerZh = render(h(MarkerInstall, { initialInstall: markerInstall }));
  assert.match(markerZh, /另一个 StudyHub 窗口正在安装/);
  assert.doesNotMatch(markerZh, /安装被中断|>取消</);

  const liveZh = render(h(LiveLocalCard, { initialStatus: liveLocalStatus }));
  assert.match(liveZh, /另一个 StudyHub 窗口正在安装/);
  assert.doesNotMatch(liveZh, /被中断|>继续安装<|>暂停</);

  const loopZh = render(h(LiveLoopbackCard, { initialStatus: liveLoopbackStatus }));
  assert.match(loopZh, /另一个 StudyHub 窗口正在安装/);
  assert.doesNotMatch(loopZh, /被中断|>取消</);

  for (const el of [
    h(MineruInstallCard, { initialLocal: mineruLocal }),
    h(MarkerInstall, { initialInstall: markerInstall }),
    h(LiveLocalCard, { initialStatus: liveLocalStatus }),
    h(LiveLoopbackCard, { initialStatus: liveLoopbackStatus }),
  ]) {
    const en = render(el, 'en');
    assert.match(en, /Another StudyHub window is installing/);
    assert.doesNotMatch(en, han);
  }

  // Also check ExtensionNotStarted via ExtensionsSettings on a brand-new empty library status (no reset):
  const emptyStatus = classifyRetrievalStatus(
    { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [], companion: { id: `mcp:${INDEX_TOOLS.query}`, running: false } },
    { canInstall: true, installed: true, enabled: true, version: '4.6.2', desktop: true },
    { uptimeMs: STARTUP_GRACE_MS + 1000 },
  );
  const settingsHtml = render(h(ExtensionsSettings, { initialStatus: emptyStatus, call: () => {}, courses: [] }));
  assert.doesNotMatch(settingsHtml, /索引坏了，已经重置/);
});
