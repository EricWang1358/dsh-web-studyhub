import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Disclosure, InlineMessage, JobRow } from '../components/index.js';
import GenerationTrace from '../GenerationTrace.jsx';
import { ShortfallReasons } from '../DraftShortfall.jsx';
import { isActiveJob, isCancellable } from '../job-visibility.js';
import { useQuickActions } from '../quick-actions.js';
import { describeFailure, failureBreakdown, failureRowLabel, jobCode, jobHeadline, jobSavedProgress, jobStageLabel, repeatedJobFailure } from '../generation-status.js';
import { JOB_TYPES } from '../../lib/job-status.js';

/** The JobRow status a generation job's stage code stands for. */
function rowStatus(code, active) {
  if (['queued', 'failed', 'partial', 'cancelled'].includes(code)) return code;
  return active ? 'running' : 'complete';
}

/* One background job, compact: which deck, where it is in plain words, one
   stop control while it runs, and the draft once there is one (P26–P29).
   A failure says what is wrong and how to fix it; the raw message stays in
   技术详情 (P15). It is the shared JobRow. */
export default function JobCard({ job: j, jobs = [], drafts, busy, openDraft, openAgent, cancelJob, dismissJob, retryGeneration, openModelSettings, openDeck, practiceCards }) {
  const code = jobCode(j), active = isActiveJob(j);
  const dismissFailure = useQuickActions()?.failures[j.id];
  const draft = j.draftId ? drafts.find((d) => d.id === j.draftId) : null;
  const generation = !['draft-publish', 'draft-repair'].includes(j.type);
  const failure = code === 'failed' && generation ? describeFailure(j.stage, { hasDraft: !!draft }) : null;
  const progress = active && jobSavedProgress(j, drafts);
  const repeatedFailure = failure && repeatedJobFailure(j.stage);
  // A review that rejected the questions is read one question at a time, each with its original lines behind an expander.
  const rows = failure?.kind === 'quality' ? failureBreakdown(j.stage) : [];
  const stage = failure ? null : jobStageLabel(j, drafts, jobs, { includeSaved: !progress });
  const published = j.origin === 'selection' && j.status === 'complete' && j.publication?.cardIds?.length > 0 ? j.publication : null;
  const actions = [
    cancelJob && j.type !== JOB_TYPES.DRAFT_PUBLISH && isCancellable(j) && { key: 'stop', label: ui('停止'), icon: 'close', disabled: busy,
      title: j.origin === 'selection' ? ui('停止补题；题组不会有变化') : ui('停止生成；已保存的题留在草稿里'), onClick: () => cancelJob(j.id) },
    draft && !active && { key: 'draft', label: ui('打开草稿'), onClick: () => openDraft(draft) },
    // A passage supplement jumps to where its questions went: practise exactly those, or open the deck.
    published && practiceCards && { key: 'practice', variant: 'primary', disabled: busy, onClick: () => practiceCards(published.deckId, published.cardIds),
      label: published.cardIds.length === 1 ? ui('马上练这 1 张') : uiFormat('马上练这 {0} 张', [published.cardIds.length]) },
    published && openDeck && { key: 'deck', label: ui('打开题组'), disabled: busy, onClick: () => openDeck(published.deckId) },
    retryGeneration && generation && j.type !== JOB_TYPES.SUPPLEMENT && ['failed', 'cancelled'].includes(j.status) && !draft
      && { key: 'retry', label: ui('按原资料重新设置'), disabled: busy, onClick: () => retryGeneration(j) },
  ].filter(Boolean);
  return (
    <JobRow className="generation-job" data-job-id={j.id} status={rowStatus(code, active)} stage={stage || undefined} title={jobHeadline(j, drafts)}
      meta={stage && <>{progress && <span className="job-stage__label">{ui('当前阶段')}</span>} {stage}</>} leaving={j.leaving}
      progress={progress ? { value: Math.min(progress.saved, progress.total), max: progress.total, label: progress.label,
        summary: <><span>{progress.label} <strong>{uiFormat('{0}/{1} 题', [progress.saved, progress.total])}</strong></span>{progress.note && <span className="job-progress__note"> · {progress.note}</span>}</> } : undefined}
      failure={failure ? { title: failure.title, hint: failure.hint } : undefined}
      actions={actions} onDismiss={dismissJob && !active ? () => dismissJob(j.id) : undefined}
      dismissTitle={ui('删除这条任务记录；草稿和已通过的题目会保留')}>
      {failure && <>
        {/* The fix sits right under the reason, where the learner is reading. */}
        {failure.action === 'settings' && openModelSettings && <Button size="sm" variant="secondary" icon="model" onClick={openModelSettings}>{ui('去配置模型')}</Button>}
        <Disclosure className="tech-details" summary={ui('技术详情')}>
          {rows.length > 0 ? <ul className="job-failure-rows">{rows.map((row) => <li key={`${row.part ?? ''}:${row.question}`}>
            <strong>{failureRowLabel(row)}</strong>
            <Disclosure summary={ui('原文')}>{row.raw.map((line, index) => <code className="job-raw" key={index}>{line}</code>)}</Disclosure>
          </li>)}</ul> : repeatedFailure ? <>
            <p className="muted">{uiFormat('{0} 批发生同一问题', [repeatedFailure.count])}</p>
            <code className="job-raw">{repeatedFailure.cause}</code>
            <Disclosure summary={ui('原始错误记录')}><code className="job-raw">{repeatedFailure.raw}</code></Disclosure>
          </> : <code className="job-raw">{j.stage}</code>}
        </Disclosure>
      </>}
      {code === 'partial' && draft && generation && j.type !== JOB_TYPES.SUPPLEMENT && <ShortfallReasons draft={draft} compact />}
      {dismissFailure && <InlineMessage tone="error">{uiFormat('没能移除这条记录：{0}', [dismissFailure])}</InlineMessage>}
      {j.type !== JOB_TYPES.DRAFT_PUBLISH && <GenerationTrace job={j} openAgent={openAgent} />}
    </JobRow>
  );
}
