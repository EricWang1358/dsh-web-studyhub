import { RUN_RECORD_WINDOW_MS } from '../../../generation-limits.js';
import { closedShort } from '../../../coverage-run.js';
import { interruptedRuns } from '../coverage-runs.js';

/* What a new process does with what the last one left: the one decision, in two looks because the second must see what the first restored.
   Pure, no I/O; the caller reads and writes. Nothing is asked of a model by this, and a look over its own result finds nothing.
   The kernel decides what became of an Attempt (lib/jobs/lifecycle/recovery.js); this decides which runs are looked at. */

const LIVE = ['queued', 'running', 'pausing', 'cancelling', 'interrupted'];

/** The runs kept on disk (`generationRestart`): `{ restore, forget }`. A run that ended, is older than the window, or whose draft says the run closed leaves
 * nothing behind (the process died between that write and the last word of the job: a question run has nothing left after it, a supplement still has its publication). */
export function planRunRecovery({ runs, now, drafts }) {
  const closedDrafts = drafts.filter(({ editorial }) => editorial?.coverageRun?.state === 'complete' || closedShort(editorial?.coverageRun?.stop));
  const closed = new Set(closedDrafts.map(draft => draft.editorial.generation?.runId).filter(Boolean));
  const keep = run => LIVE.includes(run.status) && now - run.at <= RUN_RECORD_WINDOW_MS && !(run.kind === 'generation' && closed.has(run.jobId));
  return { restore: runs.filter(keep), forget: runs.filter(run => !keep(run)) };
}

/** The drafts that come back as an interrupted job (coverage-runs.js interruptedRuns says what such a draft looks like):
 * those no job of this library works on, whose job is not known and was not archived. */
export function planDraftRecovery({ drafts, jobs, archived, root }) {
  const found = interruptedRuns(drafts);
  if (!found.length) return found;
  const known = new Set(jobs.map(job => job.id)), busy = new Set(jobs.filter(job => job.root === root).map(job => job.draftId));
  // What a job of the runtime is called across its Attempts: a retry gets a new card id, and until it has presented its draft only this says whose draft it is.
  const running = new Set(jobs.map(job => job.contract?.jobId).filter(Boolean));
  return found.filter(({ draft, marker }) => {
    if (archived.has(marker.jobId) || known.has(marker.jobId) || busy.has(draft.id) || running.has(draft.editorial.generation?.runId)) return false;
    if (marker.jobId) known.add(marker.jobId);
    busy.add(draft.id);
    return true;
  });
}
