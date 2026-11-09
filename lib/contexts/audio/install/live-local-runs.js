import { LIVE_LOCAL, WHISPER_ENGINE, createLiveLocalInstaller, effectiveLiveLocal, installSizes, platformKey } from '../../../live-local-install.js';
import { LIVE_LOCAL_JOB_TEXT, LIVE_LOCAL_STAGE_NAMES } from '../../../live-local-install-text.js';
import { LocalTiers, localEngineInUse, loopbackFactory } from '../../../live-local.js';
import { installRow } from '../install-row.js';
import { DEFAULT_LOCAL_MODEL, LOCAL_MODELS, localModelOf } from '../../../live-local-models.js';
import { saveAudioSettings } from '../../../audio-settings.js';

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
  // A class on the local engine is running in any library of this process (its thread is connected), or one of this library is between connections:
  // the engine's files are in use, so it is not removed under it.
  const liveRunning = () => {
    const session = ports.worker.sessions.activeSession(ports.state.root);
    return localEngineInUse() || (!!session?.active && session.tiers?.nativeChinese === true);
  };
  const row = installRow(ports, { tool: 'live-local', label: LIVE_LOCAL_JOB_TEXT.title, total: LIVE_LOCAL.stages.length,
    stageOf: state => stageText(END[state.status] ? state.status : state.stage), stages: LIVE_LOCAL.stages, nameOf: id => LIVE_LOCAL_STAGE_NAMES[id] });
  const installer = modelId => createLiveLocalInstaller({ liveRunning, row, ...installSeams(), modelId });
  const selectedModel = async () => localModelOf((await ports.audioSettings()).liveLocalModel || DEFAULT_LOCAL_MODEL).id;
  const requestedModel = async args => localModelOf(args?.modelId ?? await selectedModel()).id;
  const here = () => ({ platform: installSeams().platform || process.platform, arch: installSeams().arch || process.arch });
  const pins = () => ({ ...LIVE_LOCAL, ...(installSeams().pins || {}) });

  /** The installed engine live.start runs, or null. */
  const engine = async modelId => {
    modelId ??= await selectedModel();
    localModelOf(modelId);
    return 'engine' in seams() ? seams().engine : effectiveLiveLocal({ seams: installSeams(), platform: here().platform, modelId });
  };
  /** For the pre-flight and the cards: { supported, ready } (and the rest in live.local.status). */
  const readiness = async () => ({ supported: !!pins().platforms[platformKey(here().platform, here().arch)], ready: !!(await engine()) });
  const readyModels = async () => Object.fromEntries(await Promise.all(LOCAL_MODELS.map(async model => [model.id, !!(await engine(model.id))])));
  /** The tiers and the socket of a class on the local engine. `timing` is what the learner's settings decide ({ minSilenceSec }, 断句停顿). */
  const session = async (timing = {}, modelId) => {
    modelId ??= await selectedModel();
    localModelOf(modelId);
    const found = await engine(modelId);
    if (!found) throw new Error('所选本地模型尚未安装，请先在本地转写卡片里安装');
    return { localModel: modelId, tiers: new LocalTiers(), WebSocketImpl: loopbackFactory({ enginePath: found.enginePath, modelDir: found.modelDir, modelId, timing: { ...timing, ...(seams().timing || {}) } }) };
  };

  async function status(args) {
    const modelId = await requestedModel(args), selectedModelId = await selectedModel();
    const [install, found] = await Promise.all([installer(modelId).status(), engine(modelId)]);
    const key = platformKey(here().platform, here().arch), sizes = installSizes({ ...here(), seams: { ...installSeams(), modelId } });
    return { ...install, modelId, selectedModelId, models: LOCAL_MODELS, supported: !!pins().platforms[key], ready: !!found,
      tested: LIVE_LOCAL.tested.includes(key), engineVersion: install.engineVersion || (modelId === 'whisper-turbo' ? WHISPER_ENGINE.engineVersion : pins().engineVersion),
      downloadMb: Math.round(sizes.download / MB), diskMb: Math.round(sizes.disk / MB),
      modelMb: localModelOf(modelId).modelMb };
  }

  const handlers = {
    /** What the engine is here: the install's state, whether this computer is supported, whether a class can use it now, and the honest sizes. */
    'live.local.status': a => status(a),
    /** What a one-click install would do here (read-only): the folder, the free space, the files and where they go. */
    'live.local.plan': async a => installer(await requestedModel(a)).plan(a || {}),
    /** Start (or continue, or repair) the install after the learner's click (`confirm: true`); the progress is polled with live.local.status. */
    'live.local.install': async a => { await installer(await requestedModel(a)).start(a || {}); return status(a); },
    'live.local.cancel': async a => { await installer(await requestedModel(a)).cancel(); return status(a); },
    'live.local.select': async a => {
      const modelId = await requestedModel(a);
      if (!(await engine(modelId))) throw new Error('所选本地模型尚未安装，请先在本地转写卡片里安装');
      await saveAudioSettings({ liveLocalModel: modelId });
      return status(a);
    },
    'live.local.uninstall': async a => {
      const removed = await installer(await requestedModel(a)).uninstall(a || {});
      return { ...(await status(a)), removed: removed.removed, removedFolders: removed.removedFolders };
    },
  };
  return { handlers, engine, readiness, readyModels, session };
}
