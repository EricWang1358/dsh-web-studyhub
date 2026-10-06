import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { startFakeMineru } from './fake-mineru.mjs';
import { makePdf } from './pdf.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { patientCli, until } from './wait.mjs';

/* PDF conversion on the runtime through a real service: the cloud with a fake MinerU server, the local route with a fake mineru command. Nothing leaves the machine. */

export const PDF_KIND = 'pdf-convert';
export const filesUnder = async directory => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path)); else found.push(path);
  }
  return found;
};

export async function harness(t, { serverOptions = {}, runtime = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-pdf-home-')), root = await mkdtemp(join(tmpdir(), 'runtime-pdf-lib-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY;
  const fake = await startFakeMineru(serverOptions), clock = { time: 5_000_000 };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: runtime ? ['pdfConvert'] : [] });
  const service = new StudyService(root, { ...(runtime ? managed : {}), mineru: { baseUrl: fake.baseUrl, now: () => clock.time,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 15)); } } });
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose(); await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = (action, args) => service.call(action, args);
  const upload = async (bytes, name = 'Book.pdf') => {
    const { uploadId, chunkBytes } = await call('mineru.upload.start', { name, size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  const jobs = async () => (await call('snapshot')).jobs.filter(job => job.type === PDF_KIND);
  await call('mineru.settings.set', { token: fake.token, acknowledge: true });
  return { home, root, fake, service, call, upload, jobs, settled: id => until(async () => { const job = (await jobs()).find(item => item.id === id); return job && !['queued', 'running', 'cancelling'].includes(job.status) && job; }, 'the job to settle'),
    start: async (pages = 450, args = {}) => call('mineru.import', { uploadId: await upload(await makePdf({ pages })), ...args }) };
}

export async function localHarness(t, state = {}, { parseWindow } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-pdf-local-home-')), root = await mkdtemp(join(tmpdir(), 'runtime-pdf-local-lib-')), work = await mkdtemp(join(tmpdir(), 'runtime-pdf-local-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 120, modelsReady: true, ...state })); await writeFile(logPath, '');
  const fake = fileURLToPath(new URL('./fake-mineru-cli.mjs', import.meta.url)), cli = patientCli({ file: process.execPath, prefix: [fake], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: ['pdfConvert'] });
  const service = new StudyService(root, { ...managed, mineru: { limits: { windowPages: 50 }, local: { cli, home: work, ...(parseWindow ? { parseWindow } : {}) } } });
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const log = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const jobs = async () => (await service.call('snapshot')).jobs.filter(job => job.type === PDF_KIND);
  const bytes = await makePdf({ pages: 120 });
  const upload = async () => {
    const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await service.call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  return { service, jobs, parses: async () => (await log()).filter(entry => entry.argv[0] === 'parse'),
    upload, start: async (uploadId) => service.call('mineru.import', { uploadId: uploadId ?? await upload(), route: 'local' }) };
}
