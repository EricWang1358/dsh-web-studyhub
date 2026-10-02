import React, { useEffect, useState } from 'react';
import { ui, uiMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { InlineMessage } from './components/index.js';
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

/** The button. `run(sourceIds)` starts the request (the page's own single-flight `act`), so busy states and errors are the page's. */
export function JevSuggestButton({ enabled, disabled, onClick }) {
  useInjectCss(css, 'study-jev');
  if (!enabled) return null;
  return <button type="button" className="jev-suggest-button" disabled={disabled} onClick={onClick} data-experimental="true">{ui('Jev 建议')}<span className="audio-chip audio-chip--accent jev-chip">{ui('实验性')}</span></button>;
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
      <p className="jev-probs__head"><span className="audio-chip audio-chip--accent jev-chip">{ui('Jev 建议')}</span><small>{ui('实验性')} · {lineText(jev)} · {jev.filled ? ui('已填入') : ui('把握不够，没有填入')}</small></p>
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
