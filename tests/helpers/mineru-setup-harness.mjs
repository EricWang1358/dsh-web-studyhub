import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { patientCli, readJsonFile, until, writeJsonFile } from './wait.mjs';

/* The local MinerU setup through a real service, with a fake mineru command; nothing is downloaded. */

const FAKE = fileURLToPath(new URL('./fake-mineru-cli.mjs', import.meta.url));
export const SETUP_KIND = 'mineru-setup';
export const FRESH = { mode: 'disabled', tier: 'flash', running: false, modelsReady: false };

export async function harness(t, { state = {}, noCli = false, runtime = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-setup-home-')), root = await mkdtemp(join(tmpdir(), 'runtime-setup-lib-')), work = await mkdtemp(join(tmpdir(), 'runtime-setup-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 120, modelsReady: true, ...state })); await writeFile(logPath, '');
  const env = { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: ['mineruSetup'] });
  const service = new StudyService(root, { ...managed, ...runtime, mineru: { local: { cli: noCli ? null : patientCli({ file: process.execPath, prefix: [FAKE], env }), home: work,
    modelsCli: patientCli({ file: process.execPath, prefix: [FAKE], env }) } } });
  t.after(async () => {
    await service.call('mineru.local.setup.cancel').catch(() => {});
    await until(async () => (await service.call('mineru.local.setup.status')).status !== 'running', 'the setup to end', { timeoutMs: 120_000 }).catch(() => {});
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const log = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { service, call: (name, args) => service.call(name, args), log, calls: async () => (await log()).map(entry => entry.argv.join(' ')),
    set: async patch => writeJsonFile(statePath, { ...await readJsonFile(statePath), ...patch }), state: () => readJsonFile(statePath),
    jobs: async () => (await service.call('snapshot')).jobs.filter(job => job.type === SETUP_KIND),
    ended: status => until(async () => { const run = await service.call('mineru.local.setup.status'); return run.status === status && run; }, `the setup to be ${status}`, { timeoutMs: 120_000 }) };
}
