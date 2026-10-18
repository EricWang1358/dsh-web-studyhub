import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstallError, classifyFailure, createToolInstaller, liveRun } from '../lib/tool-install.js';

/* The install engine shared by Marker and MinerU, with a toy tool whose stages only write files: the order, the done-checks, cancel and resume, the
   restart, the format version, the one slot per state file, the uninstall rules and the task-console row. */

const exists = file => stat(file).then(() => true, () => false);
const wait = (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });

async function toy(t, { hold = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tool-install-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const ran = [], gate = { hold };
  const stage = (id, { mutating = true, file } = {}) => ({ id, mutating,
    isDone: async ctx => exists(join(ctx.folder, file || id, 'done')),
    run: async ctx => {
      ran.push(id);
      await mkdir(join(ctx.folder, file || id), { recursive: true });
      await writeFile(join(ctx.folder, file || id, 'part'), 'downloading');
      while (gate.hold && id === 'two') await wait(20, ctx.signal);
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

test('the shared failure reading', () => {
  assert.equal(classifyFailure('error: Failed to fetch: https://x\n  Caused by: error sending request'), 'network');
  assert.equal(classifyFailure('failed to write (os error 112)'), 'no-space');
  assert.equal(classifyFailure('拒绝访问。 (os error 5)'), 'not-writable');
  assert.equal(classifyFailure('ImportError: DLL load failed while importing x'), 'vc-runtime');
  assert.equal(classifyFailure('服务启动失败：端口被占用'), 'port-in-use');
  assert.equal(classifyFailure('The filename or extension is too long. (os error 206)'), 'path-too-long');
  assert.equal(classifyFailure('something else'), null);
  assert.ok(new InstallError('x', 'y') instanceof Error);
});
