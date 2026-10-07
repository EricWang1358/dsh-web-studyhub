import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { venvLayout } from '../../lib/marker-install.js';
import { usageLedger } from '../../lib/model-usage.js';
import { startFakeMineru } from './fake-mineru.mjs';
import { fakeIndexPort, untilAborted } from './index-port.mjs';
import { makePdf } from './pdf.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { answer, course, model } from './recap-library.mjs';
import { patientCli, until } from './wait.mjs';
import { FRESH } from './mineru-setup-harness.mjs';

/* The library of the non-model families together (S5-7, S6-5): a PDF conversion, the Marker install, the local MinerU setup and an index build, each against a fake (a fake cloud, a fake Python,
   the fake `mineru` command line, a fake search extension), next to a daily recap on a fake model. Nothing leaves the machine; the real DSH home and Python are never touched.
   `paths` names the migration switches that start ON; `world.pilot` is the object the contexts read at each submission, so a test can flip one between two jobs. */

const FAKE_PYTHON = fileURLToPath(new URL('./fake-python.mjs', import.meta.url));
const FAKE_MARKER = fileURLToPath(new URL('./fake-marker-cli.mjs', import.meta.url));
const FAKE_MINERU = fileURLToPath(new URL('./fake-mineru-cli.mjs', import.meta.url));
export const NON_MODEL = ['pdf-convert', 'marker-install', 'mineru-setup', 'retrieval-index'];
export const ALL_PATHS = ['dailyRecap', 'pdfConvert', 'markerInstall', 'mineruSetup', 'retrievalIndex'];
export const still = job => ['queued', 'running', 'cancelling'].includes(job.status);

/** `fakes` may hold: `holdPdf` (a predicate for the cloud), `onIngest` (the index port), `py`/`mineru` (state of the fake Python and of the fake `mineru` command line). */
export async function family(t, { paths = ALL_PATHS, fakes = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-family-')), before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = join(dir, 'home'); delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const files = { py: join(dir, 'py.json'), mineru: join(dir, 'mineru.json') };
  await writeFile(files.py, JSON.stringify(fakes.py ?? {})); await writeFile(join(dir, 'py.log'), '');
  await writeFile(files.mineru, JSON.stringify({ version: '4.0.10', ...FRESH, ...fakes.mineru })); await writeFile(join(dir, 'mineru.log'), '');
  const prefix = target => [...(fakes.cliWrapper ? [fakes.cliWrapper] : []), target];
  const cliEnv = fakes.cliWrapper ? { CONSOLE_CLI_GATE: join(dir, 'cli-release') } : {};
  const pyEnv = { FAKE_PY_STATE: files.py, FAKE_PY_LOG: join(dir, 'py.log'), ...cliEnv };
  const mineruCli = patientCli({ file: process.execPath, prefix: prefix(FAKE_MINERU), env: { FAKE_MINERU_STATE: files.mineru, FAKE_MINERU_LOG: join(dir, 'mineru.log'), ...cliEnv } });
  const hold = { pdf: false, index: false };
  const cloud = await startFakeMineru({ holdWhen: () => hold.pdf }), index = fakeIndexPort({ onIngest: async (...args) => {
    if (fakes.onIngest) await fakes.onIngest(...args); else if (hold.index) await untilAborted(...args);
  } }), fake = model(), clock = { time: 5_000_000 };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths, complete: fake.complete });
  const service = new StudyService(join(dir, 'library'), { ...managed, complete: fake.complete, coach: false, retrieval: index.port,
    marker: { install: { pythons: [patientCli({ file: process.execPath, prefix: prefix(FAKE_PYTHON), env: pyEnv })], freeMegabytes: async () => 100_000,
      venvPython: folder => patientCli({ file: process.execPath, prefix: prefix(FAKE_PYTHON), env: { ...pyEnv, FAKE_PY_VENV: venvLayout(folder).venv } }),
      markerCli: () => patientCli({ file: process.execPath, prefix: [FAKE_MARKER], env: {} }) } },
    mineru: { baseUrl: cloud.baseUrl, now: () => clock.time, sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 10)); },
      local: { cli: mineruCli, home: join(dir, 'mineru-home'), modelsCli: patientCli({ ...mineruCli }) } } });
  t.after(async () => {
    if (fakes.cliWrapper) await writeFile(join(dir, 'cli-release'), 'release');
    fakes.release?.();
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose(); await cloud.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = (action, args) => service.call(action, args);
  await call('mineru.settings.set', { token: cloud.token, acknowledge: true });
  await service.store.update(state => {
    state.decks.push({ id: 'd', title: course, course, cards: Array.from({ length: 40 }, (_, i) => ({ id: `d-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`, prompt: `题目 ${i}`,
      answer: '正确答案', explanation: '先核对条件。', options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }] })) });
  });
  await answer(service, 10);
  const book = Array.from({ length: 4 }, (_, i) => `<!-- page: ${i + 1} -->\nOS 第 ${i + 1} 页讲进程。`).join('\n\n');
  await call('materials.document.import', { dataBase64: Buffer.from(book, 'utf8').toString('base64'), filename: 'OS.md', courses: ['OS'] });
  const upload = async pages => {
    const bytes = await makePdf({ pages }), { uploadId, chunkBytes } = await call('mineru.upload.start', { name: `Book${pages}.pdf`, size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  const jobs = async () => (await call('snapshot')).jobs;
  return { dir, service, call, cloud, index, fake, jobs, upload, hold, files, pilot: managed.runtimePilot, ledger: () => usageLedger(join(dir, 'library')),
    ended: (id, what) => until(async () => { const job = (await jobs()).find(item => item.id === id); return job && !still(job) && job; }, what || `job ${id} to end`, { timeoutMs: 240_000 }) };
}
