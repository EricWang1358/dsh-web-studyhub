import React from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { useInjectCss } from '../../shared.js';
import { Button } from '../../components/index.js';
import { MasteryMark } from './MasteryMark.jsx';
import { meaningLine, scopeLabel } from './mastery-copy.js';
import { firstCitation } from './citations.js';
import css from './practice.css';

/* The way back to the text from the practice page (ui/Review.jsx). Everything here reads `run.reading`, the context the run keeps
   in the library (lib/reading-return.js), so it is there after the app was closed and opened again. */

/** "这几页的掌握度 41% → 58%": the same cards, before the first answer and now. */
export function masteryChangeText(reading) {
  const before = reading?.before, after = reading?.after;
  if (!before?.total || !after?.total) return '';
  if (before.percent === after.percent) return uiFormat('这几页的掌握度 {0}%（这一轮没有变化）', [after.percent]);
  return uiFormat('这几页的掌握度 {0}% → {1}%', [before.percent, after.percent]);
}

/** Where the way back leads: the page or section the reader was on. */
export function placeText(reading) {
  const where = reading?.sectionTitle || (reading?.page ? uiFormat('第 {0} 页', [reading.page]) : '');
  return where ? uiFormat('回到「{0}」', [where]) : ui('回到你读到的位置');
}

/** On the result page of a run that started from reading: the mastery change and 回到阅读 as the next step. */
export function ReadingResult({ run, onReturn, busy }) {
  useInjectCss(css, 'study-reading-loop');
  const reading = run?.reading;
  if (!reading) return null;
  const text = masteryChangeText(reading), rose = reading.after?.percent > reading.before?.percent;
  return <section className="reading-result" aria-label={ui('这几页的掌握度')} data-rose={rose || undefined}>
    {text && <p className="reading-result__change" data-testid="mastery-change"><MasteryMark summary={reading.after} size={18} /> <strong>{text}</strong></p>}
    <p className="reading-result__meaning muted">{scopeLabel(reading.scope)} · {meaningLine()}</p>
    <Button variant="primary" wrap align="start" className="reading-result__return" disabled={busy} onClick={() => onReturn(reading)}>{ui('回到阅读')} →
      <small>{placeText(reading)}</small></Button>
  </section>;
}

/** In the header of an open run: back to the text without leaving the run. */
export function ReadingBackButton({ run, onReturn, busy }) {
  useInjectCss(css, 'study-reading-loop');
  if (!run?.reading) return null;
  // The same size as its neighbours in the header (在右栏打开, 返回学习库): a smaller one beside two larger ones read as a mistake.
  return <Button variant="quiet" className="reading-back" disabled={busy} title={placeText(run.reading)} onClick={() => onReturn(run.reading)}>{ui('回到原文')}</Button>;
}

/** After an answer, right or wrong (the answer is revealed with it): open the passage the question points at, with a way back to this very question. */
export function WrongAnswerSource({ run, sources, onOpen }) {
  useInjectCss(css, 'study-reading-loop');
  if (!run?.feedback || !run.solution) return null;
  const found = firstCitation(run.solution, sources || []);
  if (!found) return null;
  return <Button size="sm" className="reading-source" onClick={() => onOpen(found.source, found.quote)}>{ui('看这题的原文')}</Button>;
}
