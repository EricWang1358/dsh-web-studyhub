import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { makePdf } from './pdf.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { patientCli } from './wait.mjs';

/* A PDF conversion service for the console regression (S6-5): the local route with the fake mineru command line, with a switch the test can flip and a conversion that
   stays pending until the test lets it finish (the fake holds every parse until a release file exists). Nothing leaves the machine. */
const FAKE = fileURLToPath(new URL('./fake-mineru-cli.mjs', import.meta.url));
export async function pdfConsole(t) {
  const home = await mkdtemp(join(tmpdir(), 'console-pdf-home-')), root = await mkdtemp(join(tmpdir(), 'console-pdf-lib-')), work = await mkdtemp(join(tmpdir(), 'console-pdf-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), release = join(work, 'release');
  await writeFile(statePath, JSON.stringify({ version: '4.0.12', mode: 'managed', tier: 'basic', running: true, modelsReady: true, totalFromPdf: true, total: 1, finishSignal: release }));
  const cli = patientCli({ file: process.execPath, prefix: [FAKE], env: { FAKE_MINERU_STATE: statePath } });
  const pilot = {}, { starts: _starts, runtimePilot: _fixed, ...managed } = managedRuntimeOptions({ paths: [] });
  const service = new StudyService(root, { ...managed, runtimePilot: pilot, mineru: { limits: { windowPages: 50, livenessMs: 0 }, local: { cli, home: work } } });
  t.after(async () => {
    await writeFile(release, 'go').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const call = (action, args) => service.call(action, args);
  const upload = async bytes => {
    const { uploadId, chunkBytes } = await call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  return { service, call, root, pilot, set: value => { pilot.pdfConvert = value; }, release: () => { void writeFile(release, 'go'); },
    start: async (pages = 30, args = {}) => call('mineru.import', { uploadId: await upload(await makePdf({ pages })), ...args }) };
}
