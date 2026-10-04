import React, { useEffect, useState } from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, InlineMessage } from './components/index.js';
import { JevDecidedBadge as DecidedBadge } from './JevBadge.jsx';
import { lineText, percentText, probabilityRows } from './jev-flow.js';
import css from './jev.css';

/* EXPERIMENTAL 课程归属建议 inside the 整理课程归属 organizer (ui/Sources.jsx): a "Jev 建议" button next to "请 AI 建议", and the
   probabilities under each suggested row. It exists only while the learner has switched the experiment on in Settings; it
   never applies anything: its rows go through the same checkbox, course field and "确认应用建议" button as the AI's. */

/** Whether the learner switched the experiment on (asks once, quietly; a failure just means "no"). */
export function useJevCourseSuggest(call, initial) {
  const [on, setOn] = useState(initial ?? false);
  useEffect(() => {
    if (initial !== undefined || typeof call !== 'function') return undefined;
    let live = true;
    Promise.resolve(call('jev.settings.get', {})).then(view => { if (live) setOn(!!(view?.enabled && view.features?.courseSuggest)); }, () => {});
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return on;
}

/** "由 Jev 判定": on a course suggestion row that Jev answered instead of the model (the draft's badge, scope row). */
export const JevDecidedBadge = () => <DecidedBadge scope="row" />;

/** One quiet line after a run in which Jev answered instead of the model: how many each took and, once, why the model took some. Nothing when the site is off. */
export function JevRunNote({ jev }) {
  useInjectCss(css, 'study-jev');
  if (!jev?.enabled) return null;
  return (
    <p className="muted jev-run-note" data-jev-run>
      {uiFormat('Jev（实验性）给出了 {0} 条建议，其余 {1} 条由模型给出。', [jev.jev, jev.model])}
      {jev.fallback?.message ? ` ${jev.fallback.message}` : ''}
    </p>
  );
}

/** The button. `run(sourceIds)` starts the request (the page's own single-flight `act`), so busy states and errors are the page's. */
export function JevSuggestButton({ enabled, disabled, onClick }) {
  // Nothing at all (not even the stylesheet) is drawn unless the experiment is on.
  return enabled ? <JevSuggestControl disabled={disabled} onClick={onClick} /> : null;
}
function JevSuggestControl({ disabled, onClick }) {
  useInjectCss(css, 'study-jev');
  return <button type="button" className="jev-suggest-button" disabled={disabled} onClick={onClick} data-experimental="true">{ui('Jev 建议')}<Badge tone="info" size="sm" className="jev-chip">{ui('实验性')}</Badge></button>;
}

/** Why Jev could not help, in one quiet line; the existing "请 AI 建议" and the manual field are still there. */
export function JevNote({ note }) {
  useInjectCss(css, 'study-jev');
  if (!note) return null;
  return <InlineMessage tone="warning" className="jev-note">{uiMessage(note)} {ui('可以用「请 AI 建议」，或直接手动选择课程。')}</InlineMessage>;
}

/** The probabilities behind one suggested row: the top courses as bars, "none of these", and the threshold line. */
export function JevProbabilities({ jev }) {
  useInjectCss(css, 'study-jev');
  if (!jev) return null;
  const rows = probabilityRows(jev);
  return (
    <div className="jev-probs" data-jev-probs data-filled={jev.filled ? 'true' : 'false'}>
      <p className="jev-probs__head"><Badge tone="info" size="sm" className="jev-chip">{ui('Jev 建议')}</Badge><small>{ui('实验性')} · {lineText(jev)} · {jev.filled ? ui('已填入') : ui('把握不够，没有填入')}</small></p>
      <ul className="jev-probs__list">
        {rows.map(row => <li key={row.id} className={`jev-prob${row.picked ? ' is-picked' : ''}${row.none ? ' is-none' : ''}`}>
          <span className="jev-prob__name">{row.label}</span>
          <span className="jev-prob__bar" aria-hidden="true"><i style={{ width: `${Math.max(2, Math.round(row.value * 100))}%` }} /></span>
          <span className="jev-prob__value">{percentText(row.value)}</span>
        </li>)}
      </ul>
    </div>
  );
}
