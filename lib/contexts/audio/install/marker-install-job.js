import { INSTALL_MESSAGES, MarkerInstallError, resolveInstallFolder } from '../../../marker-install.js';
import { INSTALL_KIND, presentInstall } from './marker-install-view.js';

const STEP_POLICY = Object.freeze({ purpose: 'install', feature: 'marker', budget: null });

/** Run one piece of install work as an observed local call of a Job: its own Step, `local-process`, the side effect it declares.
 * The timeouts stay the install's own (one layer): the Step carries no budget. */
export const observeWithGateway = gateway => (kind, work, { sideEffect }) => {
  const step = gateway.step(`install:${kind}`, STEP_POLICY);
  // A process that exited non-zero is a failed Call, not an ok one that happens to carry a bad code.
  return step.run(() => step.observe({ boundary: 'local-process', kind, sideEffect }, async signal => {
    const value = await work(signal);
    return { value, ...(Number.isInteger(value?.code) && value.code !== 0 ? { status: 500 } : {}) };
  }));
};

/** The Marker install of this DSH home (docs/plans/unified-job-runtime/s5-3-marker-install.md). The stages, the sentinel and the folder
 * ownership are lib/marker-install.js's own: `binding.installer` runs them, this definition only admits, observes and presents.
 * The learner starts it in Settings (the assistant cannot, lib/assistant-boundary.js); the Job offers no retry, pause or recovery, so the
 * console cannot start an install again either: a second install is a second, confirmed start. */
export const markerInstallDefinition = {
  kind: INSTALL_KIND, version: 1, title: 'Marker install',
  capabilities: { cancel: true, retry: false },

  async admit(context, input, { installer }) {
    if (input.confirm !== true) throw new MarkerInstallError('need-confirm', INSTALL_MESSAGES.needConfirm);
    // The folder must still be one the installer may use (new, empty or carrying its own sentinel), whoever asked.
    const where = await resolveInstallFolder(input.folder);
    if (where.problem || where.folder !== input.folder) throw new MarkerInstallError('folder-in-use', INSTALL_MESSAGES.folderInUse);
    const run = installer.claim(input, { signal: context.signal });
    context.present(presentInstall(run));
    return { state: run, finish: () => installer.release(run) };
  },

  async run(context, input, { installer, admitted }) {
    const run = context.admission.state;
    await installer.begin(input, run, observeWithGateway(context.gateway));
    admitted?.();
    await run.promise;
    const { status, error } = run.state;
    if (status === 'failed') throw Object.assign(new Error(error.message), { code: error.code });
    if (status === 'cancelled') throw context.signal.reason ?? new Error(error.message);
    return { refs: [], completeness: 'complete' };
  },
};
