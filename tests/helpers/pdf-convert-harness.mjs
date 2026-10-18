import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { makePdf } from './pdf.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { patientCli, readJsonFile, until, writeJsonFile } from './wait.mjs';

/* PDF conversion on the runtime through a real service, with a fake mineru command (tests/helpers/fake-mineru-cli.mjs). Nothing leaves the machine.
   `harness` converts in fixed windows of 200 pages (a 450-page book is three windows), so a test can name the window that fails or is held;
   `localHarness` in windows of 50 pages. */

export const PDF_KIND = 'pdf-convert';
const FAKE = fileURLToPath(new URL('./fake-mineru-cli.mjs', import.meta.url));
export const filesUnder = async directory => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path)); else found.push(path);
  }
  return found;
};

async function base(t, { state = {}, runtime = true, windowPages = 200, parseWindow, total = 450 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-pdf-home-')), root = await mkdtemp(join(tmpdir(), 'runtime-pdf-lib-')), work = await mkdtemp(join(tmpdir(), 'runtime-pdf-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.12', mode: 'managed', tier: 'basic', running: true, total, modelsReady: true, ...state })); await writeFile(logPath, '');
  const cli = patientCli({ file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath } });
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: runtime ? ['pdfConvert'] : [] });
  const mineru = { limits: { windowPages, livenessMs: 0 }, local: { cli, home: work, ...(parseWindow ? { parseWindow } : {}) } };
  const service = new StudyService(root, { ...(runtime ? managed : {}), mineru });
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = (action, args) => service.call(action, args);
  const log = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const upload = async (bytes, name = 'Book.pdf') => {
    const { uploadId, chunkBytes } = await call('mineru.upload.start', { name, size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  const jobs = async () => (await call('snapshot')).jobs.filter(job => job.type === PDF_KIND);
  return { home, root, work, cli, service, call, upload, jobs, log, statePath,
    parses: async () => (await log()).filter(entry => entry.argv[0] === 'parse'),
    set: async patch => writeJsonFile(statePath, { ...await readJsonFile(statePath), ...patch }),
    settled: id => until(async () => { const job = (await jobs()).find(item => item.id === id); return job && !['queued', 'running', 'cancelling'].includes(job.status) && job; }, 'the job to settle') };
}

/** The runtime (or, `runtime: false`, the original path) converting 200-page windows; `state` shapes the fake (failWindowsOnce, delayMs, finishSignal...). */
export async function harness(t, { state = {}, runtime = true } = {}) {
  const h = await base(t, { state, runtime, windowPages: 200 });
  return { ...h, start: async (pages = 450, args = {}) => { await h.set({ total: pages }); return h.call('mineru.import', { uploadId: await h.upload(await makePdf({ pages })), ...args }); } };
}

/** The runtime converting a 120-page book in 50-page windows. */
export async function localHarness(t, state = {}, { parseWindow } = {}) {
  const h = await base(t, { state, windowPages: 50, parseWindow, total: 120 });
  const bytes = await makePdf({ pages: 120 });
  return { ...h, upload: () => h.upload(bytes), start: async (uploadId) => h.call('mineru.import', { uploadId: uploadId ?? await h.upload(bytes), route: 'local' }) };
}
