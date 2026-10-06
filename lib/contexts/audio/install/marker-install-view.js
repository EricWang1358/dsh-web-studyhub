import { MARKER_INSTALL } from '../../../marker-install.js';
import { INSTALL_JOB_TEXT } from '../../../marker-install-text.js';

export const INSTALL_KIND = 'marker-install';
const END_PHASE = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed', interrupted: 'failed' });

/** The kernel's presentation reader for one install. `run` is the install slot's live run: its state is what the learner sees, from the same place the Settings page polls. */
export function presentInstall(run) {
  const total = MARKER_INSTALL.stages.length;
  return observed => {
    const { state } = run, phase = END_PHASE[observed.status] || state.stage, done = observed.status === 'complete' ? total : Math.max(0, MARKER_INSTALL.stages.indexOf(phase));
    return { title: INSTALL_JOB_TEXT.title,
      stage: { code: `marker.install.${phase}`, text: INSTALL_JOB_TEXT.stage[phase] },
      progress: { done, total, unit: 'stages', percent: Math.floor(done * 100 / total), segments: [] },
      detail: { install: { stage: phase, stages: [...MARKER_INSTALL.stages], folder: state.folder, mirror: state.mirror, lastLine: state.lastLine } } };
  };
}
