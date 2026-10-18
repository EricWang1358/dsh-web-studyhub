import { MARKER_INSTALL } from '../../../marker-install.js';
import { INSTALL_JOB_TEXT } from '../../../marker-install-text.js';
import { installPresenter } from './install-view.js';

export const INSTALL_KIND = 'marker-install';
/** The kernel's presentation reader for one Marker install (./install-view.js with Marker's words). */
export const presentInstall = installPresenter({ stages: MARKER_INSTALL.stages, title: INSTALL_JOB_TEXT.title, codePrefix: 'marker.install',
  stageText: phase => INSTALL_JOB_TEXT.stage[phase], nameOf: phase => INSTALL_JOB_TEXT.stage[phase],
  detailOf: (state, phase) => ({ stage: phase, stages: [...MARKER_INSTALL.stages], folder: state.folder, mirror: state.mirror, lastLine: state.lastLine }) });
