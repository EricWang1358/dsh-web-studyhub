import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge } from './components/index.js';
import { percentText, triageRows } from './jev-flow.js';
import css from './jev.css';

/* EXPERIMENTAL 出题预审 in the draft: a small "Jev 预审" badge on a card's summary line and, inside the opened card, the probabilities Jev gave
   (the chance that each defect is present). It is a signal only: the independent review is what decided whether the card is here. */

/** "由 Jev 判定": the small mark on a card (scope "card") or a course suggestion row (scope "row") that Jev answered instead of the model. EXPERIMENTAL, hidden unless experimental features are shown. */
export function JevDecidedBadge({ scope = 'card' }) {
  useInjectCss(css, 'study-jev');
  return <Badge tone="info" size="sm" data-jev-decided={scope}>{ui('由 Jev 判定')}<span className="jev-badge__exp"> · {ui('实验性')}</span></Badge>;
}

/** One quiet paragraph above the cards: how many Jev judged and how many the independent model review did, and (once) why the model took some. */
export function JevDecidedNote({ decided }) {
  useInjectCss(css, 'study-jev');
  if (!decided?.judged) return null;
  return (
    <p className="quality-note jev-decided-note" data-jev-decided="summary">
      {uiFormat('Jev（实验性）判定了 {0} 题（通过 {1}，不通过 {2}）', [decided.judged, decided.accepted, decided.rejected])}
      {decided.model > 0 ? uiFormat('，其余 {0} 题由独立模型复审。', [decided.model]) : ui('，没有调用独立模型复审。')}
      {decided.fallback?.message ? ` ${decided.fallback.message}` : ''}
    </p>
  );
}

/** The badge for the card's summary line. Nothing when Jev did not look at this card. */
export function JevCardBadge({ signal }) {
  useInjectCss(css, 'study-jev');
  if (!signal) return null;
  const state = signal.rewritten ? 'rewritten' : signal.flagged ? 'flagged' : 'clear';
  const text = { rewritten: ui('Jev 预审 · 已改写'), flagged: ui('Jev 预审 · 有疑点'), clear: ui('Jev 预审 · 未见明显问题') }[state];
  const tone = { rewritten: 'info', flagged: 'warning', clear: 'success' }[state];
  return <Badge tone={tone} size="sm" icon={state === 'flagged'} data-jev-badge={state}>{text}<span className="jev-badge__exp"> · {ui('实验性')}</span></Badge>;
}

/** The probabilities behind the badge, shown inside the opened card. */
export function JevCardSignals({ signal, threshold }) {
  useInjectCss(css, 'study-jev');
  if (!signal) return null;
  const rows = triageRows(signal);
  return (
    <div className="jev-card-signals" data-jev-signals>
      <p className="jev-card-signals__head"><Badge tone="info" size="sm" className="jev-chip">{ui('实验性')}</Badge>
        <strong>{ui('Jev 预审')}</strong>
        <small>{uiFormat('判断线 {0}；只是参考，最终以独立复审为准。', [percentText(threshold ?? 0.8)])}</small></p>
      <ul className="jev-probs__list">
        {rows.map(row => <li key={row.id} className={`jev-prob${row.failed ? ' is-picked' : ''}`}>
          <span className="jev-prob__name">{row.label}</span>
          <span className="jev-prob__bar" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.round(row.value * 100))}%` }} /></span>
          <span className="jev-prob__value">{percentText(row.value)}</span>
        </li>)}
      </ul>
      {signal.rewritten && <p className="jev-card-signals__note">{ui('这道题按上面的问题改写过一次（下面是改写后的题目），之后仍通过了独立复审。数字是 Jev 对改写前原题的判断。')}</p>}
      <p className="jev-card-signals__note">{ui('数字是这个问题存在的可能性。')}</p>
    </div>
  );
}
