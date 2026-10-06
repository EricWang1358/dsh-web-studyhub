import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { venvLayout } from '../lib/marker-install.js';
import { mineruSettingsPath } from '../lib/mineru-settings.js';
import { startFakeMineru } from './helpers/fake-mineru.mjs';
import { makePdf } from './helpers/pdf.mjs';
import { patientCli, until } from './helpers/wait.mjs';

/* S5-0 baseline of which MinerU / Marker / index operations are INSTANT calls and which long-running work is invisible to the shared job list
   (docs/plans/unified-job-runtime/s5-0-nonmodel-baseline.md). Fakes only: a fake MinerU server, fake mineru and python programs, a fake marker_single. */

const FAKE_MINERU = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const FAKE_PYTHON = fileURLToPath(new URL('./helpers/fake-python.mjs', import.meta.url));
const FAKE_MARKER = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));
const exists = async file => stat(file).then(() => true, () => false);
const lines = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean);

async function harness(t, { mineru = { mode: 'disabled', tier: 'flash', running: false, modelsReady: false }, py = {} } = {}) {
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
  const fake = await startFakeMineru();
  const options = { mineru: { baseUrl: fake.baseUrl, local: { cli, home: work, modelsCli: cli } }, marker: { local: { cli: null }, install } };
  let service = new StudyService(join(dir, 'library'), options);
  t.after(async () => {
    await service.call('marker.install.cancel'); await service.call('mineru.local.setup.cancel');
    await new Promise(resolve => setTimeout(resolve, 50));
    service.dispose(); await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, fake, reopen: () => { service.dispose(); service = new StudyService(join(dir, 'library'), options); }, call: (action, args) => service.call(action, args), jobs: async () => (await service.call('snapshot')).jobs,
    mineruCalls: async () => (await lines(mineruLog)).map(line => JSON.parse(line).argv), pyCalls: () => lines(pyLog) };
}

test('settings, plan, status and history are instant calls: they answer with data, never a job id, a job-list entry or a background run', async t => {
  const h = await harness(t, { mineru: { mode: 'managed', tier: 'basic', running: true, modelsReady: true } });
  const pdf = join(h.dir, 'Book.pdf'); await writeFile(pdf, await makePdf({ pages: 3 }));
  const answers = {
    'mineru.settings.get': await h.call('mineru.settings.get'),
    'mineru.settings.set': await h.call('mineru.settings.set', { token: h.fake.token, acknowledge: true }),
    'mineru.test': await h.call('mineru.test'),
    'mineru.plan': await h.call('mineru.plan', { path: pdf }),
    'mineru.local.status': await h.call('mineru.local.status'),
    'mineru.history.list': await h.call('mineru.history.list'),
    'marker.settings.get': await h.call('marker.settings.get'),
    'marker.local.status': await h.call('marker.local.status'),
    'marker.install.status': await h.call('marker.install.status'),
    'marker.install.plan': await h.call('marker.install.plan', {}),
  };
  for (const [action, value] of Object.entries(answers)) assert.ok(value && typeof value === 'object' && !('jobId' in value), `${action} returns plain data`);
  assert.equal(answers['mineru.test'].state, 'valid');
  assert.equal(answers['mineru.plan'].pieces.length, 1);
  assert.equal(answers['mineru.local.status'].state, 'ready');
  assert.deepEqual(await h.jobs(), []);
  assert.equal((await h.call('mineru.local.setup.status')).status, 'idle');
  assert.equal((await h.call('marker.install.status')).status, 'idle');
  assert.deepEqual(h.fake.requests.map(request => [request.method, request.path.replace(/[0-9a-f-]{36}$/, '<uuid>')]), [['GET', '/api/v4/extract-results/batch/<uuid>']], 'the token test is the only request MinerU saw: nothing was uploaded');
  assert.ok((await h.mineruCalls()).every(argv => ['--version', 'config', 'server'].includes(argv[0]) && argv[1] !== 'start'), 'only read-only CLI calls');
  assert.ok((await h.pyCalls()).every(line => /--version|"-c"/.test(line)), 'python was only probed');
});

test('the long local-mineru setup and the Marker install are background runs with their own status calls, and neither is in the shared job list while it runs', async t => {
  const h = await harness(t);
  await assert.rejects(h.call('mineru.local.setup', { tier: 'basic' }), /确认/);
  await assert.rejects(h.call('marker.install.start', {}), /confirm/);
  assert.deepEqual((await h.mineruCalls()).filter(argv => argv[0] === '--tier' || argv[1] === 'set'), [], 'nothing was downloaded or configured without the confirmation');
  assert.deepEqual(await h.pyCalls(), []);
  const setup = await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  const install = await h.call('marker.install.start', { confirm: true });
  assert.deepEqual([setup.status, install.status], ['running', 'running']);
  assert.ok(!('jobId' in setup) && !('jobId' in install), 'no job id: the task console has nothing to show');
  assert.deepEqual(await h.jobs(), [], 'while they run, the shared job list is empty');
  await until(async () => (await h.call('mineru.local.setup.status')).status === 'complete', 'the setup', { timeoutMs: 240_000 });
  await until(async () => (await h.call('marker.install.status')).status === 'complete', 'the install', { timeoutMs: 240_000 });
  assert.deepEqual(await h.jobs(), [], 'and after they ended: the runs leave no record there');
  assert.equal(await exists(mineruSettingsPath()), false, 'the tier and mode were written into mineru\'s own service store, not a StudyHub file');
  assert.ok((await h.mineruCalls()).some(argv => argv.join(' ').includes('parse_server.local.mode managed')));
});

test('DEFECT BASELINE: unloading the service stops neither a running Marker install nor a running local-mineru setup: they are not jobs, so nothing owns their end', async t => {
  const h = await harness(t, { mineru: { mode: 'disabled', tier: 'flash', running: false, modelsReady: false, downloadDelayMs: 60_000 }, py: { delayPip: true } });
  await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await h.call('marker.install.start', { confirm: true });
  await until(async () => (await h.mineruCalls()).some(argv => argv[0] === '--tier') && (await h.call('marker.install.status')).log.some(line => /Collecting marker-pdf/.test(line)), 'both child processes', { timeoutMs: 240_000 });
  h.reopen();
  assert.equal((await h.call('mineru.local.setup.status')).status, 'running', 'the setup run outlived the service that started it');
  assert.equal((await h.call('marker.install.status')).status, 'running', 'so did the install');
});
