import { ui, uiFormat } from './i18n.js';
import { JOB_STATUS, JOB_TYPES } from '../lib/job-status.js';
import { reviewedCardStatus } from '../lib/review-integrity.js';
import { draftWork, draftWorkLabel } from './draft-shortfall.js';

/* From a finished run to practising (the owner's short flow): which draft may be published from the card of its run in one press (発布并练习), and what the draft page
   says while a job works on the draft, so that 保存并发布 being off has a reason and a way out. Pure; the publication itself is ui/app/use-drafts.js publishAndPractice. */

/**
 * May the finished card publish this draft at once? Only when there is nothing left to look at: the run is done and nothing is missing (the shortfall says 'done' only once the plan is met or the
 * coverage has arrived and every section has a question, so a draft whose coverage is not known yet is not offered), every question is the one that was reviewed, no problem is recorded, nothing works on the draft, it is an ordinary new deck (not an edit of a published one) and there is no deck to choose
 * (`targets`: the next part of a deck chooses where it goes on the draft page). Anything else is for the draft page, where the learner looks first.
 */
export function canPublishAtOnce({ draft, shortfall, jobs = [], targets = null } = {}) {
  if (!draft || !draft.cards?.length || shortfall?.state !== 'done' || shortfall.questionsMissing !== 0 || targets) return false;
  if (draft.editingDeckId || draft.editorial?.repairOfDeckId || draft.editorial?.partialEdit) return false;
  if (draftWork(draft, jobs)) return false;
  if (Object.keys(draft.editorial?.rejectedIssues || {}).length || draft.quality?.errors?.length) return false;
  const status = reviewedCardStatus(draft);
  return !!status && status.unchanged === draft.cards.length;
}

/** The sentence under the draft's buttons while something works on the draft: what works, why saving and publishing wait, and how to get past it. */
export function holdLine(work, draft, percent) {
  const { kind, job } = work;
  if (kind === 'publish') return job.stage || ui('发布检查正在进行，完成后可继续保存或发布。');
  if (job.status === JOB_STATUS.CANCELLING) return ui('正在停止；停下后就可以保存或发布。');
  const label = draftWorkLabel(work, draft, percent);
  return kind === 'repair' ? uiFormat('{0}。修题期间不能保存或发布；想现在发布，先停止修题（已修好的题保留）。', [label])
    : uiFormat('{0}。这期间不能保存或发布；想现在发布，先停止它（已通过检查的题都保留在草稿里）。', [label]);
}

/** Can the draft page stop this work? A publication check is not stopped from here; a job the contract says cannot be stopped, or that is already stopping, is not offered. */
export const canStopWork = (work) => !!work && work.kind !== 'publish' && work.job.type !== JOB_TYPES.DRAFT_PUBLISH && work.job.status !== JOB_STATUS.CANCELLING
  && work.job.contract?.actions?.cancel?.available !== false;

/** What the stop action is called: a repair is stopped like it always was, a run keeps what it made. */
export const stopLabel = (work) => (work.kind === 'repair' ? ui('停止修题，保留草稿') : ui('停止并保留已出的题'));
