import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { venvLayout } from '../lib/marker-install.js';
import { mineruInstallStatePath } from '../lib/mineru-install.js';
import { installHarness } from './helpers/mineru-install-harness.mjs';
import { makePdf } from './helpers/pdf.mjs';
import { patientCli, until } from './helpers/wait.mjs';

/* S5-0 baseline of which MinerU / Marker / index operations are INSTANT calls and which long-running work is invisible to the shared job list
   (docs/plans/unified-job-runtime/s5-0-nonmodel-baseline.md), as it is since 3.5.5: the cloud route is gone, and the one-click MinerU install shows in the job list
   as a `local-install` row. Fakes only: fake mineru, uv and python programs and a local uv index, a fake marker_single. */

const FAKE_MINERU = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const FAKE_PYTHON = fileURLToPath(new URL('./helpers/fake-python.mjs', import.meta.url));
const FAKE_MARKER = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));
const exists = async file => stat(file).then(() => true, () => false);
const lines = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean);

async function harness(t, { mineru = { mode: 'disabled', tier: 'flash', running: false, modelsReady: false }, py = {} } = {}) {
  const installer = await installHarness(t, { mineru });
  const dir = await mkdtemp(join(tmpdir(), 'nonmodel-instant-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = join(dir, 'home'); delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const work = join(dir, 'fake'); await mkdir(join(work, 'models'), { recursive: true });
  const mineruState = join(work, 'mineru.json'), mineruLog = join(work, 'mineru.jsonl'), pyState = join(work, 'py.json'), pyLog = join(work, 'py.jsonl');
  await writeFile(mineruState, JSON.stringify({ version: '4.0.10', total: 10, ...mineru })); await writeFile(mineruLog, '');
  await writeFile(pyState, JSON.stringify(py)); await writeFile(pyLog, '');
  const cli = patientCli({ file: process.execPath, prefix: [FAKE_MINERU], env: { FAKE_MINERU_STATE: mineruState, FAKE_MINERU_LOG: mineruLog } });
  const pyEnv = { FAKE_PY_STATE: pyState, FAKE_PY_LOG: pyLog };
  const install = { pythons: [patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env: pyEnv })], freeMegabytes: async () => 100_000,
    venvPython: folder => patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env: { ...pyEnv, FAKE_PY_VENV: venvLayout(folder).venv } }),
    markerCli: () => patientCli({ file: process.execPath, prefix: [FAKE_MARKER], env: {} }) };
  const options = { mineru: { local: { cli, home: work }, install: installer.seams }, marker: { local: { cli: null }, install } };
  let service = new StudyService(join(dir, 'library'), options);
  t.after(async () => {
    await service.call('marker.install.cancel'); await service.call('mineru.install.cancel');
    await new Promise(resolve => setTimeout(resolve, 50));
    service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, installer, reopen: () => { service.dispose(); service = new StudyService(join(dir, 'library'), options); }, call: (action, args) => service.call(action, args), jobs: async () => (await service.call('snapshot')).jobs,
    mineruCalls: async () => (await lines(mineruLog)).map(line => JSON.parse(line).argv), pyCalls: () => lines(pyLog) };
}

test('plan, status and history are instant calls: they answer with data, never a job id, a job-list entry or a background run', async t => {
  const h = await harness(t, { mineru: { mode: 'managed', tier: 'basic', running: true, modelsReady: true } });
  const pdf = join(h.dir, 'Book.pdf'); await writeFile(pdf, await makePdf({ pages: 3 }));
  const answers = {
    'mineru.plan': await h.call('mineru.plan', { path: pdf }),
    'mineru.local.status': await h.call('mineru.local.status'),
    'mineru.install.status': await h.call('mineru.install.status'),
    'mineru.install.plan': await h.call('mineru.install.plan', {}),
    'mineru.history.list': await h.call('mineru.history.list'),
    'marker.settings.get': await h.call('marker.settings.get'),
    'marker.local.status': await h.call('marker.local.status'),
    'marker.install.status': await h.call('marker.install.status'),
    'marker.install.plan': await h.call('marker.install.plan', {}),
  };
  for (const [action, value] of Object.entries(answers)) assert.ok(value && typeof value === 'object' && !('jobId' in value), `${action} returns plain data`);
  assert.equal(answers['mineru.plan'].windows.length, 1);
  assert.equal(answers['mineru.local.status'].state, 'ready');
  assert.deepEqual(await h.jobs(), []);
  assert.equal((await h.call('mineru.install.status')).status, 'idle');
  assert.equal((await h.call('marker.install.status')).status, 'idle');
  for (const gone of ['mineru.settings.get', 'mineru.settings.set', 'mineru.test', 'mineru.local.setup']) await assert.rejects(h.call(gone, {}), undefined, `${gone} is gone with the cloud route and the old setup`);
  assert.ok((await h.mineruCalls()).every(argv => ['--version', 'config', 'server'].includes(argv[0]) && argv[1] !== 'start'), 'only read-only CLI calls');
  assert.ok((await h.pyCalls()).every(line => /--version|"-c"/.test(line)), 'python was only probed');
  assert.equal(await exists(mineruInstallStatePath()), false, 'a plan writes nothing');
});

test('the MinerU and the Marker install are background runs with their own status call AND a row each of the shared job list', async t => {
  const h = await harness(t);
  await assert.rejects(h.call('mineru.install.start', {}), /confirm/);
  await assert.rejects(h.call('marker.install.start', {}), /confirm/);
  assert.deepEqual((await h.installer.uvLog()), [], 'nothing was downloaded without the confirmation');
  assert.deepEqual(await h.pyCalls(), []);
  const setup = await h.call('mineru.install.start', { confirm: true });
  const install = await h.call('marker.install.start', { confirm: true });
  assert.deepEqual([setup.status, install.status], ['running', 'running']);
  assert.ok(!('jobId' in setup) && !('jobId' in install));
  assert.deepEqual((await h.jobs()).map(job => [job.type, job.tool]).sort(), [['local-install', 'marker'], ['local-install', 'mineru']], 'both installs are in the task list while they run');
  await until(async () => (await h.call('mineru.install.status')).status === 'complete', 'the MinerU install', { timeoutMs: 240_000 });
  await until(async () => (await h.call('marker.install.status')).status === 'complete', 'the Marker install', { timeoutMs: 240_000 });
  assert.deepEqual((await h.jobs()).map(job => [job.type, job.status]), [['local-install', 'complete'], ['local-install', 'complete']], 'and stay there, finished, until they are dismissed');
});

test('DEFECT BASELINE: unloading the service stops neither a running Marker install nor a running MinerU install (pilot off): nothing owns their end', async t => {
  const h = await harness(t, { mineru: { mode: 'disabled', tier: 'flash', running: false, modelsReady: false, downloadDelayMs: 60_000 }, py: { delayPip: true } });
  await h.call('mineru.install.start', { confirm: true });
  await h.call('marker.install.start', { confirm: true });
  await until(async () => (await h.installer.mineruLog()).some(entry => entry.argv[0] === 'models' && entry.argv[1] === 'download') && (await h.call('marker.install.status')).log.some(line => /Collecting marker-pdf/.test(line)), 'both child processes', { timeoutMs: 240_000 });
  h.reopen();
  assert.equal((await h.call('mineru.install.status')).status, 'running', 'the install run outlived the service that started it');
  assert.equal((await h.call('marker.install.status')).status, 'running', 'so did the Marker install');
});
