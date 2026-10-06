import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../../lib/service.js';
import { venvLayout } from '../../lib/marker-install.js';
import { managedRuntimeOptions } from './runtime-switch.mjs';
import { patientCli, until } from './wait.mjs';

/* The Marker install through a real service, with a fake python and a fake Marker; nothing is downloaded. */

const FAKE_PYTHON = fileURLToPath(new URL('./fake-python.mjs', import.meta.url));
const FAKE_MARKER = fileURLToPath(new URL('./fake-marker-cli.mjs', import.meta.url));
export const INSTALL_KIND = 'marker-install';

export async function harness(t, py = {}, { runtime = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-marker-install-')), before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const statePath = join(dir, 'py.json'), log = join(dir, 'py-log.jsonl');
  await writeFile(statePath, JSON.stringify(py)); await writeFile(log, '');
  const env = { FAKE_PY_STATE: statePath, FAKE_PY_LOG: log };
  const install = { pythons: [patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env })], freeMegabytes: async () => 100_000,
    venvPython: folder => patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env: { ...env, FAKE_PY_VENV: venvLayout(folder).venv } }),
    markerCli: () => patientCli({ file: process.execPath, prefix: [FAKE_MARKER], env: {} }) };
  const { starts: _starts, ...options } = managedRuntimeOptions({ paths: ['markerInstall'] });
  const service = new StudyService(join(dir, 'library'), { marker: { install }, ...options, ...runtime });
  t.after(async () => {
    await service.call('marker.install.cancel').catch(() => {});
    await until(async () => (await service.call('marker.install.status')).status !== 'running', 'the install to end', { timeoutMs: 240_000 }).catch(() => {});
    await service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const jobs = async () => (await service.call('snapshot')).jobs.filter(job => job.type === INSTALL_KIND);
  return { dir, service, call: (name, args) => service.call(name, args), jobs, setPy: patch => writeFile(statePath, JSON.stringify(patch)),
    pyLog: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    ended: status => until(async () => { const view = await service.call('marker.install.status'); return view.status === status && view; }, `the install to be ${status}`, { timeoutMs: 240_000 }) };
}
