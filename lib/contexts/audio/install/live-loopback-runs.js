import { LIVE_LOOPBACK, createLiveLoopbackInstaller, effectiveLiveLoopback, findWindowsCsc, loopbackPlatformKey } from '../../../live-loopback-install.js';
import { LIVE_LOOPBACK_JOB_TEXT, LIVE_LOOPBACK_MESSAGES, LIVE_LOOPBACK_STAGE_NAMES } from '../../../live-loopback-install-text.js';
import { createSystemAudioCapture, loopbackInUse } from '../../../live-loopback.js';
import { installRow } from '../install-row.js';

/* System-audio loopback helper of this library's audio context (lib/live-loopback-install.js, lib/live-loopback.js):
   exposed as live.loopback.* actions, surfaced in the task console via installRow, and consumed by live.start when audioSource === 'system'.
   `ports.worker.liveLoopback` is the seam for tests and previews: { install, helper, spawn, startupTimeoutMs }. */

const END = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed' });
const stageText = phase => (END[phase] ? LIVE_LOOPBACK_JOB_TEXT[END[phase]]
  : LIVE_LOOPBACK_JOB_TEXT.stage(Math.max(1, LIVE_LOOPBACK.stages.indexOf(phase) + 1), LIVE_LOOPBACK_STAGE_NAMES[phase] || LIVE_LOOPBACK_STAGE_NAMES.compile));

export function liveLoopbackOf(ports) {
  const seams = () => ports.worker.liveLoopback || {};
  const installSeams = () => seams().install || {};
  const liveRunning = () => {
    const session = ports.worker.sessions.activeSession(ports.state.root);
    return loopbackInUse() || (!!session?.active && session.audioSource === 'system');
  };
  const row = installRow(ports, {
    tool: 'live-loopback', label: LIVE_LOOPBACK_JOB_TEXT.title, total: LIVE_LOOPBACK.stages.length,
    stageOf: state => stageText(END[state.status] ? state.status : state.stage), stages: LIVE_LOOPBACK.stages, nameOf: id => LIVE_LOOPBACK_STAGE_NAMES[id],
  });
  const installer = createLiveLoopbackInstaller({ liveRunning, row, ...installSeams() });
  const here = () => ({
    platform: installSeams().platform || process.platform,
    osPlatform: installSeams().osPlatform || installSeams().platform || process.platform,
    arch: installSeams().arch || process.arch,
  });

  const helper = async () => ('helper' in seams() ? seams().helper : effectiveLiveLoopback({ seams: installSeams(), platform: here().platform }));
  const supported = async () => {
    const { osPlatform } = here();
    if (osPlatform !== 'win32') return false;
    return !!(await findWindowsCsc({ platform: osPlatform, seams: installSeams() }));
  };
  const readiness = async () => {
    const [canSupport, found] = await Promise.all([supported(), helper()]);
    return { supported: canSupport || !!found, ready: !!found };
  };

  async function createCapture({ onPcm, onUnexpectedError }) {
    const state = await installer.status();
    if (state.status === 'running') throw new Error(LIVE_LOOPBACK_MESSAGES.installing);
    const found = await helper();
    if (!found) throw new Error(LIVE_LOOPBACK_MESSAGES.needsInstall);
    return createSystemAudioCapture({
      resolveHelper: helper,
      onPcm,
      onUnexpectedError,
      ...(seams().spawn ? { spawnImpl: seams().spawn } : {}),
      ...(seams().startupTimeoutMs ? { startupTimeoutMs: seams().startupTimeoutMs } : {}),
    });
  }

  async function status() {
    const [install, ready] = await Promise.all([installer.status(), readiness()]);
    const key = loopbackPlatformKey(here().osPlatform, here().arch);
    return {
      ...install,
      supported: ready.supported,
      ready: ready.ready,
      tested: LIVE_LOOPBACK.tested.includes(key),
      helperVersion: LIVE_LOOPBACK.helperVersion,
      downloadMb: 0,
      diskMb: 1,
    };
  }

  const handlers = {
    'live.loopback.status': () => status(),
    'live.loopback.plan': a => installer.plan(a || {}),
    'live.loopback.install': async a => { await installer.start(a || {}); return status(); },
    'live.loopback.cancel': async () => { await installer.cancel(); return status(); },
    'live.loopback.uninstall': async a => {
      const removed = await installer.uninstall(a || {});
      return { ...(await status()), removed: removed.removed, removedFolders: removed.removedFolders };
    },
  };
  return { handlers, helper, readiness, createCapture };
}
