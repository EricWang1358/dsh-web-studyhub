import { MINERU_INSTALL, MINERU_SPEC } from '../../../mineru-install.js';
import { MINERU_INSTALL_JOB_TEXT, MINERU_INSTALL_MESSAGES, MINERU_STAGE_NAMES } from '../../../mineru-install-text.js';
import { InstallError, resolveInstallFolder } from '../../../tool-install.js';
import { installDefinition } from './install-job.js';
import { installPresenter } from './install-view.js';

export const MINERU_INSTALL_KIND = 'mineru-install';
const END_TEXT = Object.freeze({ done: MINERU_INSTALL_JOB_TEXT.done, cancelled: MINERU_INSTALL_JOB_TEXT.cancelled, failed: MINERU_INSTALL_JOB_TEXT.failed });

/** The words of a stage of the MinerU install as the console and the legacy row show them (step n of 6 and its name), or how it ended. */
export const mineruStageText = phase => END_TEXT[phase]
  ?? MINERU_INSTALL_JOB_TEXT.stage(Math.max(1, MINERU_INSTALL.stages.indexOf(phase) + 1), MINERU_STAGE_NAMES[phase] || MINERU_STAGE_NAMES.tools);

/** The kernel's presentation reader for one MinerU install. */
export const presentMineruInstall = installPresenter({ stages: MINERU_INSTALL.stages, title: MINERU_INSTALL_JOB_TEXT.title, codePrefix: 'mineru.install',
  stageText: phase => mineruStageText(phase), nameOf: phase => MINERU_STAGE_NAMES[phase],
  detailOf: (state, phase) => ({ stage: phase, stages: [...MINERU_INSTALL.stages], done: [...(state.done || [])], folder: state.folder, tier: state.tier,
    source: state.source?.id, lastLine: state.lastLine }) });

/** The MinerU install as a Job (runtime.pilot.mineruInstall): ./install-job.js with MinerU's words. */
export const mineruInstallDefinition = installDefinition({ kind: MINERU_INSTALL_KIND, title: 'Local MinerU install', feature: 'mineru',
  error: (code, message) => new InstallError(code, message), messages: MINERU_INSTALL_MESSAGES,
  resolveFolder: folder => resolveInstallFolder(folder, { spec: MINERU_SPEC, defaultFolder: folder }), present: presentMineruInstall });
