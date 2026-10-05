import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, InlineMessage } from '../components/index.js';
import { DraftTopUp } from '../DraftShortfall.jsx';
import { isActiveJob } from '../job-visibility.js';
import { useQuickActions } from '../quick-actions.js';
import { reviewedCardStatus } from '../../lib/review-integrity.js';
import { missingQuestions } from '../draft-shortfall.js';
import JobCard from './JobCard.jsx';
import { useStudy } from '../study-context.jsx';
import { joinMeta } from '../format.js';

function DraftRow({ draft: d, data, busy, modelReady, call, openDraft, continueDraft }) {
  const missing = missingQuestions(d);
  const qualityCount = (d.quality?.warnings?.length || 0) + (d.quality?.errors?.length || 0);
  const rejectedCount = d.cards.filter((card) => d.editorial?.rejectedIssues?.[card.id]).length;
  const reviewed = reviewedCardStatus(d);
  return (
    <div className="draft-row">
      <button type="button" className="draft-open" onClick={() => openDraft(d)}>
        <span>
          <strong>{d.title}</strong>
          <small>
            {joinMeta([uiFormat('{0} 道题', [d.cards.length]), qualityCount ? uiFormat('{0} 项质量提醒', [qualityCount]) : '',
              rejectedCount ? uiFormat('{0} 题待处理', [rejectedCount]) : reviewed?.unchanged === d.cards.length ? ui('已复审，待发布') : ui('待发布检查'),
              missing > 0 ? uiFormat('还差 {0} 题', [missing]) : '',
              Number.isInteger(d.editorial?.completedParts) && d.editorial.completedParts < d.editorial.parts
                ? uiFormat('生成未完成 {0}/{1} 批', [d.editorial.completedParts, d.editorial.parts]) : ''])}
          </small>
        </span>
        <span>{ui('打开 →')}</span>
      </button>
      <DraftTopUp draft={d} jobs={data.jobs} busy={busy} modelReady={modelReady} call={call} onContinue={continueDraft} />
    </div>
  );
}

/* Generation progress and drafts waiting for review sit at the top of the
   home (P26): a job started from 创建题组 is in view when the learner lands
   here, and a failure shows up where they are looking (P15). `jobs` are the
   ones to show, running first. */
export default function HomeActivity({ sectionRef, jobs, drafts, data, modelReady, start, manage, openDraft, openAgent, cancelJob, dismissJob, retryGeneration, openModelSettings, continueDraft }) {
  const { busy, call } = useStudy();
  const quick = useQuickActions();
  if (!jobs.length && !drafts.length) return null;
  const finishedCount = jobs.filter((job) => !isActiveJob(job) && !job.leaving).length;
  return (
    <section className="home-activity" ref={sectionRef} aria-label={ui('出题进度与待发布草稿')}>
      {jobs.length > 0 && <div className="jobs generation-jobs">
        {jobs.map((job) => <JobCard key={job.id} job={job} jobs={jobs} drafts={drafts} busy={busy} openDraft={openDraft}
          openAgent={openAgent} cancelJob={cancelJob} dismissJob={dismissJob} retryGeneration={retryGeneration}
          openModelSettings={openModelSettings} openDeck={manage}
          practiceCards={(deckId, cardIds) => start({ mode: 'path', scope: cardIds.map((cardId) => ({ deckId, cardId })), fresh: true })} />)}
        {dismissJob && finishedCount > 1 && <div className="jobs-actions">
          {quick?.failures['jobs:all'] && <InlineMessage tone="error">{uiFormat('没能全部移除：{0}', [quick.failures['jobs:all']])}</InlineMessage>}
          {/* Not part of the single-flight act: it must stay clickable whatever else is running. */}
          <Button variant="link" size="sm" className="jobs-dismiss-all" onClick={() => dismissJob()}>{ui('全部知道了')}</Button>
        </div>}
      </div>}
      {drafts.length > 0 && <div className="home-drafts">
        <div className="section-heading">
          <h2>{ui('待发布')}{' '}<span>{drafts.length}</span></h2>
          <small>{ui('发布时逐题检查；问题题留在草稿')}</small>
        </div>
        {[...drafts].reverse().map((d) => <DraftRow key={d.id} draft={d} data={data} busy={busy} modelReady={modelReady} call={call}
          openDraft={openDraft} continueDraft={continueDraft} />)}
      </div>}
    </section>
  );
}
