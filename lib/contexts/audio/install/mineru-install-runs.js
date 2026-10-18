import { MINERU_INSTALL } from '../../../mineru-install.js';
import { MINERU_INSTALL_JOB_TEXT, MINERU_INSTALL_MESSAGES, MINERU_STAGE_NAMES } from '../../../mineru-install-text.js';
import { InstallError } from '../../../tool-install.js';
import { installPilotOn, installerFor } from './install-runs.js';
import { installRow } from '../install-row.js';
import { MINERU_INSTALL_KIND, mineruStageText } from './mineru-install-job.js';

const failure = error => (error?.code === 'executor-unavailable' ? new InstallError('needs-session', MINERU_INSTALL_MESSAGES.needsSession)
  : error instanceof InstallError ? error : Object.assign(new InstallError(error?.code || 'install-failed', String(error?.message || error)), { cause: error }));
const END = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed' });

/** The MinerU installer of this library's context. With runtime.pilot.mineruInstall on, the install is a Job (the console shows the Job); otherwise the
 *  original background run, shown in the console through a legacy row. `make(seams)` builds the installer with the extra seams (the row). */
export function mineruInstallerFor(ports, make) {
  if (installPilotOn(ports, 'mineruInstall')) return installerFor(ports, make({}), { pilot: 'mineruInstall', kind: MINERU_INSTALL_KIND, failure });
  const row = installRow(ports, { tool: 'mineru', label: MINERU_INSTALL_JOB_TEXT.title, total: MINERU_INSTALL.stages.length,
    stageOf: state => mineruStageText(END[state.status] || state.stage), stages: MINERU_INSTALL.stages, nameOf: id => MINERU_STAGE_NAMES[id] });
  return make({ row });
}
