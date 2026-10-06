import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeMineru } from '../../helpers/fake-mineru.mjs';
import { fakeIndexPort, untilAborted } from '../../helpers/index-port.mjs';
import { managedRuntimeOptions } from '../../helpers/runtime-switch.mjs';
import { makePdf } from '../../helpers/pdf.mjs';
import { patientCli, until } from '../../helpers/wait.mjs';

/* The S5-7 rollback drill, one step per process, every fake and no network (run it with run-drill.mjs):
     prepare <scenario>   the CURRENT code, every non-model switch on, makes the finished artifacts or the unfinished work, then the process ENDS HARD (no dispose, no cleanup: a crash or a rollback);
     read <scenario>      a code tree (the fixed older one, or the current one) opens the same library and DSH home, reports what it sees, and with `act` finishes the unfinished work.
   argv: mode, scenario, workdir, libRoot, switches ('on' | 'off'), act ('act' | 'look'). The result is one line, `RESULT <json>`. */

const [mode, scenario, work, libRoot, switches, act] = process.argv.slice(2);
const root = join(work, 'library'), home = join(work, 'home');
process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
const here = name => fileURLToPath(new URL(`../../helpers/${name}`, import.meta.url));
const ALL = ['pdfConvert', 'markerInstall', 'mineruSetup', 'retrievalIndex'];
const state = name => join(work, name);
const readJson = async name => JSON.parse(await readFile(state(name), 'utf8'));
const patchJson = async (name, patch) => writeFile(state(name), JSON.stringify({ ...await readJson(name).catch(() => ({})), ...patch }));

async function build({ lib, withSwitches, indexOptions, cloud }) {
  const { StudyService } = await import(pathToFileURL(join(lib, 'lib/service.js')).href);
  const { venvLayout } = await import(pathToFileURL(join(lib, 'lib/marker-install.js')).href);
  const index = fakeIndexPort(indexOptions), clock = { time: 5_000_000 };
  const pyEnv = { FAKE_PY_STATE: state('py.json'), FAKE_PY_LOG: state('py.log') };
  const mineruEnv = { FAKE_MINERU_STATE: state('mineru.json'), FAKE_MINERU_LOG: state('mineru.log') };
  const mineruCli = patientCli({ file: process.execPath, prefix: [here('fake-mineru-cli.mjs')], env: mineruEnv });
  const python = env => patientCli({ file: process.execPath, prefix: [here('fake-python.mjs')], env });
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: withSwitches ? ALL : [] });
  const options = { coach: false, retrieval: index.port, ...managed,
    marker: { install: { pythons: [python(pyEnv)], freeMegabytes: async () => 100_000, venvPython: folder => python({ ...pyEnv, FAKE_PY_VENV: venvLayout(folder).venv }),
      markerCli: () => patientCli({ file: process.execPath, prefix: [here('fake-marker-cli.mjs')], env: {} }) } },
    mineru: { limits: { windowPages: 50 }, ...(cloud ? { baseUrl: cloud.baseUrl, now: () => clock.time,
      sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 15)); } } : {}),
      local: { cli: mineruCli, home: join(work, 'mineru-home'), modelsCli: patientCli({ file: process.execPath, prefix: [here('fake-mineru-cli.mjs')], env: mineruEnv }) } } };
  return { service: new StudyService(root, options), index };
}
const upload = async (service, pages) => {
  const bytes = await makePdf({ pages }), { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
  await service.call('mineru.upload.finish', { uploadId });
  return uploadId;
};
const pdfJobs = async service => (await service.call('snapshot')).jobs.filter(job => job.type === 'pdf-convert');
const settledJob = (service, id) => until(async () => { const job = (await pdfJobs(service)).find(item => item.id === id); return job && !['queued', 'running', 'cancelling'].includes(job.status) && job; }, 'the conversion', { timeoutMs: 240_000 });
const documents = async service => (await service.call('snapshot')).sources.filter(source => source.document);
const resultsOf = async () => {
  const base = join(home, 'study', 'tmp', 'pdf-convert'), found = [];
  for (const library of await readdir(base).catch(() => [])) for (const book of await readdir(join(base, library, 'results')).catch(() => []))
    found.push(...(await readdir(join(base, library, 'results', book)).catch(() => [])));
  return found;
};
const crash = () => { console.log(`RESULT ${JSON.stringify({ scenario, prepared: true, endedHard: true })}`); process.exit(0); }; // no dispose, no cleanup

/* What a code tree sees of the library, in words both versions can answer. */
async function view(service) {
  const docs = await documents(service);
  const history = (await service.call('mineru.history.list')).records;
  const coverage = await service.call('retrieval.index.coverage', {}), install = await service.call('marker.install.status'), setup = await service.call('mineru.local.setup.status');
  return { pages: docs.length, pageHash: hash(docs.map(source => `${source.id}:${hash(String(source.text ?? source.content ?? ''))}`).sort().join('|')), history: history.map(row => `${row.status}${row.canRetry ? '+retry' : ''}`).sort(),
    indexed: coverage.indexed.length, missing: coverage.missing.length, install: install.status, installed: install.installed === true, setup: setup.status };
}
const finishWork = {
  async pdf(service) {
    const [row] = (await service.call('mineru.history.list')).records.filter(record => record.canRetry);
    assert.ok(row, 'an unfinished conversion offers "接着做"');
    await patchJson('mineru.json', { slowFromPage: 0, slowMs: 0 });
    const before = (await documents(service)).length;
    await service.call('mineru.retry', { jobId: row.id });
    assert.equal((await settledJob(service, row.id)).status, 'complete');
    // The history row is written just after the job settles: wait for it (whichever version) so the view below is not a race.
    await until(async () => (await service.call('mineru.history.list')).records.some(record => record.id === row.id && record.status === 'complete'), 'the history row', { timeoutMs: 30_000 }).catch(() => {});
    return { pagesAdded: (await documents(service)).length - before };
  },
  async install(service) {
    await patchJson('py.json', { delayPip: false });
    assert.equal((await service.call('marker.install.start', { confirm: true })).status, 'running');
    return { status: (await until(async () => { const view = await service.call('marker.install.status'); return view.status === 'complete' && view; }, 'the install', { timeoutMs: 240_000 })).status };
  },
  async setup(service) {
    await patchJson('mineru.json', { downloadDelayMs: 0 });
    const started = await service.call('mineru.local.setup', { tier: 'basic', confirm: true });
    assert.ok(started.status);
    return { status: (await until(async () => { const run = await service.call('mineru.local.setup.status'); return run.status === 'complete' && run; }, 'the setup', { timeoutMs: 240_000 })).status };
  },
  async index(service) {
    const started = await service.call('retrieval.index.start', { course: 'OS' });
    assert.ok(started.status);
    await until(async () => (await service.call('retrieval.index.status', {})).status === 'complete', 'the index build', { timeoutMs: 240_000 });
    return { indexed: (await service.call('retrieval.index.coverage', {})).indexed.length };
  },
};

const book = Array.from({ length: 4 }, (_, i) => `<!-- page: ${i + 1} -->\nOS 第 ${i + 1} 页讲进程。`).join('\n\n');
const importBook = service => service.call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'OS.md', courses: ['OS'] });

if (mode === 'prepare') {
  await mkdir(work, { recursive: true });
  await writeFile(state('py.json'), JSON.stringify({ delayPip: scenario === 'install' })); await writeFile(state('py.log'), ''); await writeFile(state('mineru.log'), '');
  const fresh = { version: '4.0.10', total: 120, mode: 'disabled', tier: 'flash', running: false, modelsReady: false };
  const ready = { ...fresh, mode: 'managed', tier: 'basic', running: true, modelsReady: true };
  await writeFile(state('mineru.json'), JSON.stringify(scenario === 'setup' ? { ...fresh, downloadDelayMs: 60_000 } : scenario === 'pdf' ? { ...ready, slowFromPage: 51, slowMs: 60_000 } : scenario === 'settled' ? fresh : ready));
  const cloud = scenario === 'settled' ? await startFakeMineru() : null;
  const { service } = await build({ lib: libRoot, withSwitches: true, cloud,
    indexOptions: scenario === 'index' ? { onIngest: (args, n, options) => (n >= 3 ? untilAborted(args, n, options) : undefined) } : {} });
  await importBook(service);
  if (scenario === 'settled') {
    await service.call('mineru.settings.set', { token: cloud.token, acknowledge: true });
    const done = await service.call('mineru.import', { uploadId: await upload(service, 3), courses: ['OS'] });
    assert.equal((await settledJob(service, done.jobId)).status, 'complete');
    assert.equal((await service.call('marker.install.start', { confirm: true })).status, 'running');
    await until(async () => (await service.call('marker.install.status')).status === 'complete', 'the install', { timeoutMs: 240_000 });
    await service.call('mineru.local.setup', { tier: 'basic', confirm: true });
    await until(async () => (await service.call('mineru.local.setup.status')).status === 'complete', 'the setup', { timeoutMs: 240_000 });
    await service.call('retrieval.index.start', { course: 'OS' });
    await until(async () => (await service.call('retrieval.index.status', {})).status === 'complete', 'the index build', { timeoutMs: 240_000 });
    await writeFile(state('prepared.json'), JSON.stringify(await view(service)));
    await service.dispose(); await cloud.close();
  } else if (scenario === 'pdf') {
    await service.call('mineru.import', { uploadId: await upload(service, 120), route: 'local' });
    await until(async () => (await resultsOf()).length > 0, 'the first window to be saved', { timeoutMs: 240_000 });
    crash();
  } else if (scenario === 'install') {
    assert.equal((await service.call('marker.install.start', { confirm: true })).status, 'running');
    await until(async () => (await readFile(state('py.log'), 'utf8')).includes('pip'), 'the install to reach pip', { timeoutMs: 240_000 });
    crash();
  } else if (scenario === 'setup') {
    await service.call('mineru.local.setup', { tier: 'basic', confirm: true });
    await until(async () => (await readFile(state('mineru.log'), 'utf8')).includes('--tier'), 'the model download to start', { timeoutMs: 240_000 });
    crash();
  } else if (scenario === 'index') {
    await service.call('retrieval.index.start', { course: 'OS' });
    await until(async () => (await service.call('retrieval.index.status', {})).done >= 2, 'two pages to be indexed', { timeoutMs: 240_000 });
    crash();
  }
  console.log(`RESULT ${JSON.stringify({ scenario, prepared: true })}`);
  process.exit(0);
}

assert.equal(mode, 'read');
const { service } = await build({ lib: libRoot, withSwitches: switches === 'on' });
const seen = await view(service);
const result = { scenario, lib: switches === 'on' ? 'current' : 'older', seen };
if (act === 'act' && scenario !== 'settled') { result.finished = await finishWork[scenario](service); result.after = await view(service); }
if (scenario === 'settled') result.prepared = JSON.parse(await readFile(state('prepared.json'), 'utf8'));
await service.dispose();
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
