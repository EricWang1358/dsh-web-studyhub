import { RUN_RECORD_WINDOW_MS } from '../../../generation-limits.js';
import { closedShort } from '../../../coverage-run.js';
import { interruptedRuns } from '../coverage-runs.js';

/* What a new process does with what the last one left: the one decision, in two looks because the second must see what the first restored.
   Pure, no I/O; the caller reads and writes. Nothing is asked of a model by this, and a look over its own result finds nothing.
   The kernel decides what became of an Attempt (lib/jobs/lifecycle/recovery.js); this decides which runs are looked at. */

const LIVE = ['queued', 'running', 'pausing', 'cancelling', 'interrupted'];

/** The runs kept on disk (`generationRestart`): `{ restore, forget }`. A run that ended, is older than the window, or whose draft says the run closed leaves
 * nothing behind (the process died between that write and the last word of the job: a question run has nothing left after it, a supplement still has its publication).
 * A draft has one run, and every save of a run names it. A continuation through `generate` is a new logical job over the same draft, and the record of the job it replaced
 * stays on disk: a run that saved to a draft that now names another is over, whether or not that other still lives. Left to return, it would ask its first request again: a
 * second draft and the tokens of one. Of two records left on one draft the run the draft names comes back, else the newest.
 * `continues`: a press by count on a run closed short, which still has its work to do on that closed draft. */
export function planRunRecovery({ runs, now, drafts }) {
  const named = new Map(drafts.flatMap(draft => (draft.editorial?.generation?.runId ? [[draft.editorial.generation.runId, draft.id]] : [])));
  const owners = new Map(drafts.map(draft => [draft.id, draft.editorial?.generation?.runId]));
  const seen = runs.map(run => ({ run, draftId: run.draftId ?? named.get(run.jobId) })), byId = new Map(drafts.map(draft => [draft.id, draft]));
  const over = ({ run, draftId }) => {
    if (run.kind !== 'generation') return false;
    const marker = byId.get(draftId)?.editorial?.coverageRun, owner = owners.get(draftId);
    return marker?.state === 'complete' || (closedShort(marker?.stop) && !run.continues) || (!!run.saved && !!owner && owner !== run.jobId);
  };
  const alive = seen.filter(item => LIVE.includes(item.run.status) && now - item.run.at <= RUN_RECORD_WINDOW_MS && !over(item));
  const outranks = (other, { run, draftId }) => owners.get(draftId) === other.run.jobId || (owners.get(draftId) !== run.jobId && other.run.at > run.at);
  const rival = item => alive.some(other => other !== item && other.run.kind === 'generation' && other.draftId === item.draftId && outranks(other, item));
  const kept = new Set(alive.filter(item => !(item.run.kind === 'generation' && item.draftId && rival(item))).map(item => item.run));
  return { restore: runs.filter(run => kept.has(run)), forget: runs.filter(run => !kept.has(run)) };
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
