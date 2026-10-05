import React, { useContext } from 'react';
import { ui, uiFormat, uiMessage } from '../i18n.js';
import { Button, InlineMessage, ProgressBar } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { AppContext } from '../app/app-context.js';
import { dismissJobs, useQuickActions } from '../quick-actions.js';
import { joinMeta } from '../format.js';
import css from './compact-card.css';
import { contractOf, isRunningTask } from './task-model.js';
import { taskSummary, stageLabel } from './task-summary.js';
import { runningCalls, callLabel } from './call-model.js';
import { resultOpener } from './task-actions.js';

/* The compact job card that replaces the big per-feature cards on the pages (音频转写, the home's question runs, PDF conversions): a status dot, the
   title and its percent, a thin bar, ONE status line, a stop (or 知道了) slot of fixed width and a primary button of fixed width, so the cards line up.
   Everything it says is read from the job's contract; the detail of a job (every step, the live output, the log, the controls) is in the 任务 console,
   which 「查看详情」 opens with this job selected. */

const UNIT = { files: '个文件', pages: '页', paragraphs: '段', questions: '题' };

/** Which piece of a long conversion is being worked on: the adaptive plan decides its windows one at a time ("第 3 段"), a fixed one knows how many there are. */
function pieceOf(contract) {
  const chunk = contract.kind === 'pdf-convert' ? contract.detail.chunk : null;
  if (!chunk?.index) return '';
  return contract.detail.adaptive ? uiFormat('第 {0} 段', [chunk.index]) : chunk.count > 1 ? uiFormat('第 {0}/{1} 段', [chunk.index, chunk.count]) : '';
}

/** The one line under the bar: how many are done, what is happening now, the notices; or the reason, or what the result is. */
export function cardLine(job) {
  const contract = contractOf(job), { progress, status, result, error } = contract;
  const notices = contract.detail?.notices?.length || contract.detail?.warnings?.length || 0, noticed = notices ? uiFormat('{0} 条提醒', [notices]) : '';
  if (status === 'failed' || status === 'interrupted') return uiMessage(error?.message || stageLabel(contract.stage));
  if (status === 'cancelled') return joinMeta([ui('已停止'), progress.total > 0 ? uiFormat('停在 {0}/{1}', [progress.done, progress.total]) : '', ui('已完成的部分已保留')]);
  if (status === 'complete' && contract.kind === 'audio-import') {
    const { review, reusedWhole, corrected, uncertain } = contract.detail, sources = result.refs.filter((ref) => ref.kind === 'source').length;
    if (review) return uiFormat('复核完成：改进正稿 {0} 处 · 判定原文无误 {1} 处 · 仍拿不准 {2} 处', [review.applied, review.rejected, review.unsure]);
    return joinMeta([reusedWhole ? ui('已导入过，直接复用') : uiFormat('已存为 {0} 份资料 · 校对修正 {1} 处', [sources, corrected]),
      uncertain > 0 ? uiFormat('另有 {0} 处把握不大的疑似错词没有改，可在资料里查看', [uncertain]) : '', noticed]);
  }
  if (status === 'complete') {
    const sources = result.refs.filter((ref) => ref.kind === 'source').length;
    return joinMeta([sources ? uiFormat('已存为 {0} 份资料', [sources]) : result.refs.some((ref) => ref.kind === 'draft') ? ui('草稿已生成') : ui('已完成'),
      result.completeness === 'partial' ? ui('只完成了一部分') : '', progress.unit && progress.total > 0 ? uiFormat('{0}/{1} {2}', [progress.done, progress.total, ui(UNIT[progress.unit])]) : '', noticed]);
  }
  const now = runningCalls(contract.calls).find((call) => call.kind !== 'wait');
  const count = progress.total > 0 && ['files', 'pages', 'paragraphs'].includes(progress.unit) ? uiFormat('{0}/{1} {2}完成', [progress.done, progress.total, ui(UNIT[progress.unit])]) : '';
  const doing = now ? uiFormat('正在{0}', [callLabel(now, { file: true })]) : stageLabel(contract.stage);
  return joinMeta([contract.status === 'paused' ? ui('已暂停') : contract.status === 'pausing' ? ui('正在暂停') : '', count, doing, pieceOf(contract), noticed]);
}

export default function CompactJobCard({ job, onStop, onDismiss, primary, title, line, onOpenConsole, className, ...rest }) {
  useInjectCss(css, 'study-compact-card');
  const app = useContext(AppContext) || {}, quick = useQuickActions();
  const contract = contractOf(job), summary = { ...taskSummary(job) }, live = isRunningTask(job), unknown = summary.percent === null && live;
  const openConsole = onOpenConsole || (() => app.nav?.show?.task?.(contract.jobId));
  const cancel = onStop || (() => app.core?.act?.('job.control', { jobId: contract.jobId, action: 'cancel' }));
  // 知道了 puts the task in 已归档 (nothing is deleted); the notice says where it went.
  const dismiss = onDismiss || (() => {
    const done = quick ? dismissJobs(quick, job.id) : app.core?.act?.('job.archive', { jobId: job.id });
    void Promise.resolve(done).then((result) => { if (result?.ok !== false) app.core?.notify?.(ui('已放进「已归档」，可以在「任务」里取消归档或删除。')); });
  });
  const result = !live && contract.status === 'complete' ? resultOpener(job, app) : null;
  const go = primary || result || (!live && ['failed', 'interrupted', 'cancelled'].includes(contract.status) && contract.actions.retry.available ? { label: ui('看原因并继续'), run: openConsole }
    : { label: ui('查看详情'), run: openConsole });
  if (title) summary.title = title;
  const stoppable = contract.actions.cancel.available && live, tone = summary.state, dismissFailure = quick?.failures[job.id];
  return (
    <article className={['cjc', job.leaving && 'is-leaving', className].filter(Boolean).join(' ')} data-job-id={job.id} data-state={tone} aria-label={summary.title} {...rest}
      aria-hidden={job.leaving ? 'true' : undefined} inert={job.leaving || undefined}>
      <span className="cjc__dot" data-state={tone} aria-hidden="true" />
      <div className="cjc__main">
        <div className="cjc__top">
          <strong className="cjc__title">{summary.title}</strong>
          <span className="cjc__pct" data-state={tone}>{tone === 'fail' ? ui('失败') : tone === 'interrupted' ? ui('已中断') : tone === 'stopped' ? ui('已停止') : tone === 'done' ? ui('完成') : summary.percent === null ? '' : `${summary.percent}%`}</span>
        </div>
        <ProgressBar className="cjc__bar" size="sm" value={summary.percent ?? 0} max={100} indeterminate={unknown} tone={tone === 'fail' ? 'error' : tone === 'done' ? 'success' : 'accent'} label={uiFormat('{0} 的进度', [summary.title])} />
        <span className="cjc__line" role={tone === 'fail' ? 'alert' : undefined}>{line || cardLine(job)}</span>
      </div>
      <div className="cjc__slot">
        {stoppable ? <Button variant="quiet" size="sm" aria-label={uiFormat('停止：{0}', [summary.title])} onClick={cancel}>{ui('停止')}</Button>
          : !live ? <Button variant="quiet" size="sm" aria-label={uiFormat('知道了：{0}', [summary.title])} onClick={dismiss}>{ui('知道了')}</Button> : null}
      </div>
      {/* A dismissal that did not go through says so next to the card that came back. */}
      {dismissFailure && <InlineMessage className="cjc__problem" tone="error">{uiFormat('没能移除这条记录：{0}', [dismissFailure])}</InlineMessage>}
      <Button className="cjc__go" size="sm" disabled={go.disabled} aria-label={`${go.label}：${summary.title}`} iconEnd={<span aria-hidden="true">→</span>} onClick={go.run}>{go.label}</Button>
    </article>
  );
}
