import { shortfallOf } from '../../lib/shortfall.js';
import { activeJobOf } from './run-job.js';
import { useCoverage } from './use-coverage.js';

/* The shortfall of a draft (lib/shortfall.js), made the same way on every screen that says it: the home banner, the 待发布 row, the 任务 console and the draft page. The inputs are the
   draft, `coverage.get`'s answer for it (what the sections have, the round the one button runs now) and the job that works on it, or the interrupted run the last process left. */

/** The shortfall of `draft` from the coverage view (`coverage.get`'s answer, or null while it has not arrived) and the jobs of the snapshot. null without a draft. */
export function draftShortfall(draft, { view, jobs = [], job } = {}) {
  if (!draft) return null;
  const ok = view?.status === 'ok' ? view : null;
  return shortfallOf({ draft, coverage: ok?.coverage, round: ok?.round, job: job ?? activeJobOf(draft, jobs), canTopUp: ok ? ok.canTopUp !== false : true });
}

/** The same, asking for the coverage view: `{ view, shortfall, status }`. `data` is the library snapshot (its revision and jobs). */
export function useDraftShortfall(draft, data, { enabled = true, job } = {}) {
  const covered = useCoverage(draft ? { draftId: draft.id } : null, { version: `${data?.revision}:${draft?.draftVersion ?? ''}`, enabled });
  const view = covered.view?.status === 'ok' ? covered.view : null;
  return { view, status: covered.status, shortfall: draftShortfall(draft, { view, jobs: data?.jobs || [], job }) };
}
