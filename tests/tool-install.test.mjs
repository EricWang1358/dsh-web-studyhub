import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstallError, classifyFailure, createToolInstaller, liveRun, readState, writeState } from '../lib/tool-install.js';

/* The install engine shared by Marker and MinerU, with a toy tool whose stages only write files: the order, the done-checks, cancel and resume, the
   restart, the format version, the one slot per state file, the uninstall rules and the task-console row. */

const exists = file => stat(file).then(() => true, () => false);
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

async function toy(t, { hold = false, holdOne = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tool-install-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const ran = [], gate = { hold, holdOne };
  const stage = (id, { mutating = true, file } = {}) => ({ id, mutating,
    isDone: async ctx => exists(join(ctx.folder, file || id, 'done')),
    run: async ctx => {
      ran.push(id);
      await mkdir(join(ctx.folder, file || id), { recursive: true });
      await writeFile(join(ctx.folder, file || id, 'part'), 'downloading');
      while (gate.hold && id === 'two') await wait(20, ctx.signal);
      while (gate.holdOne && id === 'one') await wait(20);
      await writeFile(join(ctx.folder, file || id, 'done'), 'ok');
    } });
  const spec = {
    id: 'toy', versionKey: 'markerInstall', label: 'Toy install state', stateFile: () => join(dir, 'state', 'toy-install.json'),
    sentinel: '.toy.json', createdBy: 'toy-installer', folderName: 'Toy', children: ['one', 'two', 'three'], trackParents: true,
    messages: { needConfirm: 'confirm', needConfirmUninstall: 'confirm', busy: 'busy', uninstallBusy: 'busy', notOurs: 'not ours', interrupted: 'interrupted', cancelled: 'cancelled' },
    explain: (_stage, text) => ({ code: classifyFailure(text) || 'toy-failed', message: 'failed' }),
    unknownFailure: () => ({ code: 'toy-failed', message: 'failed' }),
    plan: async args => ({ ok: true, problems: [], folder: args.location }),
    installedProgram: async folder => exists(join(folder, 'three', 'done')),
    view: (state, { status, error, installed }) => ({ status, stage: state.stage, done: state.done || [], error, installed, installedFolder: installed ? state.installedFolder : '', log: state.log || [] }),
    stages: [stage('one'), stage('two'), stage('three', { mutating: false })],
  };
  return { dir, spec, ran, gate, location: join(dir, 'Apps', 'Toy'), stateFile: spec.stateFile() };
}

test('stages run in order; a second start skips what is done; the parents it made are recorded', async t => {
  const h = await toy(t);
  const installer = createToolInstaller(h.spec);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  const done = await installer.status();
  assert.deepEqual([done.status, done.done, done.installed], ['complete', ['one', 'two', 'three'], true]);
  assert.deepEqual(h.ran, ['one', 'two', 'three']);
  const sentinel = JSON.parse(await readFile(join(h.location, '.toy.json'), 'utf8'));
  assert.deepEqual(sentinel.createdParents, [join(h.dir, 'Apps')]);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.deepEqual(h.ran, ['one', 'two', 'three'], 'nothing ran again');
  assert.ok((await installer.status()).log.some(line => /already done/.test(line)));
});

test('cancel mid-stage keeps the sentinel and the partial files; the next start resumes from that stage', async t => {
  const h = await toy(t, { hold: true });
  const installer = createToolInstaller(h.spec);
  await installer.start({ confirm: true, location: h.location });
  for (let i = 0; i < 400 && !(await exists(join(h.location, 'two', 'part'))); i++) await wait(10);
  await assert.rejects(installer.start({ confirm: true, location: h.location }), error => error.code === 'busy');
  await installer.cancel(); await installer.idle();
  const cancelled = await installer.status();
  assert.deepEqual([cancelled.status, cancelled.stage, cancelled.error.code], ['cancelled', 'two', 'cancelled']);
  assert.ok(await exists(join(h.location, '.toy.json')));
  assert.ok(await exists(join(h.location, 'two', 'part')));
  h.gate.hold = false;
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).status, 'complete');
  assert.deepEqual(h.ran, ['one', 'two', 'two', 'three']);
});

test('a running state without a live run reads as interrupted; a later format is refused and left alone', async t => {
  const h = await toy(t);
  await mkdir(join(h.dir, 'state'), { recursive: true });
  await writeFile(h.stateFile, JSON.stringify({ status: 'running', stage: 'two', folder: h.location }));
  const view = await createToolInstaller(h.spec).status();
  assert.deepEqual([view.status, view.error.code], ['interrupted', 'interrupted']);
  await writeFile(h.stateFile, JSON.stringify({ version: 7, status: 'complete' }));
  await assert.rejects(createToolInstaller(h.spec).start({ confirm: true, location: h.location }), error => error.code === 'unsupported-store-version');
  assert.equal(JSON.parse(await readFile(h.stateFile, 'utf8')).version, 7);
});

test('uninstall removes only the known children and the empty parents it made, never a folder without the sentinel', async t => {
  const h = await toy(t);
  const installer = createToolInstaller(h.spec);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  await writeFile(join(h.location, 'mine.txt'), 'keep');
  await installer.uninstall({ confirm: true });
  assert.deepEqual(await readdir(h.location), ['mine.txt'], 'the stranger stays, so the folder and its parent stay');
  const fresh = join(h.dir, 'More', 'Deeper', 'Toy');
  await installer.start({ confirm: true, location: fresh }); await installer.idle();
  await installer.uninstall({ confirm: true });
  assert.equal(await exists(join(h.dir, 'More')), false, 'emptied, so the folder and the parents it made are removed');
  // A folder whose sentinel was removed is not ours: nothing is deleted.
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  await rm(join(h.location, '.toy.json'));
  await assert.rejects(installer.uninstall({ confirm: true }), error => error.code === 'not-ours');
  assert.ok(await exists(join(h.location, 'one', 'done')));
});

test('one slot per state file: two tools run side by side, one tool only once', async t => {
  const a = await toy(t, { hold: true }), b = await toy(t);
  const first = createToolInstaller(a.spec), other = createToolInstaller(b.spec);
  await first.start({ confirm: true, location: a.location });
  for (let i = 0; i < 400 && !(await exists(join(a.location, 'two', 'part'))); i++) await wait(10);
  await other.start({ confirm: true, location: b.location }); await other.idle();
  assert.equal((await other.status()).status, 'complete');
  assert.ok(liveRun(a.stateFile));
  await assert.rejects(createToolInstaller(a.spec).start({ confirm: true, location: a.location }), error => error.code === 'busy');
  await first.cancel(); await first.idle();
  assert.equal(liveRun(a.stateFile), null);
});

test('the row seam shows the run in the console: opened with the run, updated, closed with the end; its abort reaches the run', async t => {
  const h = await toy(t, { hold: true });
  const events = [];
  let controller;
  const installer = createToolInstaller(h.spec, { row: run => { controller = run.controller; events.push(['open', run.state.status]); return { update: state => events.push(['update', state.stage]), close: state => events.push(['close', state.status]) }; } });
  await installer.start({ confirm: true, location: h.location });
  for (let i = 0; i < 400 && !(await exists(join(h.location, 'two', 'part'))); i++) await wait(10);
  controller.abort(new Error('stopped in the console'));
  await installer.idle();
  assert.deepEqual(events[0], ['open', 'running']);
  assert.ok(events.some(([kind, stage]) => kind === 'update' && stage === 'two'));
  assert.deepEqual(events.at(-1), ['close', 'cancelled']);
  assert.equal((await installer.status()).status, 'cancelled');
});

test('a cancel during a step that ignores it stops before the next step', async t => {
  const h = await toy(t, { hold: true, holdOne: true });
  const installer = createToolInstaller(h.spec);
  await installer.start({ confirm: true, location: h.location });
  for (let i = 0; i < 400 && !(await exists(join(h.location, 'one', 'part'))); i++) await wait(10);
  await installer.cancel();
  h.gate.holdOne = false;
  await installer.idle();
  const view = await installer.status();
  assert.deepEqual([view.status, view.stage, view.error.code], ['cancelled', 'one', 'cancelled']);
  assert.deepEqual(h.ran, ['one'], 'step two never started');
  assert.equal(await exists(join(h.location, 'two')), false);
});

test('the shared failure reading', () => {
  assert.equal(classifyFailure('error: Failed to fetch: https://x\n  Caused by: error sending request'), 'network');
  assert.equal(classifyFailure('failed to write (os error 112)'), 'no-space');
  assert.equal(classifyFailure('拒绝访问。 (os error 5)'), 'not-writable');
  assert.equal(classifyFailure('ImportError: DLL load failed while importing x'), 'vc-runtime');
  assert.equal(classifyFailure('服务启动失败：端口被占用'), 'port-in-use');
  assert.equal(classifyFailure('The filename or extension is too long. (os error 206)'), 'path-too-long');
  assert.equal(classifyFailure('something else'), null);
  // A native addon that cannot load on English Windows (a missing VC++ runtime DLL), and Node's own code for it; a module Node or Python cannot resolve is not that.
  assert.equal(classifyFailure('Error: The specified module could not be found.\r\n\\\\?\\D:\\StudyHub\\live\\sherpa-onnx.node'), 'vc-runtime');
  assert.equal(classifyFailure("Error: ... code: 'ERR_DLOPEN_FAILED'"), 'vc-runtime');
  assert.equal(classifyFailure('OSError: [WinError 126] Error loading "c10.dll" or one of its dependencies.'), 'vc-runtime');
  for (const unresolved of ["Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\\x\\worker.mjs'", "Error: Cannot find module 'sherpa-onnx-node'", "ModuleNotFoundError: No module named 'mineru'", "ModuleNotFoundError: No module named 'torch'"])
    assert.equal(classifyFailure(unresolved), null, unresolved);
  assert.equal(classifyFailure('Error: getaddrinfo ENOTFOUND pypi.org'), 'network');
  assert.equal(classifyFailure('requests.exceptions.ConnectionError: Connection refused'), 'network');
  assert.equal(classifyFailure('urllib3.exceptions.ReadTimeoutError: HTTPSConnectionPool: Read timed out.'), 'network');
  assert.equal(classifyFailure('OSError: [Errno 101] Network is unreachable'), 'network');
  for (const ordinaryLog of [
    'INFO: Connection pool initialized (size=4)',
    'INFO: local network interface ready',
    'INFO: idle worker timed out after 30s, exiting cleanly',
  ]) assert.equal(classifyFailure(ordinaryLog), null, ordinaryLog);
  assert.ok(new InstallError('x', 'y') instanceof Error);
});

/* Windows scanners and indexers briefly deny replacing or reading a file. The state file is how a restart (and the next status) learns the result of a run,
   so a denied write that is dropped reads as "interrupted" and a denied read as "idle" while the tool is in fact installed (issue #920). */
const denied = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted`), { code });

test('a state write survives a briefly denied replace, and writes to one file never overlap', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-state-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = join(dir, 'state', 'toy.json'), store = { versionKey: 'markerInstall', label: 'Toy' };
  let calls = 0, open = 0, widest = 0;
  const flaky = async (from, to) => {
    calls += 1; open += 1; widest = Math.max(widest, open);
    try { await wait(15); if (calls <= 2) throw denied(); await rename(from, to); } finally { open -= 1; }
  };
  await writeState(file, { status: 'complete', stage: 'done' }, { ...store, rename: flaky });
  assert.equal(calls, 3, 'the same finished file is replaced again until the replace is allowed');
  assert.deepEqual([(await readState(file, 'markerInstall')).status, (await readdir(join(dir, 'state'))).length], ['complete', 1], 'no half-written copy is left');
});

test('writes to one file land in the order they were asked, even when the first replace is slower', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-state-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = join(dir, 'toy.json'), store = { versionKey: 'markerInstall', label: 'Toy' };
  let calls = 0, open = 0, widest = 0;
  const slowFirst = async (from, to) => {
    const mine = ++calls; open += 1; widest = Math.max(widest, open);
    try { await wait(mine === 1 ? 80 : 0); await rename(from, to); } finally { open -= 1; }
  };
  const first = writeState(file, { status: 'running' }, { ...store, rename: slowFirst });
  const second = writeState(file, { status: 'failed' }, { ...store, rename: slowFirst });
  await Promise.all([first, second]);
  assert.equal(widest, 1, 'two writes never replace the file at the same time');
  assert.equal((await readState(file, 'markerInstall')).status, 'failed', 'the later state is the one on disk');
});

test('a state write that stays denied gives up with the error and leaves no temporary file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-state-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = join(dir, 'toy.json');
  await assert.rejects(writeState(file, { status: 'complete' }, { versionKey: 'markerInstall', label: 'Toy', rename: async () => { throw denied('EBUSY'); } }), { code: 'EBUSY' });
  assert.deepEqual(await readdir(dir), []);
});

test('a state read survives a briefly denied open; a missing or broken file still reads as empty', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tool-state-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = join(dir, 'toy.json');
  await writeFile(file, JSON.stringify({ version: 1, status: 'complete' }));
  let tries = 0;
  const flaky = async (...args) => { tries += 1; if (tries <= 2) throw denied('EBUSY'); return readFile(...args); };
  assert.equal((await readState(file, 'markerInstall', { read: flaky })).status, 'complete');
  assert.equal(tries, 3);
  assert.deepEqual(await readState(join(dir, 'missing.json'), 'markerInstall'), {});
  await writeFile(file, '{ not json');
  assert.deepEqual(await readState(file, 'markerInstall'), {});
});

test('while the replace stays denied, timer writes do not pile up behind the final one', async t => {
  const h = await toy(t);
  const saved = process.env.STUDY_FS_RETRY_MS;
  process.env.STUDY_FS_RETRY_MS = '2'; // a whole retry cycle of a denied replace is then about 140 ms
  t.after(() => { if (saved === undefined) delete process.env.STUDY_FS_RETRY_MS; else process.env.STUDY_FS_RETRY_MS = saved; });
  let attempts = 0, last = 0;
  const alwaysDenied = async () => { attempts += 1; throw denied(); };
  const busy = { id: 'one', mutating: false, run: async ctx => { for (let i = 0; i < 30; i++) { ctx.push(`line ${i}`); await wait(20); } last = Date.now(); } };
  const installer = createToolInstaller({ ...h.spec, stages: [busy] }, { flushMs: 20, stateRename: alwaysDenied });
  await installer.start({ confirm: true, location: h.location });
  await installer.idle();
  const settled = Date.now() - last;
  assert.ok(settled < 1000, `the final write waited ${settled} ms behind earlier timer writes (${attempts} replace attempts)`);
});

test('a log line pushed while a timer write is in flight still reaches the state file without another push', async t => {
  const h = await toy(t);
  let slow = false;
  const slowOnce = async (from, to) => { if (slow) { slow = false; await wait(100); } await rename(from, to); };
  let onDisk = '';
  const stage = { id: 'one', mutating: false, run: async ctx => {
    slow = true; ctx.push('first'); await wait(40); ctx.push('late'); await wait(400);
    onDisk = JSON.parse(await readFile(h.stateFile, 'utf8')).lastLine;
  } };
  const installer = createToolInstaller({ ...h.spec, stages: [stage] }, { flushMs: 20, stateRename: slowOnce });
  await installer.start({ confirm: true, location: h.location });
  await installer.idle();
  assert.equal(onDisk, 'late', 'the write that found one in flight is asked again when that one ends');
});
