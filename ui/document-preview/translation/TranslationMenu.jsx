import React from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, Icon, InlineMessage, Popover, ProgressBar, SegmentedControl } from '../../components/index.js';
import { JobUsage, TokenEstimateView } from '../../TokenUsage.jsx';
import { expectedText, rangeTok } from '../../token-usage.js';
import { totalTokens } from '../../../lib/token-usage.js';
import { isCancellable } from '../../../lib/job-status.js';
import { DISPLAY_MODES, jobActive, jobClock } from './model.js';

/* The reader's controls for the bilingual reading: one row in the Aa popover (how translations are drawn), one 译 popover in
   the toolbar (translate this page / chapter, show or fold them all, the glossary, the target language) and the progress line
   of a running job. Plain components over props; the hook (useBilingual.jsx) owns every call. */

const modeLabel = (mode, target) => ({
  pairs: ui('逐段对照'), side: ui('左右分栏'), only: target === 'en' ? ui('仅英文') : ui('仅中文'), hidden: ui('隐藏译文'),
})[mode];
const modeHint = mode => ({
  pairs: ui('译文紧跟在原文段落下面'), side: ui('原文在左，译文在右，逐段对齐'), only: ui('原文折成第一行，点一下展开原文'), hidden: ui('只留每段末尾的 译 按钮'),
})[mode];

/** The one row added to the Aa popover (display settings): how translations sit beside the paragraphs. */
export function TranslationDisplayRow({ mode, target, narrow, onChange }) {
  return <div className="reader-setting tr-modes">
    <span className="reader-setting__label">{ui('译文显示')}</span>
    <SegmentedControl size="sm" wrap stack label={ui('译文显示')} value={mode} onChange={onChange}
      options={DISPLAY_MODES.map(value => ({ value, label: modeLabel(value, target), title: modeHint(value) }))} />
    {narrow && mode === 'side' && <small className="tr-modes__note">{ui('窗口较窄，现在按逐段对照显示。')}</small>}
  </div>;
}

const TARGET_NAMES = () => ({ zh: ui('简体中文'), en: 'English' });

/** "还有 8 段要译 · 已译 4 段" / "这里已经全部译好". */
function scopeLine(scope) {
  if (scope.status === 'loading') return ui('正在数段落…');
  if (scope.status === 'error') return ui('没能估算，稍后再试。');
  const todo = scope.counts?.toTranslate ?? 0, done = scope.counts?.cached ?? 0;
  if (!todo) return done ? ui('已经全部译好。') : ui('这里没有需要翻译的段落。');
  return done ? uiFormat('还有 {0} 段要译 · 已译 {1} 段', [todo, done]) : uiFormat('还有 {0} 段要译', [todo]);
}

/** The 译 button of the toolbar and its popover. */
export function TranslationMenu({ open, onOpenChange, scopes, target, modelAvailable, stale, busy, hasTranslations, onStart, onExpandAll, onCollapseAll, onGlossary, onTarget }) {
  const names = TARGET_NAMES();
  // On a narrow reader the button can sit anywhere along the wrapped toolbar: Popover slides the panel back inside the viewer.
  return <Popover open={open} onOpenChange={onOpenChange} label={ui('中英对照翻译')} className="reader-popover tr-popover" panelClassName="reader-popover__panel tr-panel"
    boundsSelector=".study-document-viewer" flip={false}
    trigger={({ props, ref }) => <Button ref={ref} size="sm" variant="quiet" className="tr-toolbar-button" {...props} aria-busy={busy || undefined}
      title={ui('中英对照翻译')} data-busy={busy ? 'true' : undefined} data-tour="translation-toggle" data-usage="reader.translate">
      <span className="tr-toolbar-button__tag" aria-hidden="true">{target === 'en' ? 'EN' : ui('译')}</span><span className="tr-toolbar-button__label">{ui('翻译')}</span>
    </Button>}>
      <div className="tr-panel__head">
        <strong>{ui('中英对照')}</strong>
        <SegmentedControl size="sm" label={ui('译成')} value={target} onChange={onTarget} options={[{ value: 'zh', label: names.zh }, { value: 'en', label: names.en }]} />
      </div>
      {!modelAvailable && <p className="tr-panel__note" role="status">{ui('还没有连接模型，没法翻译；已有的译文照常显示，阅读不受影响。')}</p>}
      {scopes.map(scope => <section key={scope.id} className="tr-scope" data-status={scope.status}>
        <div className="tr-scope__head"><strong>{scope.label}</strong><small>{scopeLine(scope)}</small></div>
        {scope.status === 'ready' && scope.estimate && (scope.counts?.toTranslate || 0) > 0 && <TokenEstimateView state={{ status: 'ready', estimate: scope.estimate }} />}
        {(scope.counts?.toTranslate || 0) > 0 && <Button size="sm" variant="secondary" disabled={!modelAvailable || busy || scope.status !== 'ready'} onClick={() => onStart(scope.id)}>{ui('开始翻译')}</Button>}
      </section>)}
      {scopes.some(scope => (scope.counts?.toTranslate || 0) > 0) && <p className="tr-panel__note">{ui('只译还没有译文的段落；在后台进行，可以继续阅读，关闭阅读器也不会中断，完成后进信箱。')}</p>}
      <div className="tr-panel__actions">
        <Button size="sm" variant="quiet" disabled={!hasTranslations} onClick={onExpandAll}>{ui('展开本页全部译文')}</Button>
        <Button size="sm" variant="quiet" disabled={!hasTranslations} onClick={onCollapseAll}>{ui('收起本页全部译文')}</Button>
        <Button size="sm" variant="quiet" icon={<Icon name="book" size={16} />} onClick={onGlossary}>{ui('术语表…')}</Button>
      </div>
      {stale?.length > 0 && <p className="tr-panel__note">{uiFormat('旧版本里还有 {0} 段译文，没有套用到这个版本；文字没变的段落会直接沿用。', [stale.reduce((total, entry) => total + entry.count, 0)])}</p>}
  </Popover>;
}

/** The progress of a translation job, in the notices of the reader: counts, clock, a stop, what it used. */
export function TranslationJobCard({ job, now = Date.now(), onStop, onDismiss }) {
  const active = jobActive(job), clock = jobClock(job, now), label = job.scopeLabel || '';
  const failed = job.status === 'failed', cancelled = job.status === 'cancelled';
  const headline = active ? (job.status === 'queued' ? ui('翻译排队中') : job.status === 'cancelling' ? ui('正在停止翻译…') : ui('正在翻译'))
    : failed ? ui('翻译没有完成') : cancelled ? ui('翻译已停止') : job.rejected ? ui('翻译完成，有几段没译成') : ui('翻译完成');
  const counts = uiFormat('已处理 {0} / {1} 段', [job.done ?? 0, job.total ?? 0]);
  // What it used against what was expected, on one line; the full rows open on request so the notice stays one line high.
  const used = job.tokenUsage ? `${ui('实际用量')} ${rangeTok({ low: totalTokens(job.tokenUsage), high: totalTokens(job.tokenUsage) })}` : '', expected = job.estimate ? expectedText(job.estimate) : '';
  const summary = [used, expected].filter(Boolean).join(' · ');
  return <div className="tr-job" data-status={job.status} role="group" aria-label={ui('翻译任务')}>
    <div className="tr-job__row">
      {active ? <span className="sh-spinner" aria-hidden="true" /> : null}
      <strong className="tr-job__title">{label ? `${headline} · ${label}` : headline}</strong>
      <span className="tr-job__counts">{counts}{clock && <> · {active ? uiFormat('已用 {0}', [clock]) : uiFormat('用时 {0}', [clock])}</>}</span>
      <span className="tr-job__actions">
        {isCancellable(job) && <Button size="sm" variant="quiet" onClick={onStop}>{ui('停止')}</Button>}
        {!active && <Button size="sm" variant="quiet" onClick={onDismiss}>{ui('知道了')}</Button>}
      </span>
    </div>
    <ProgressBar size="sm" tone="info" className="tr-job__meter" label={counts} value={job.done || 0} max={job.total || 1} />
    {active && <small className="tr-job__note">{ui('后台继续翻译，可以接着读、接着提问；停止后已译的段落会保留。')}</small>}
    {!active && job.rejected > 0 && <InlineMessage tone="warning" className="tr-job__note">{uiFormat('有 {0} 段没通过检查，没有保存；可以在那几段上点 译 再试。', [job.rejected])}</InlineMessage>}
    {failed && job.stage && <details className="tr-job__raw"><summary>{ui('技术详情')}</summary><code>{job.stage}</code></details>}
    {summary && <details className="tr-job__usage"><summary>{summary}</summary><JobUsage job={job} /></details>}
  </div>;
}

/** The chip that follows a selection: translate exactly these words. */
export function SelectionChip({ left, top, busy, target, onClick, onCancel }) {
  const label = busy ? ui('取消翻译') : ui('翻译选中的文字（Alt+T）');
  return <button type="button" className="tr-chipbtn" style={{ left, top }} data-busy={busy ? 'true' : undefined} aria-label={label} title={label}
    onMouseDown={event => event.preventDefault()} onClick={busy ? onCancel : onClick}>
    {busy ? <span className="sh-spinner" aria-hidden="true" /> : <span aria-hidden="true">{target === 'en' ? 'EN' : ui('译')}</span>}
  </button>;
}
