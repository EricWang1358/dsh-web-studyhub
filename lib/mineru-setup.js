import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOCAL, LOCAL_MESSAGES, LocalMineruError, detectLocal, runCli } from './mineru-local.js';
import { SETUP_TEXT } from './mineru-setup-text.js';

/* Setting up the local mineru: start its service, download the models of a tier, write the tier and the managed mode into its own settings and
   restart it so they apply. It only ever starts after the learner confirmed the download (docs/plans/unified-job-runtime/s5-4-mineru-setup.md).
   `prepareSetup` is everything that is checked before any step runs; `runSetup` is the steps. The caller decides how a step runs (directly, or as an
   observed call of a Job) and where its progress goes. */

export const MINERU_SETUP = Object.freeze({
  /** The tiers that have models to set up: the ones LOCAL sizes. */
  tiers: Object.freeze(Object.keys(LOCAL.modelsMb)),
  defaultTier: 'basic',
  /** The steps that change the learner's mineru (models, settings): their order matters, so a Job never replays one blindly. */
  mutatingSteps: Object.freeze(['download', 'configure']),
  timeoutMs: Object.freeze({ default: 60_000, start: 90_000, download: 90 * 60_000 }),
  /** Tier and mode the setup writes into the mineru settings. */
  settings: Object.freeze({ tierKey: 'parse_server.local.managed_tier', modeKey: 'parse_server.local.mode', mode: 'managed' }),
  lastLineLength: 160,
  reasonLength: 240,
});

const tidy = text => String(text).replace(/\s+/gu, ' ').trim().slice(0, MINERU_SETUP.reasonLength);

/** The program that downloads the models, next to the mineru command (`modelsCli` stands in for it in tests). */
export function downloaderOf(cli, modelsCli) {
  if (modelsCli) return modelsCli;
  const name = process.platform === 'win32' ? 'mineru-models-download.exe' : 'mineru-models-download';
  const file = cli?.file ? join(dirname(cli.file), name) : '';
  return file && existsSync(file) ? { file, prefix: [], env: cli.env || {} } : null;
}
const modelsReady = (found, tier) => !!found.modelsDownloaded && found.tier === tier;

/** The request itself, before anything is read from the computer: the tier and the learner's confirmation. Resolves the tier. */
export function checkSetupRequest(args) {
  const tier = args?.tier ?? MINERU_SETUP.defaultTier;
  if (!MINERU_SETUP.tiers.includes(tier)) throw new LocalMineruError('bad-tier', LOCAL_MESSAGES.badTier);
  if (args?.confirm !== true) throw new Error(SETUP_TEXT.needConfirm(LOCAL.modelsMb[tier]));
  return tier;
}

/** What the setup needs to know about this computer (read-only: mineru is looked at, nothing is changed). Plain data, so it can be a Job's input.
 * Refuses when mineru is not there or the models cannot be downloaded. `seams` are { cli, home, modelsCli }. */
export async function prepareSetup(tier, { cli, home, modelsCli }) {
  if (!cli) throw new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled);
  const found = await detectLocal({ cli, home });
  // The CLI answers `config` only through its running service, so a stopped one is started first (the learner just confirmed the setup).
  const mustStart = found.state === 'server-stopped', ready = modelsReady(found, tier), download = !ready && !!downloaderOf(cli, modelsCli);
  if (!mustStart && !ready && !download) throw new LocalMineruError('no-downloader', LOCAL_MESSAGES.noDownloader);
  return { confirm: true, tier, mustStart, ready, modelsMb: LOCAL.modelsMb[tier], step: mustStart ? 'start' : download ? 'download' : 'configure' };
}

/** The steps, in order. `observe(kind, work, { sideEffect })` runs one piece of work that starts a process; `onStep(name)` and `onLine(text)` report progress.
 * Resolves the local mineru as it is afterwards; a step that fails rejects with the sentence the learner reads. */
export async function runSetup(prepared, { cli, home, modelsCli }, { signal, observe, onStep, onLine }) {
  const { tier } = prepared, { settings, timeoutMs } = MINERU_SETUP;
  const step = async (name, program, args, limit = timeoutMs.default) => {
    onStep(name);
    const result = await observe(name, runSignal => runCli(program, args, { signal: runSignal, timeoutMs: limit, onLine: line => onLine(line.slice(0, MINERU_SETUP.lastLineLength)) }),
      { sideEffect: MINERU_SETUP.mutatingSteps.includes(name) });
    if (result.code !== 0) throw new Error(SETUP_TEXT.stepFailed(name, tidy(result.stderr || result.stdout) || SETUP_TEXT.noReason));
  };
  const detect = () => observe('detect', runSignal => detectLocal({ cli, home, signal: runSignal }), { sideEffect: false });
  let ready = prepared.ready;
  if (prepared.mustStart) {
    await step('start', cli, ['server', 'start'], timeoutMs.start);
    const found = await detect();
    if (found.state !== 'ready' && found.state !== 'needs-models') throw new Error(found.state === 'unknown' ? LOCAL_MESSAGES.unreadable : LOCAL_MESSAGES.serverStopped);
    ready = modelsReady(found, tier);
  }
  const downloader = ready ? null : downloaderOf(cli, modelsCli);
  if (!downloader && !ready) throw new LocalMineruError('no-downloader', LOCAL_MESSAGES.noDownloader);
  if (downloader) await step('download', downloader, ['--tier', tier], timeoutMs.download);
  await step('configure', cli, ['config', 'set', settings.tierKey, tier]);
  await step('configure', cli, ['config', 'set', settings.modeKey, settings.mode]);
  await step('start', cli, ['server', 'restart'], timeoutMs.start);
  signal?.throwIfAborted();
  return detect();
}
