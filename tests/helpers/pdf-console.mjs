import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../../lib/service.js';
import { startFakeMineru } from './fake-mineru.mjs';
import { makePdf } from './pdf.mjs';
import { managedRuntimeOptions } from './runtime-switch.mjs';

/* A PDF conversion service for the console regression (S6-5): the cloud route against a fake MinerU on a loopback port, with a switch the test can flip and a conversion that
   stays pending until the test lets it finish. Nothing leaves the machine. */
export async function pdfConsole(t) {
  const home = await mkdtemp(join(tmpdir(), 'console-pdf-home-')), root = await mkdtemp(join(tmpdir(), 'console-pdf-lib-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY;
  const state = { holding: true }, clock = { time: 5_000_000 };
  const fake = await startFakeMineru({ holdWhen: () => state.holding });
  const pilot = {}, { starts: _starts, runtimePilot: _fixed, ...managed } = managedRuntimeOptions({ paths: [] });
  const service = new StudyService(root, { ...managed, runtimePilot: pilot, mineru: { baseUrl: fake.baseUrl, now: () => clock.time,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); clock.time += ms; await new Promise(resolve => setTimeout(resolve, 15)); } } });
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await service.dispose(); await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const call = (action, args) => service.call(action, args);
  await call('mineru.settings.set', { token: fake.token, acknowledge: true });
  const upload = async bytes => {
    const { uploadId, chunkBytes } = await call('mineru.upload.start', { name: 'Book.pdf', size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) await call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
    await call('mineru.upload.finish', { uploadId });
    return uploadId;
  };
  return { service, call, root, fake, pilot, set: value => { pilot.pdfConvert = value; }, release: () => { state.holding = false; },
    start: async (pages = 30, args = {}) => call('mineru.import', { uploadId: await upload(await makePdf({ pages })), ...args }) };
}
