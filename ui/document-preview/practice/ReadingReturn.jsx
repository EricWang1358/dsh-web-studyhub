import React, { useRef } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { useInjectCss } from '../../shared.js';
import { Button, Icon, Tooltip } from '../../components/index.js';
import { cx } from '../../components/css.js';
import { useCut } from '../../use-cut.js';
import { MasteryMark } from './MasteryMark.jsx';
import { meaningLine, scopeLabel } from './mastery-copy.js';
import { firstCitation } from './citations.js';
import css from './practice.css';

/* The way back to the text from the practice page (ui/Review.jsx). Everything here reads `run.reading`, the context the run keeps
   in the library (lib/reading-return.js), so it is there after the app was closed and opened again. */

/* The words of a mastery change, by what was measured: the pages a reader round was started on, or the questions of any other round. */
const CHANGE_WORDS = {
  pages: ['这几页的掌握度 {0}%（这一轮没有变化）', '这几页的掌握度 {0}% → {1}%'],
  round: ['本组掌握度 {0}%（这一轮没有变化）', '本组掌握度 {0}% → {1}%'],
};

/** "这几页的掌握度 41% → 58%" (kind 'pages') or "本组掌握度 41% → 58%" (kind 'round'; 本组 is the deck's one name, #1684): the same cards, before the first answer and now
    (`change` is { before, after }: run.reading or run.mastery, lib/run-mastery.js). Empty when either side has no questions. */
export function masteryChangeText(change, kind = 'pages') {
  const before = change?.before, after = change?.after;
  if (!before?.total || !after?.total) return '';
  const [same, moved] = CHANGE_WORDS[kind] || CHANGE_WORDS.pages;
  if (before.percent === after.percent) return uiFormat(same, [after.percent]);
  return uiFormat(moved, [before.percent, after.percent]);
}

/** Factual tier shifts derived strictly from the round's before/after summaries. */
export function masteryShiftParts(change) {
  const before = change?.before, after = change?.after;
  if (!before?.total || !after?.total) return [];
  const started = Math.max(0, (before.fresh || 0) - (after.fresh || 0));
  const clearedWeak = Math.max(0, (before.weak || 0) - (after.weak || 0));
  const reviewedDue = Math.max(0, (before.due || 0) - (after.due || 0));
  return [
    started > 0 && uiFormat('新学 {0} 题', [started]),
    clearedWeak > 0 && uiFormat('消除薄弱 {0} 题', [clearedWeak]),
    reviewedDue > 0 && uiFormat('完成待复习 {0} 题', [reviewedDue]),
    after.state === 'mastered' && before.state !== 'mastered' && ui('整组达标'),
  ].filter(Boolean);
}

/** The mastery change block, the same on every result page: the mark of those cards now, the change in words, a dual-layer before/after rail, and factual tier shifts. */
export function MasteryChange({ change, kind = 'pages', className }) {
  useInjectCss(css, 'study-reading-loop');
  const text = masteryChangeText(change, kind);
  if (!text) return null;
  const beforePct = Math.max(0, Math.min(100, Number(change.before.percent) || 0));
  const afterPct = Math.max(0, Math.min(100, Number(change.after.percent) || 0));
  const delta = afterPct - beforePct;
  const mastered = change.after?.state === 'mastered';
  const shifts = masteryShiftParts(change);
  return <div className={cx('reading-result__change', className)} data-testid="mastery-change" data-rose={delta > 0 ? 'true' : undefined} data-mastered={mastered ? 'true' : undefined}>
    <p className="reading-result__headline">
      <MasteryMark summary={change.after} size={18} />
      {' '}
      <strong>{text}</strong>
      {delta > 0 && <span className="reading-result__delta">{` +${delta}%`}</span>}
    </p>
    <div className="reading-result__rail" aria-hidden="true">
      <span className="reading-result__after" style={{ transform: `scaleX(${afterPct / 100})` }} />
      <span className="reading-result__before" style={{ transform: `scaleX(${Math.min(beforePct, afterPct) / 100})` }} />
    </div>
    {shifts.length > 0 && <p className="reading-result__shifts">{shifts.join(' · ')}</p>}
  </div>;
}

/** Where the way back leads: the page or section the reader was on. */
export function placeText(reading) {
  const where = reading?.sectionTitle || (reading?.page ? uiFormat('第 {0} 页', [reading.page]) : '');
  return where ? uiFormat('回到「{0}」', [where]) : ui('回到你读到的位置');
}

/** The primary button of a way back: what it does, and in quiet type under it where it leads. `arrow` puts the back arrow (the Phosphor icon, the one arrow of every way
    back in this family: the reader's 回到阅读 and the review book's 回到复习全书 alike) before the label; `oneLine` keeps the second line to one line, and the whole of it is
    in a tooltip when it was cut (a narrow screen, a long title). */
export function ReturnPrimary({ label, place, onReturn, disabled, lock, arrow = false, oneLine = false, className }) {
  useInjectCss(css, 'study-reading-loop');
  const line = useRef(null), cut = useCut(line, place);
  const button = <Button variant="primary" wrap align="start" className={cx('reading-result__return', className)} disabled={disabled} lock={lock} onClick={onReturn}>
    {arrow ? <span className="reading-result__label"><Icon name="arrow-left" size={18} /> {label}</span> : label}
    {place && <small ref={line} className={oneLine ? 'reading-result__place' : undefined}>{place}</small>}</Button>;
  return oneLine ? <Tooltip layer content={cut ? place : ''} placement="bottom-start" anchorClassName="reading-result__anchor">{button}</Tooltip> : button;
}

/** On the result page of a run that started from reading: the mastery change and 回到阅读 as the next step. */
export function ReadingResult({ run, onReturn, busy }) {
  useInjectCss(css, 'study-reading-loop');
  const reading = run?.reading;
  if (!reading) return null;
  const rose = reading.after?.percent > reading.before?.percent;
  const mastered = reading.after?.state === 'mastered';
  return <section className="reading-result" aria-label={ui('这几页的掌握度')} data-rose={rose || undefined} data-mastered={mastered ? 'true' : undefined}>
    <MasteryChange change={reading} />
    <p className="reading-result__meaning muted">{scopeLabel(reading.scope)} · {meaningLine()}</p>
    <ReturnPrimary arrow label={ui('回到阅读')} place={placeText(reading)} lock={busy} onReturn={() => onReturn(reading)} />
  </section>;
}

/** In the header of an open run: back to the text without leaving the run. */
export function ReadingBackButton({ run, onReturn, busy }) {
  useInjectCss(css, 'study-reading-loop');
  if (!run?.reading) return null;
  // The same size as its neighbours in the header (在右栏打开, 返回学习库): a smaller one beside two larger ones read as a mistake.
  return <Button icon="arrow-left" variant="quiet" className="reading-back" lock={busy} title={placeText(run.reading)} onClick={() => onReturn(run.reading)}>{ui('回到原文')}</Button>;
}

/** After an answer, right or wrong (the answer is revealed with it): open the passage the question points at, with a way back to this very question. */
export function WrongAnswerSource({ run, sources, onOpen }) {
  useInjectCss(css, 'study-reading-loop');
  if (!run?.feedback || !run.solution) return null;
  const found = firstCitation(run.solution, sources || []);
  if (!found) return null;
  return <Button iconEnd="arrow-right" size="sm" className="reading-source" onClick={() => onOpen(found.source, found.quote)}>{ui('看这题的原文')}</Button>;
}
