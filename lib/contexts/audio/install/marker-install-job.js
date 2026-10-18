import { INSTALL_MESSAGES, MarkerInstallError, resolveInstallFolder } from '../../../marker-install.js';
import { installDefinition } from './install-job.js';
import { INSTALL_KIND, presentInstall } from './marker-install-view.js';

/** The Marker install of this DSH home (docs/plans/unified-job-runtime/s5-3-marker-install.md) as a Job: ./install-job.js with Marker's words. */
export const markerInstallDefinition = installDefinition({ kind: INSTALL_KIND, title: 'Marker install', feature: 'marker',
  error: (code, message) => new MarkerInstallError(code, message),
  messages: INSTALL_MESSAGES, resolveFolder: folder => resolveInstallFolder(folder), present: presentInstall });
