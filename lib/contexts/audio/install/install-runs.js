import { ACTIVE_STATUSES } from '../local-process-job.js';

/** The pilot switch's one reader for an install: with `runtime.pilot[pilot]` on, `start` and `cancel` go through the Job runtime; everything else (plan,
 * status, uninstall, the stages themselves) is the installer's, unchanged. `ports.worker` is the audio worker. `failure(error)` turns a runtime refusal into
 * the tool's own error (a missing session: 'needs-session'). */
export function installerFor(ports, installer, { pilot, kind, failure }) {
  const { runtimePilot, runtimeJobs: jobs, runtimeBinding } = ports.worker;
  if (runtimePilot?.[pilot] !== true || !jobs) return installer;
  const active = () => jobs.list().find(job => job.kind === kind && ACTIVE_STATUSES.includes(job.status));
  return Object.freeze({ ...installer,
    async start(args) {
      const prepared = await installer.prepare(args), admitted = Promise.withResolvers();
      let submitted;
      try { submitted = await jobs.submit(kind, prepared, {}, { ...runtimeBinding(), installer, admitted: admitted.resolve }); }
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

/** Is the pilot of this install on (then the Job shows it in the console, and no legacy row is drawn)? */
export const installPilotOn = (ports, pilot) => ports.worker.runtimePilot?.[pilot] === true && !!ports.worker.runtimeJobs;
