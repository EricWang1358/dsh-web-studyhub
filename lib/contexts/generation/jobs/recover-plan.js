import { RUN_RECORD_WINDOW_MS } from '../../../generation-limits.js';
import { closedShort } from '../../../coverage-run.js';
import { interruptedRuns } from '../coverage-runs.js';

/* What a new process does with what the last one left: the one decision, in two looks because the second must see what the first restored.
   Pure, no I/O; the caller reads and writes. Nothing is asked of a model by this, and a look over its own result finds nothing.
   The kernel decides what became of an Attempt (lib/jobs/lifecycle/recovery.js); this decides which runs are looked at. */

const LIVE = ['queued', 'running', 'pausing', 'cancelling', 'interrupted'];

/** The runs kept on disk (`generationRestart`): `{ restore, forget }`. A run that ended, is older than the window, or whose draft says the run closed leaves
 * nothing behind (the process died between that write and the last word of the job: a question run has nothing left after it, a supplement still has its publication).
 * A draft has one run. A continuation through `generate` is a new logical job over the same draft, and the record of the job it replaced stays on disk: the run the draft
 * names (else the newest) is the one that comes back. Left to return, the other would ask its first request again: a second draft and the tokens of one. */
export function planRunRecovery({ runs, now, drafts }) {
  const closedDrafts = drafts.filter(({ editorial }) => editorial?.coverageRun?.state === 'complete' || closedShort(editorial?.coverageRun?.stop));
  const closed = new Set(closedDrafts.map(draft => draft.editorial.generation?.runId).filter(Boolean)), closedIds = new Set(closedDrafts.map(draft => draft.id));
  const owners = new Map(drafts.map(draft => [draft.id, draft.editorial?.generation?.runId]));
  const over = run => run.kind === 'generation' && (closed.has(run.jobId) || closedIds.has(run.draftId));
  const alive = runs.filter(run => LIVE.includes(run.status) && now - run.at <= RUN_RECORD_WINDOW_MS && !over(run));
  const outranks = (other, run) => owners.get(run.draftId) === other.jobId || (owners.get(run.draftId) !== run.jobId && other.at > run.at);
  const rival = run => alive.some(other => other !== run && other.kind === 'generation' && other.draftId === run.draftId && outranks(other, run));
  const keep = run => alive.includes(run) && !(run.kind === 'generation' && run.draftId && rival(run));
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
