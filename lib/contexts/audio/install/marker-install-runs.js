import { MarkerInstallError } from '../../../marker-install.js';
import { INSTALL_JOB_TEXT } from '../../../marker-install-text.js';
import { ACTIVE_STATUSES, INSTALL_KIND } from './marker-install-view.js';

const failure = error => (error?.code === 'executor-unavailable' ? new MarkerInstallError('needs-session', INSTALL_JOB_TEXT.needsSession)
  : error instanceof MarkerInstallError ? error : Object.assign(new MarkerInstallError(error?.code || 'install-failed', String(error?.message || error)), { cause: error }));

/** The pilot switch's one reader for the Marker install: with runtime.pilot.markerInstall on, `start` and `cancel` go through the Job
 * runtime; everything else (plan, status, uninstall, the stages themselves) is the installer's, unchanged. `ports.worker` is the audio worker. */
export function markerInstallerFor(ports, installer) {
  const { runtimePilot, runtimeJobs: jobs, runtimeBinding } = ports.worker;
  if (runtimePilot?.markerInstall !== true || !jobs) return installer;
  const active = () => jobs.list().find(job => job.kind === INSTALL_KIND && ACTIVE_STATUSES.includes(job.status));
  return Object.freeze({ ...installer,
    async start(args) {
      const prepared = await installer.prepare(args), admitted = Promise.withResolvers();
      let submitted;
      try { submitted = await jobs.submit(INSTALL_KIND, prepared, {}, { ...runtimeBinding(), installer, admitted: admitted.resolve }); }
      catch (error) { throw failure(error); }
      await Promise.race([admitted.promise, jobs.wait(submitted.jobId)]);
      const { error } = jobs.status(submitted.jobId);
      if (error) throw failure(error);
      return installer.status();
    },
    async cancel() {
      const job = active();
      if (!job) return installer.cancel();
      await jobs.control(job.jobId, 'cancel');
      return installer.status();
    },
  });
}
