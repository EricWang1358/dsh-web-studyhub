import { LOCAL_MESSAGES, LocalMineruError } from '../../../mineru-local.js';
import { checkSetupRequest, prepareSetup } from '../../../mineru-setup.js';
import { SETUP_TEXT } from '../../../mineru-setup-text.js';
import { ACTIVE_STATUSES } from '../local-process-job.js';
import { createLegacySetupRuns } from './legacy-setup-run.js';
import { SETUP_KIND, setupView } from './mineru-setup-view.js';

const busy = () => new LocalMineruError('setup-busy', LOCAL_MESSAGES.setupBusy);
const failure = error => (error?.code === 'executor-unavailable' ? new LocalMineruError('setup-needs-session', SETUP_TEXT.needsSession)
  : Object.assign(error instanceof Error ? error : new Error(String(error?.message || error)), error?.code ? { code: error.code } : {}));

/** start / status / cancel of the local MinerU setup on the runtime: one setup per library, refusals before any job. */
function createJobSetupRuns({ ports, seams }) {
  const { runtimeJobs: jobs, runtimeBinding } = ports.worker;
  const mine = () => jobs.list().filter(job => job.kind === SETUP_KIND);
  const active = () => mine().find(job => ACTIVE_STATUSES.includes(job.status));
  const latest = () => active() ?? mine().at(-1);
  return Object.freeze({
    async start(args) {
      const tier = checkSetupRequest(args);
      if (active()) throw busy();
      const local = seams(), prepared = await prepareSetup(tier, local);
      if (active()) throw busy();
      const admitted = Promise.withResolvers();
      let submitted;
      try { submitted = await jobs.submit(SETUP_KIND, prepared, {}, { ...runtimeBinding(), seams: local, admitted: admitted.resolve }); }
      catch (error) { throw failure(error); }
      await Promise.race([admitted.promise, jobs.wait(submitted.jobId)]);
      const current = jobs.status(submitted.jobId);
      if (current.error) throw failure(current.error);
      return setupView(current);
    },
    async status() { const job = latest(); return job ? setupView(job) : { status: 'idle' }; },
    async cancel() {
      const job = active();
      if (job) await jobs.control(job.jobId, 'cancel');
      const current = latest();
      return current ? setupView(current) : { status: 'idle' };
    },
  });
}

/** The pilot switch's one reader for the local MinerU setup: on the runtime when runtime.pilot.mineruSetup is on, else the original background run.
 * `seams()` reads the computer when a setup starts: { cli, home, modelsCli }. */
export function mineruSetupFor(ports, seams) {
  const { runtimePilot, runtimeJobs } = ports.worker;
  return runtimePilot?.mineruSetup === true && runtimeJobs ? createJobSetupRuns({ ports, seams }) : createLegacySetupRuns({ root: ports.state.root, seams });
}
