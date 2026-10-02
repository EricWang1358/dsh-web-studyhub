import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Panel } from './components/index.js';
import Icon from './components/Icon.jsx';
import css from './token-usage.css';
import { totalTokens } from '../lib/token-usage.js';
import {
  USAGE_FEATURE_ORDER, callsText, estimateRows, estimateSummary, estimateText, expectedText, featureLabel, joinRows, methodNote, noteText,
  rangeTok, stageLabel, usageNotes, usageRows, usageText, usedCallsText,
} from './token-usage.js';

/* Token usage the way DSH's session panel shows it (WP27): one layout for a job,
   an estimate and the stats. The plain-text line behind the copy button reads the
   same rows. Counts only: what a token costs is the provider's price list. */

/** Copy `text`; the label says what happened. A browser that refuses leaves the rows selectable. */
function CopyButton({ text, label }) {
  const [state, setState] = useState('idle');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setState('done'); }
    catch { setState('failed'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2200);
  }
  return <Button variant="quiet" size="sm" className="token-usage__copy" onClick={copy} aria-live="polite" title={label || ui('复制这些数字')}>
    {state === 'done' ? ui('已复制') : state === 'failed' ? ui('没能复制，请手动选中文字') : ui('复制')}
  </Button>;
}

/**
 * The rows of one usage (exact counts) or one estimate (ranges), in DSH's order and wording.
 * `inline` sets the rows side by side; `copy` is the copy button (on by default).
 */
export function TokenUsage({ usage, estimate, inline = false, copy = true, className = '' }) {
  useInjectCss(css, 'study-token-usage');
  if (!usage && !estimate) return null;
  const rows = estimate ? estimateRows(estimate) : usageRows(usage);
  const line = estimate ? estimateText(estimate) : usageText(usage);
  return <div className={['token-usage', inline ? 'token-usage--inline' : '', className].filter(Boolean).join(' ')} data-token-usage>
    <dl className="token-usage__rows">
      {rows.map((row) => <div key={row.id} className={`token-usage__row token-usage__row--${row.id}`}>
        <dt>{row.label}</dt><dd>{row.value}</dd>
      </div>)}
    </dl>
    {(copy || usage?.calls > 0) && <div className="token-usage__foot">
      {usage?.calls > 0 && <small className="token-usage__calls">{usedCallsText(usage.calls)}</small>}
      {copy && <CopyButton text={line} />}
    </div>}
  </div>;
}

/* ---------- before a run ---------- */

/**
 * The estimate line above a submit button: "预计 58.3K–96.1K tok · 8–10 次模型调用", with an ⓘ button that opens the
 * stages, the same rows as ranges and what the estimate cannot know. `state`: { status, estimate }.
 * A selection over the limit says so in plain sight, not only in the panel.
 */
export function TokenEstimateView({ state = { status: 'idle' }, defaultOpen = false }) {
  useInjectCss(css, 'study-token-usage');
  const [open, setOpen] = useState(defaultOpen);
  const panel = useId();
  const estimate = state.status === 'ready' ? state.estimate : null;
  const notes = (estimate?.notes || []).filter((code) => code !== 'over-limit').map((code) => noteText(code, estimate)).filter(Boolean);
  return <div className="token-estimate" data-token-estimate aria-live="polite">
    {state.status === 'loading' && <small className="token-estimate__quiet">{ui('正在估算…')}</small>}
    {estimate && <>
      <p className="token-estimate__line">
        <span>{estimateSummary(estimate)}</span>
        <button type="button" className="token-estimate__info" aria-expanded={open} aria-controls={panel}
          aria-label={ui('查看估算明细')} title={ui('查看估算明细')} onClick={() => setOpen(!open)}><Icon name="info" size={16} /></button>
      </p>
      {estimate.blocked && <p className="token-estimate__warn" role="status">{noteText('over-limit', estimate)}</p>}
      {open && <div className="token-estimate__panel" id={panel}>
        <ul className="token-estimate__stages">
          {estimate.stages.map((stage) => <li key={stage.id}>
            <span>{stageLabel(stage.id, estimate.feature)} <small>×{stage.calls}</small></span>
            <small>{rangeTok({ low: stage.inputTokens.low + stage.outputTokens.low, high: stage.inputTokens.high + stage.outputTokens.high })}</small>
          </li>)}
        </ul>
        <TokenUsage estimate={estimate} />
        <ul className="token-estimate__notes">
          {notes.map((note) => <li key={note}>{note}</li>)}
          <li>{methodNote()}</li>
        </ul>
      </div>}
    </>}
  </div>;
}

/**
 * Ask `usage.estimate` for `request` once it settles. A new request keeps the last answer on screen until the next one
 * arrives; nothing to estimate (or an estimate that cannot be made) stays quiet.
 */
export function useUsageEstimate(call, request, { enabled = true, delay = 450 } = {}) {
  const key = JSON.stringify(request);
  const [state, setState] = useState({ status: 'idle' });
  const callRef = useRef(call);
  callRef.current = call;
  useEffect(() => {
    if (!enabled || typeof callRef.current !== 'function') { setState({ status: 'idle' }); return undefined; }
    let live = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    const timer = setTimeout(() => {
      Promise.resolve().then(() => callRef.current(request.action || 'usage.estimate', request.args || request)).then(
        (estimate) => { if (live) setState(estimate?.calls?.high > 0 ? { status: 'ready', estimate } : { status: 'idle' }); },
        () => { if (live) setState({ status: 'error' }); },
      );
    }, delay);
    return () => { live = false; clearTimeout(timer); };
  }, [key, enabled, delay]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** The estimate line, connected: `request` is what `usage.estimate` takes (with `feature`); `action` overrides the action name. */
export function TokenEstimate({ call, request, action, enabled = true }) {
  const state = useUsageEstimate(call, action ? { action, args: request } : request, { enabled });
  if (!enabled) return null;
  return <TokenEstimateView state={state} />;
}

/* ---------- after a run ---------- */

/** What a job used, set beside what was expected. Jobs from before usage was recorded show nothing. */
export function JobUsage({ job }) {
  useInjectCss(css, 'study-token-usage');
  if (!job?.tokenUsage && !job?.estimate) return null;
  return <div className="job-usage" data-job-usage>
    {job.tokenUsage && <>
      <strong className="job-usage__title">{ui('实际用量')}</strong>
      <TokenUsage usage={job.tokenUsage} />
    </>}
    {job.estimate && <small className="job-usage__expected">{`${expectedText(job.estimate)} · ${callsText(job.estimate.calls)}`}</small>}
    {usageNotes(job).map((note) => <small key={note} className="job-usage__note">{note}</small>)}
  </div>;
}

/* ---------- the stats section ---------- */

const DAY_CHOICES = [7, 30];

/**
 * 模型用量 in 学习统计: the last 7 or 30 days by feature, each with the DSH rows, and a total. Audio transcription is
 * counted in minutes on its own page; a link points there instead of repeating it. `state`: { status, summary }.
 */
export function ModelUsageView({ state = { status: 'idle' }, days = 30, onDays, onAudio }) {
  useInjectCss(css, 'study-token-usage');
  if (state.status === 'error' || state.status === 'idle') return null;
  const summary = state.status === 'ready' ? state.summary : null;
  const features = summary ? USAGE_FEATURE_ORDER.filter((id) => summary.byFeature?.[id] && totalTokens(summary.byFeature[id]) > 0) : [];
  const biggest = Math.max(1, ...features.map((id) => totalTokens(summary.byFeature[id])));
  const lines = summary && features.length ? [...features.map((id) => `${featureLabel(id)}: ${usageText(summary.byFeature[id])}`),
    `${ui('合计')}: ${usageText(summary.total)}`].join('\n') : '';
  const toggle = <div className="model-usage__days" role="group" aria-label={ui('统计范围')}>
    {DAY_CHOICES.map((choice) => <button key={choice} type="button" className="generate-chip" aria-pressed={days === choice}
      onClick={() => onDays?.(choice)}>{choice === 7 ? ui('近 7 天') : ui('近 30 天')}</button>)}
  </div>;
  return <Panel className="dash-chart model-usage" data-model-usage title={ui('模型用量')}
    description={uiFormat('近 {0} 天，各功能的 token 用量', [days])} actions={toggle}>
    {state.status === 'loading' && <p className="muted">{ui('正在统计模型用量…')}</p>}
    {summary && !features.length && <p className="muted">{ui('还没有模型用量记录。出题、陪学或生成讲解之后，这里会显示 token 用量。')}</p>}
    {summary && features.length > 0 && <>
      <ul className="model-usage__list">
        {features.map((id) => <li key={id} className="model-usage__item">
          <div className="model-usage__name"><strong>{featureLabel(id)}</strong></div>
          <span className="model-usage__bar" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.round(totalTokens(summary.byFeature[id]) / biggest * 100))}%` }} /></span>
          <TokenUsage usage={summary.byFeature[id]} inline copy={false} />
        </li>)}
        <li className="model-usage__item model-usage__item--total">
          <div className="model-usage__name"><strong>{ui('合计')}</strong></div>
          <TokenUsage usage={summary.total} inline copy={false} />
        </li>
      </ul>
      <div className="model-usage__foot">
        <CopyButton text={lines} label={ui('复制各功能的用量')} />
      </div>
    </>}
    <p className="model-usage__audio muted">
      {ui('音频转录按分钟计，不在这里；见「音频转录」页的「用量与额度」。')}
      {onAudio && <> <Button variant="link" size="sm" onClick={onAudio}>{ui('打开音频转录')}</Button></>}
    </p>
  </Panel>;
}

/** 模型用量, connected: asks `usage.summary` for the chosen window. */
export function ModelUsage({ call, onAudio }) {
  const [days, setDays] = useState(30);
  const [state, setState] = useState({ status: 'loading' });
  const callRef = useRef(call);
  callRef.current = call;
  useEffect(() => {
    let live = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    Promise.resolve().then(() => callRef.current('usage.summary', { days })).then(
      (summary) => { if (live) setState({ status: 'ready', summary }); },
      () => { if (live) setState({ status: 'error' }); },
    );
    return () => { live = false; };
  }, [days]);
  return <ModelUsageView state={state} days={days} onDays={setDays} onAudio={onAudio} />;
}

export { joinRows };
