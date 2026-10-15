import { MarkerInstallError } from '../../../marker-install.js';
import { INSTALL_JOB_TEXT } from '../../../marker-install-text.js';
import { installerFor } from './install-runs.js';
import { INSTALL_KIND } from './marker-install-view.js';

const failure = error => (error?.code === 'executor-unavailable' ? new MarkerInstallError('needs-session', INSTALL_JOB_TEXT.needsSession)
  : error instanceof MarkerInstallError ? error : Object.assign(new MarkerInstallError(error?.code || 'install-failed', String(error?.message || error)), { cause: error }));

/** The pilot switch's one reader for the Marker install (runtime.pilot.markerInstall): ./install-runs.js with Marker's job. */
export const markerInstallerFor = (ports, installer) => installerFor(ports, installer, { pilot: 'markerInstall', kind: INSTALL_KIND, failure });
