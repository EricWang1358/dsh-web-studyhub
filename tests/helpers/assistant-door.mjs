import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostHandler } from '../../lib/host.js';
import { makePdf } from './pdf.mjs';

/* The two doors into one isolated StudyHub: the assistant's study_workspace tool (lib/index.js runStudyTool, over a fake DSH host) and the
   learner's panel (lib/host.js createHostHandler, which Settings uses). Everything the run could reach is private: DSH_HOME, the user's home
   (so ~/.dsh, ~/.mineru and ~/.local/bin are folders of this run), TEMP, PATH (no real marker_single or mineru can be found) and MINERU_HOME;
   credential variables are removed and SSH_TTY=audit keeps any folder picker in the browser. Programs are the Node binary with
   tests/helpers/spawn-probe.cjs preloaded: `program` is an absolute path that really runs, and `spawns()` lists every start of it.
   MINERU_BIN names that same binary, so a local MinerU is "installed" and answers from the fake MinerU state (`mineru`, written as given). */

const PROBE = fileURLToPath(new URL('./spawn-probe.cjs', import.meta.url));
const CREDENTIAL = /(_API_KEY|_TOKEN|_SECRET|BASE_URL)$/i;
const lines = async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));

export async function assistantDoors(t, { mineru = { version: '4.0.10', total: 3, running: true, mode: 'disabled', tier: 'basic', modelsReady: true } } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'assistant-doors-'));
  const dirs = Object.fromEntries(['dshHome', 'user', 'temp', 'bin', 'mineruHome', 'work', 'fake'].map(name => [name, join(base, name)]));
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  // A basic-tier model folder, so a local setup would go straight to switching MinerU's managed mode on.
  await mkdir(join(dirs.mineruHome, 'models', 'MinerU-4_models_onnx'), { recursive: true });
  const files = { spawns: join(dirs.fake, 'spawns.jsonl'), mineruState: join(dirs.fake, 'mineru.json'), mineruLog: join(dirs.fake, 'mineru.jsonl'),
    markerState: join(dirs.fake, 'marker.json'), markerLog: join(dirs.fake, 'marker.jsonl'), pdf: join(dirs.work, 'Book.pdf') };
  await writeFile(files.mineruState, JSON.stringify(mineru));
  await writeFile(files.markerState, '{}');
  for (const file of [files.spawns, files.mineruLog, files.markerLog]) await writeFile(file, '');
  await writeFile(files.pdf, await makePdf({ pages: 3 }));

  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (CREDENTIAL.test(key)) delete process.env[key];
  for (const key of ['MARKER_BIN', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) delete process.env[key];
  Object.assign(process.env, {
    DSH_HOME: dirs.dshHome, HOME: dirs.user, USERPROFILE: dirs.user, TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp, SSH_TTY: 'audit',
    PATH: dirs.bin, MINERU_HOME: dirs.mineruHome, MINERU_BIN: process.execPath,
    NODE_OPTIONS: `--require ${PROBE}`, SPAWN_PROBE_LOG: files.spawns,
    FAKE_MINERU_STATE: files.mineruState, FAKE_MINERU_LOG: files.mineruLog, FAKE_MARKER_STATE: files.markerState, FAKE_MARKER_LOG: files.markerLog,
  });
  if (process.env.Path !== undefined) process.env.Path = dirs.bin;

  const plugin = await import('../../lib/index.js');
  const tools = [];
  const ctx = { tools: { register: tool => tools.push(tool) }, commands: { register: () => {} }, llm: {}, systemPrompt: { section: () => {} }, sessions: { get: () => undefined },
    get: name => name === 'connection' ? { fetch: { register: () => () => {} } } : undefined, inject: (_dependencies, fn) => fn(ctx), effect: fn => fn() };
  await plugin.apply(ctx, {});
  const workspace = tools.find(tool => tool.name === 'study_workspace');
  const agent = { id: 'assistant', session: { header: { cwd: dirs.work } } };
  const disposers = [];
  const handle = createHostHandler({ sessions: { get: () => ({ header: { cwd: dirs.work } }) }, get: () => undefined, effect: setup => { disposers.push(setup()); } }, { libraryRoot: join(dirs.work, 'panel-library') });

  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose?.();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    dirs, files, tools, program: process.execPath,
    /** The assistant's door: arguments travel as payload_json, the way the model sends them. */
    assistant: (action, args) => workspace.execute({ action, ...(args === undefined ? {} : { payload_json: JSON.stringify(args) }) }, { agent }),
    assistantRaw: (action, payload_json) => workspace.execute({ action, payload_json }, { agent }),
    /** The learner's door (Settings and the rest of the panel). */
    panel: async (action, args = {}) => {
      const reply = await handle('call', { sessionId: 'panel', action, args });
      if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
      return reply.value;
    },
    spawns: () => lines(files.spawns),
    mineruState: async () => JSON.parse(await readFile(files.mineruState, 'utf8')),
  };
}
