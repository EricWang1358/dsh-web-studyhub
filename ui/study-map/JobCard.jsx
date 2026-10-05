import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import CompactJobCard from '../tasks/CompactJobCard.jsx';
import { isActiveJob } from '../job-visibility.js';
import { shortfall } from '../draft-shortfall.js';
import { joinMeta } from '../format.js';
import { describeFailure, jobHeadline, jobSavedProgress, jobStageLabel } from '../generation-status.js';
import { JOB_TYPES } from '../../lib/job-status.js';

/* One question run on the home, as the compact job card: which deck, the percent, one line of where it is, a stop control while it runs, and ONE button for
   what to do next (practise what a passage supplement made, set up the model, open the draft, set the run up again, or look at the detail). The detail
   of a run (its parts, the model calls behind them, the live output, the log and what went wrong in full) is in the 任务 console, which the card's
   button opens with the run selected; the runs a draft folded away are listed there too. */
export default function JobCard({ job: j, jobs = [], drafts, busy, openDraft, cancelJob, dismissJob, retryGeneration, openModelSettings, openDeck, practiceCards }) {
  const active = isActiveJob(j);
  const draft = j.draftId ? drafts.find((d) => d.id === j.draftId) : null;
  const generation = !['draft-publish', 'draft-repair'].includes(j.type);
  const failure = j.status === 'failed' && generation ? describeFailure(j.stage, { hasDraft: !!draft }) : null;
  const progress = active && jobSavedProgress(j, drafts);
  // Where a run is, in the words it has always used: the round of a fill and how many questions are still missing, what the draft holds.
  // A run that ended short says why in one phrase (the first reason of the part report); the whole account is on the draft's page.
  const why = !active && !failure && draft && generation ? shortfall(draft).report?.reasons?.[0] : '';
  const stage = failure ? failure.title : joinMeta([jobStageLabel(j, drafts, jobs, { includeSaved: !progress }), why]);
  const published = j.origin === 'selection' && j.status === 'complete' && j.publication?.cardIds?.length > 0 ? j.publication : null;
  const choices = [
    published && practiceCards && { label: published.cardIds.length === 1 ? ui('马上练这 1 张') : uiFormat('马上练这 {0} 张', [published.cardIds.length]),
      run: () => practiceCards(published.deckId, published.cardIds) },
    failure?.action === 'settings' && openModelSettings && { label: ui('去配置模型'), run: openModelSettings },
    draft && !active && { label: ui('打开草稿'), run: () => openDraft(draft) },
    retryGeneration && generation && j.type !== JOB_TYPES.SUPPLEMENT && ['failed', 'cancelled'].includes(j.status) && !draft && { label: ui('按原资料重新设置'), run: () => retryGeneration(j) },
    published && openDeck && { label: ui('打开题组'), run: () => openDeck(published.deckId) },
  ].filter(Boolean);
  return <CompactJobCard job={j} primary={choices[0] && { ...choices[0], disabled: busy }} title={jobHeadline(j, drafts)} line={progress ? [`${progress.label} ${uiFormat("{0}/{1} 题", [progress.saved, progress.total])}`, stage].filter(Boolean).join(' · ') : stage}
    onStop={cancelJob && j.type !== JOB_TYPES.DRAFT_PUBLISH ? () => cancelJob(j.id) : undefined}
    onDismiss={dismissJob ? () => dismissJob(j.id) : undefined} />;
}
