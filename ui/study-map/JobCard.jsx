import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import CompactJobCard from '../tasks/CompactJobCard.jsx';
import { isActiveJob } from '../job-visibility.js';
import { shortfall as shortfallReport } from '../draft-shortfall.js';
import { joinMeta } from '../format.js';
import { describeFailure, jobHeadline, jobSavedProgress, jobStageLabel } from '../generation-status.js';
import { JOB_TYPES } from '../../lib/job-status.js';
import { useStudy } from '../study-context.jsx';
import { useDraftShortfall } from '../coverage/use-shortfall.js';
import { actionLabel, reasonWord, shortfallLine } from '../coverage/copy.js';

/* One question run on the home, as the compact job card: which deck, the percent, one line of where it is, a stop control while it runs, and ONE button for
   what to do next (practise what a passage supplement made, set up the model, open the draft, set the run up again, or look at the detail). The detail
   of a run (its parts, the model calls behind them, the live output, the log and what went wrong in full) is in the 任务 console, which the card's
   button opens with the run selected; the runs a draft folded away are listed there too.
   A run that has left a draft says where it stands the way every screen does (lib/shortfall.js: the same questions, sections and next step as the 待发布 row, the console and the draft
   page), and its button is the shortfall's ONE action: 接着做 (interrupted), 继续 (paused), 去配置模型 (a refused key), 为没覆盖的部分补题 (it stopped with sections left). */
export default function JobCard({ job: j, jobs = [], drafts, data, busy, openDraft, cancelJob, dismissJob, retryGeneration, openModelSettings, openDeck, practiceCards, topUpDraft, modelReady = true }) {
  const { act } = useStudy();
  const active = isActiveJob(j);
  const draft = j.draftId ? drafts.find((d) => d.id === j.draftId) : null;
  const generation = !['draft-publish', 'draft-repair'].includes(j.type);
  const failure = j.status === 'failed' && generation ? describeFailure(j.stage, { hasDraft: !!draft }) : null;
  const progress = active && jobSavedProgress(j, drafts);
  // Where the draft stands (ask the coverage once per draft: the 待发布 row below shares the answer). A run that is paused is still a live job, and it stands still: its action is 继续.
  const pausedRun = active && (j.paused === true || j.coverageRun?.state === 'paused');
  const { view, shortfall } = useDraftShortfall((!active || pausedRun) && generation && j.type !== JOB_TYPES.SUPPLEMENT && j.origin !== 'selection' ? draft : null, data || { jobs });
  // The shortfall says where the draft stands once it knows the sections (the coverage view) or the run (the draft's plan); a draft with neither keeps the words of its job.
  const knows = !!view || !!draft?.editorial?.coverageSpec;
  const stands = !!shortfall && knows && (pausedRun ? shortfall.state === 'paused' : !active && (['interrupted', 'refused', 'paused', 'stopped', 'cancelled'].includes(shortfall.state) || (!shortfall.ready && shortfall.state === 'done')));
  // Where a run is, in the words it has always used: the round of a fill and how many questions are still missing, what the draft holds.
  // A run that ended short says why in one phrase (the first reason of the part report); the whole account is on the draft's page.
  const why = !active && !failure && draft && generation ? shortfallReport(draft).report?.reasons?.[0] : '';
  const standing = stands ? joinMeta([shortfallLine(shortfall), shortfall.state === 'interrupted' && shortfall.round ? uiFormat('中断于第 {0} 轮', [shortfall.round])
    : shortfall.state === 'paused' ? uiFormat('暂停于第 {0} 轮之后', [shortfall.pausedAfter ?? shortfall.roundsDone ?? 0])
    : shortfall.state === 'refused' ? reasonWord(shortfall.failure || 'credential') : why]) : '';
  const stage = standing || (failure ? failure.title : joinMeta([jobStageLabel(j, drafts, jobs, { includeSaved: !progress }), why]));
  const published = j.origin === 'selection' && j.status === 'complete' && j.publication?.cardIds?.length > 0 ? j.publication : null;
  const jobId = j.contract?.jobId || j.id;
  // The shortfall's action first: the same button as the 待发布 row of this draft.
  const own = !stands ? null : ({
    'model-settings': openModelSettings && { label: actionLabel('model-settings'), run: openModelSettings },
    continue: { label: actionLabel('continue'), run: () => act('job.control', { jobId, action: 'retry' }), disabled: !modelReady },
    resume: { label: actionLabel('resume'), run: () => act('job.control', { jobId, action: 'resume' }) },
    topup: view?.canTopUp && view.round?.sections > 0 && topUpDraft && { label: actionLabel('topup'), run: () => topUpDraft(draft, view.round.picks.map((pick) => pick.key), view.round), disabled: !modelReady },
  })[shortfall.action];
  const choices = [
    published && practiceCards && { label: published.cardIds.length === 1 ? ui('马上练这 1 张') : uiFormat('马上练这 {0} 张', [published.cardIds.length]),
      run: () => practiceCards(published.deckId, published.cardIds) },
    own,
    failure?.action === 'settings' && openModelSettings && { label: ui('去配置模型'), run: openModelSettings },
    draft && !active && { label: ui('打开草稿'), run: () => openDraft(draft) },
    retryGeneration && generation && j.type !== JOB_TYPES.SUPPLEMENT && ['failed', 'cancelled'].includes(j.status) && !draft && { label: ui('按原资料重新设置'), run: () => retryGeneration(j) },
    published && openDeck && { label: ui('打开题组'), run: () => openDeck(published.deckId) },
  ].filter(Boolean);
  return <CompactJobCard job={j} primary={choices[0] && { ...choices[0], disabled: busy || choices[0].disabled }} title={jobHeadline(j, drafts)} line={progress && !standing ? [`${progress.label} ${uiFormat("{0}/{1} 题", [progress.saved, progress.total])}`, stage].filter(Boolean).join(' · ') : stage}
    onStop={cancelJob && j.type !== JOB_TYPES.DRAFT_PUBLISH ? () => cancelJob(j.id) : undefined}
    onDismiss={dismissJob ? () => dismissJob(j.id) : undefined} />;
}
