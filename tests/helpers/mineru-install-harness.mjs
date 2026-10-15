import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeIndex } from './fake-index-server.mjs';
import { patientCli, readJsonFile, writeJsonFile } from './wait.mjs';

/* The one-click MinerU install with no network and nothing real: a local index serves the uv wheel, a fake uv makes the venv and the programs,
   the fake mineru (tests/helpers/fake-mineru-cli.mjs) is both `mineru` and `mineru-kit`. DSH_HOME, HOME and USERPROFILE point into a temp folder,
   so `~/.mineru` would land there and the test can assert that it never does. The drives are none (the default folder is the data folder under
   DSH_HOME) unless a test gives some, and every probe of the download sources is answered here. */

const FAKE_UV = fileURLToPath(new URL('./fake-uv.mjs', import.meta.url));
const FAKE_MINERU = fileURLToPath(new URL('./fake-mineru-cli.mjs', import.meta.url));
const FAKE_PYTHON = fileURLToPath(new URL('./fake-python.mjs', import.meta.url));
export const ALL_REACHABLE = { mainland: [1, 2, 3].map(index => ({ url: `m${index}`, ok: true, ms: 100 })), global: [1, 2, 3].map(index => ({ url: `g${index}`, ok: true, ms: 100 })) };

export async function installHarness(t, { uv = {}, mineru = {}, free = 100_000, drives = [], extra = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mineru-install-'));
  const before = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MINERU_BIN: process.env.MINERU_BIN, MINERU_HOME: process.env.MINERU_HOME };
  const user = join(dir, 'user');
  await mkdir(user, { recursive: true });
  process.env.DSH_HOME = join(dir, 'home'); process.env.HOME = user; process.env.USERPROFILE = user;
  delete process.env.MINERU_BIN; delete process.env.MINERU_HOME;
  const index = await startFakeIndex();
  const uvState = join(dir, 'uv-state.json'), uvLog = join(dir, 'uv-log.jsonl'), mineruState = join(dir, 'mineru-state.json'), mineruLog = join(dir, 'mineru-log.jsonl'), pyState = join(dir, 'py-state.json');
  await writeFile(uvState, JSON.stringify(uv)); await writeFile(uvLog, '');
  await writeFile(mineruState, JSON.stringify({ version: '4.0.12', mode: 'disabled', tier: 'flash', running: false, total: 120, modelsReady: false, ...mineru })); await writeFile(mineruLog, '');
  await writeFile(pyState, JSON.stringify({ version: '3.12.15' }));
  const cli = (prefix, env) => patientCli({ file: process.execPath, prefix: [prefix], env });
  const mineruEnvOf = { FAKE_MINERU_STATE: mineruState, FAKE_MINERU_LOG: mineruLog };
  const seams = {
    sources: index.sources, probe: async () => ALL_REACHABLE, drives: async () => seams.driveList, driveList: drives, freeMegabytes: async () => seams.free, free,
    pythons: [], external: null, ramMb: 16 * 1024, checkPauseMs: 30,
    uvCli: () => cli(FAKE_UV, { FAKE_UV_STATE: uvState, FAKE_UV_LOG: uvLog }),
    venvPython: () => cli(FAKE_PYTHON, { FAKE_PY_STATE: pyState }),
    mineruCli: () => cli(FAKE_MINERU, mineruEnvOf), kitCli: () => cli(FAKE_MINERU, mineruEnvOf),
    ...extra,
  };
  t.after(async () => {
    await index.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const lines = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { dir, user, index, seams, mineruEnv: mineruEnvOf, location: join(dir, 'Tools', 'StudyHub', 'MinerU'),
    uvLog: () => lines(uvLog), mineruLog: () => lines(mineruLog),
    setUv: patch => writeJsonFile(uvState, patch), setMineru: async patch => writeJsonFile(mineruState, { ...await readJsonFile(mineruState), ...patch }), mineruState: () => readJsonFile(mineruState),
    noUserMineru: async () => !(await stat(join(user, '.mineru')).then(() => true, () => false)) };
}
