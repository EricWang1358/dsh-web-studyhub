import { MARKER_INSTALL, MarkerInstallError } from '../../../marker-install.js';
import { INSTALL_JOB_TEXT } from '../../../marker-install-text.js';
import { installPilotOn, installerFor } from './install-runs.js';
import { installRow } from '../install-row.js';
import { INSTALL_KIND } from './marker-install-view.js';

const failure = error => (error?.code === 'executor-unavailable' ? new MarkerInstallError('needs-session', INSTALL_JOB_TEXT.needsSession)
  : error instanceof MarkerInstallError ? error : Object.assign(new MarkerInstallError(error?.code || 'install-failed', String(error?.message || error)), { cause: error }));
const END = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed' });

/** The pilot switch's one reader for the Marker install (runtime.pilot.markerInstall): ./install-runs.js with Marker's job. */
export const markerInstallerFor = (ports, installer) => installerFor(ports, installer, { pilot: 'markerInstall', kind: INSTALL_KIND, failure });

/** The Marker installer of this library's context: a Job with the pilot on; otherwise the original background run, shown in the task console through the
 *  same legacy row as the MinerU install (its label is INSTALL_JOB_TEXT.title). `make(seams)` builds the installer with the extra seams (the row). */
export function markerInstallerOf(ports, make) {
  if (installPilotOn(ports, 'markerInstall')) return markerInstallerFor(ports, make({}));
  const row = installRow(ports, { tool: 'marker', label: INSTALL_JOB_TEXT.title, total: MARKER_INSTALL.stages.length,
    stageOf: state => INSTALL_JOB_TEXT.stage[END[state.status] || state.stage] || INSTALL_JOB_TEXT.title, stages: MARKER_INSTALL.stages, nameOf: id => INSTALL_JOB_TEXT.stage[id] });
  return make({ row });
}
