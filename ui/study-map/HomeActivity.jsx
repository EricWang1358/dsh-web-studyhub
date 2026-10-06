import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, InlineMessage } from '../components/index.js';
import { CoverageTopUp } from '../coverage/CoverageTopUp.jsx';
import { coverageHead, shortfallLine, shortfallTag } from '../coverage/copy.js';
import { runSummary } from '../coverage/RunPanel.jsx';
import { useDraftShortfall } from '../coverage/use-shortfall.js';
import { foldJobsByDraft, isActiveJob } from '../job-visibility.js';
import { useQuickActions } from '../quick-actions.js';
import { reviewedCardStatus } from '../../lib/review-integrity.js';
import { draftWork } from '../draft-shortfall.js';
import JobCard from './JobCard.jsx';
import { useStudy } from '../study-context.jsx';
import { joinMeta } from '../format.js';
import { draftPartTitle, partTargets } from '../DraftPart.jsx';

function DraftRow({ draft: d, data, modelReady, openDraft, topUpDraft }) {
  // 覆盖: how much of its material the draft has questions for, said in the words of the draft page. The counts, the tag and the one action are the draft's SHORTFALL (lib/shortfall.js):
  // the same numbers and the same sentences as the banner above, the 任务 console and the draft page.
  const { view, shortfall } = useDraftShortfall(d, data);
  const qualityCount = (d.quality?.warnings?.length || 0) + (d.quality?.errors?.length || 0);
  const rejectedCount = d.cards.filter((card) => d.editorial?.rejectedIssues?.[card.id]).length;
  const reviewed = reviewedCardStatus(d);
  // Whatever works on the deck right now (a fill, the run still writing it, a repair, a publication check) is its status: not "已复审，待发布".
  // The status is said once, in a Badge (#228): the work's own (with its progress, under the title) while something runs, else this one on the facts' line (it
  // adds no line: the 待发布 list arrives after a generation, and a taller list moves the page below it further); the meta text is facts.
  const work = draftWork(d, data.jobs);
  // A draft whose plan has rounds says where its run is in the draft page's words (lib/coverage-run.js draftRunFacts: 「第 1 轮完成，还有 11 轮 · 覆盖 9%」); that line carries the coverage.
  const run = !work && view ? runSummary(d, data.jobs, view.coverage?.percentLeaves ?? null, view.coverage) : null;
  // The badge says what is true of the draft: 「已复审，待发布」 only when nothing is missing; a draft that is short, stopped, refused or interrupted says that.
  const tag = shortfallTag(shortfall, { reviewed: reviewed?.unchanged === d.cards.length }), pending = rejectedCount ? uiFormat('{0} 题待处理', [rejectedCount]) : '';
  const clean = shortfall.ready || (shortfall.state === 'done' && shortfall.questionsMissing === 0), status = clean ? pending || tag : joinMeta([tag, pending]);
  return (
    <div className="draft-row">
      <button type="button" className="draft-open" onClick={() => openDraft(d)}>
        <span>
          {/* A draft that will be the next part of a deck says so: 「期中复习 · 第二部分」 (ui/DraftPart.jsx). */}
          <strong>{draftPartTitle(partTargets(d, data)) || d.title}</strong>
          <small className="draft-meta">
            <span className="draft-meta__facts">{joinMeta([shortfallLine(shortfall), qualityCount ? uiFormat('{0} 项质量提醒', [qualityCount]) : '',
              run?.facts.total > 1 && run.facts.state !== 'complete' ? run.line : view?.coverage?.leaves ? coverageHead(view.coverage) : '',
              Number.isInteger(d.editorial?.completedParts) && d.editorial.completedParts < d.editorial.parts
                ? uiFormat('生成未完成 {0}/{1} 批', [d.editorial.completedParts, d.editorial.parts]) : ''])}</span>
            {!work && <Badge size="sm" tone={rejectedCount || !clean ? 'warning' : 'neutral'} data-draft-status>{status}</Badge>}
          </small>
        </span>
        <span>{ui('打开 →')}</span>
      </button>
      <CoverageTopUp variant="compact" draft={d} view={view} jobs={data.jobs} modelReady={modelReady} onTopUp={topUpDraft} />
    </div>
  );
}

/* Generation progress and drafts waiting for review sit at the top of the
   home (P26): a job started from 创建题组 is in view when the learner lands
   here, and a failure shows up where they are looking (P15). `jobs` are the
   ones to show, running first. */
export default function HomeActivity({ sectionRef, jobs, drafts, data, modelReady, start, manage, openDraft, openAgent, cancelJob, dismissJob, retryGeneration, openModelSettings, topUpDraft }) {
  const { busy } = useStudy();
  const quick = useQuickActions();
  if (!jobs.length && !drafts.length) return null;
  // One card per deck: the older jobs of a draft fold into its newest job's card.
  const cards = foldJobsByDraft(jobs);
  const finishedCount = cards.filter(({ job }) => !isActiveJob(job) && !job.leaving).length;
  return (
    <section className="home-activity" ref={sectionRef} aria-label={ui('出题进度与待发布草稿')}>
      {jobs.length > 0 && <div className="jobs generation-jobs cjc-list">
        {cards.map(({ job, earlier }) => <JobCard key={job.id} job={job} jobs={jobs} drafts={drafts} data={data} modelReady={modelReady} topUpDraft={topUpDraft} busy={busy} openDraft={openDraft}
          cancelJob={cancelJob} dismissJob={dismissJob && ((jobId) => dismissJob(jobId, earlier.filter((old) => !isActiveJob(old)).map((old) => old.id)))} retryGeneration={retryGeneration}
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
        {[...drafts].reverse().map((d) => <DraftRow key={d.id} draft={d} data={data} modelReady={modelReady}
          openDraft={openDraft} topUpDraft={topUpDraft} />)}
      </div>}
    </section>
  );
}
