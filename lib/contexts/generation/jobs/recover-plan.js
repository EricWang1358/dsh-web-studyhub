import { RUN_RECORD_WINDOW_MS } from '../../../generation-limits.js';
import { interruptedRuns } from '../coverage-runs.js';

/* What a new process does with what the last one left: the one decision, in two looks because the second must see what the first restored.
   Pure, no I/O; the caller reads and writes. Nothing is asked of a model by this, and a look over its own result finds nothing.
   The kernel decides what became of an Attempt (lib/jobs/lifecycle/recovery.js); this decides which runs are looked at. */

const LIVE = ['queued', 'running', 'pausing', 'cancelling', 'interrupted'];

/** The runs kept on disk (`generationRestart`): `{ restore, forget }`. A run that ended, or is older than the window, leaves nothing behind. */
export function planRunRecovery({ runs, now }) {
  const keep = run => LIVE.includes(run.status) && now - run.at <= RUN_RECORD_WINDOW_MS;
  return { restore: runs.filter(keep), forget: runs.filter(run => !keep(run)) };
}

/** The drafts that come back as an interrupted job (coverage-runs.js interruptedRuns says what such a draft looks like):
 * those no job of this library works on, whose job is not known and was not archived. */
export function planDraftRecovery({ drafts, jobs, archived, root }) {
  const known = new Set(jobs.map(job => job.id)), busy = new Set(jobs.filter(job => job.root === root).map(job => job.draftId));
  return interruptedRuns(drafts).filter(({ draft, marker }) => {
    if (archived.has(marker.jobId) || known.has(marker.jobId) || busy.has(draft.id)) return false;
    if (marker.jobId) known.add(marker.jobId);
    busy.add(draft.id);
    return true;
  });
}
