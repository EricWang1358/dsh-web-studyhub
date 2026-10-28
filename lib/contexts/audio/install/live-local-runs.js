import { LIVE_LOCAL, createLiveLocalInstaller, effectiveLiveLocal, installSizes, platformKey } from '../../../live-local-install.js';
import { LIVE_LOCAL_JOB_TEXT, LIVE_LOCAL_STAGE_NAMES } from '../../../live-local-install-text.js';
import { LocalTiers, loopbackFactory } from '../../../live-local.js';
import { installRow } from '../install-row.js';

/* The local live engine of this library's context (lib/live-local-install.js, lib/live-local.js): its one-click install as live.local.* actions, shown in
   the task console through the same legacy row as the MinerU and Marker installs, and what live.start needs from it. `ports.worker.liveLocal` is
   a seam of tests and previews: { install: <installer seams>, engine: { enginePath, modelDir } | null (stands in for the installed engine), timing }. */

const END = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed' });
const stageText = phase => (END[phase] ? LIVE_LOCAL_JOB_TEXT[END[phase]]
  : LIVE_LOCAL_JOB_TEXT.stage(Math.max(1, LIVE_LOCAL.stages.indexOf(phase) + 1), LIVE_LOCAL_STAGE_NAMES[phase] || LIVE_LOCAL_STAGE_NAMES.engine));
const MB = 1_048_576;

export function liveLocalOf(ports) {
  const seams = () => ports.worker.liveLocal || {};
  const installSeams = () => seams().install || {};
  // A class on the local engine is running: the engine's files are in use, so it is not removed under it.
  const liveRunning = () => { const session = ports.worker.sessions.activeSession(ports.state.root); return !!session?.active && session.tiers?.nativeChinese === true; };
  const row = installRow(ports, { tool: 'live-local', label: LIVE_LOCAL_JOB_TEXT.title, total: LIVE_LOCAL.stages.length,
    stageOf: state => stageText(END[state.status] ? state.status : state.stage), stages: LIVE_LOCAL.stages, nameOf: id => LIVE_LOCAL_STAGE_NAMES[id] });
  const installer = createLiveLocalInstaller({ liveRunning, row, ...installSeams() });
  const here = () => ({ platform: installSeams().platform || process.platform, arch: installSeams().arch || process.arch });
  const pins = () => ({ ...LIVE_LOCAL, ...(installSeams().pins || {}) });

  /** The installed engine live.start runs, or null. */
  const engine = async () => ('engine' in seams() ? seams().engine : effectiveLiveLocal({ seams: installSeams(), platform: here().platform }));
  /** For the pre-flight and the cards: { supported, ready } (and the rest in live.local.status). */
  const readiness = async () => ({ supported: !!pins().platforms[platformKey(here().platform, here().arch)], ready: !!(await engine()) });
  /** The tiers and the socket of a class on the local engine. */
  const session = async () => {
    const found = await engine();
    return { tiers: new LocalTiers(), WebSocketImpl: loopbackFactory({ enginePath: found.enginePath, modelDir: found.modelDir, timing: seams().timing || {} }) };
  };

  async function status() {
    const [install, ready] = await Promise.all([installer.status(), readiness()]);
    const key = platformKey(here().platform, here().arch), sizes = installSizes({ ...here(), seams: installSeams() });
    return { ...install, supported: ready.supported, ready: ready.ready, tested: LIVE_LOCAL.tested.includes(key), engineVersion: pins().engineVersion,
      downloadMb: Math.round(sizes.download / MB), diskMb: Math.round(sizes.disk / MB),
      modelMb: Math.round((pins().model.find(pin => pin.name === 'model.int8.onnx')?.bytes || 0) / MB) };
  }

  const handlers = {
    /** What the engine is here: the install's state, whether this computer is supported, whether a class can use it now, and the honest sizes. */
    'live.local.status': () => status(),
    /** What a one-click install would do here (read-only): the folder, the free space, the files and where they go. */
    'live.local.plan': a => installer.plan(a || {}),
    /** Start (or continue, or repair) the install after the learner's click (`confirm: true`); the progress is polled with live.local.status. */
    'live.local.install': async a => { await installer.start(a || {}); return status(); },
    'live.local.cancel': async () => { await installer.cancel(); return status(); },
    'live.local.uninstall': async a => {
      const removed = await installer.uninstall(a || {});
      return { ...(await status()), removed: removed.removed, removedFolders: removed.removedFolders };
    },
  };
  return { handlers, engine, readiness, session };
}
