import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { useInjectCss } from '../../shared.js';
import { Button, Icon, Tooltip } from '../../components/index.js';
import { cx } from '../../components/css.js';
import { MasteryMark } from './MasteryMark.jsx';
import { meaningLine, scopeLabel } from './mastery-copy.js';
import { firstCitation } from './citations.js';
import css from './practice.css';

/* The way back to the text from the practice page (ui/Review.jsx). Everything here reads `run.reading`, the context the run keeps
   in the library (lib/reading-return.js), so it is there after the app was closed and opened again. */

/* The words of a mastery change, by what was measured: the pages a reader round was started on, or the questions of any other round. */
const CHANGE_WORDS = {
  pages: ['这几页的掌握度 {0}%（这一轮没有变化）', '这几页的掌握度 {0}% → {1}%'],
  round: ['这组题掌握度 {0}%（这一轮没有变化）', '这组题掌握度 {0}% → {1}%'],
};

/** "这几页的掌握度 41% → 58%" (kind 'pages') or "这组题掌握度 41% → 58%" (kind 'round'): the same cards, before the first answer and now
    (`change` is { before, after }: run.reading or run.mastery, lib/run-mastery.js). Empty when either side has no questions. */
export function masteryChangeText(change, kind = 'pages') {
  const before = change?.before, after = change?.after;
  if (!before?.total || !after?.total) return '';
  const [same, moved] = CHANGE_WORDS[kind] || CHANGE_WORDS.pages;
  if (before.percent === after.percent) return uiFormat(same, [after.percent]);
  return uiFormat(moved, [before.percent, after.percent]);
}

/** The one line of a mastery change, the same on every result page: the mark of those cards now and the change in words. Nothing when there is no change to say. */
export function MasteryChange({ change, kind = 'pages', className }) {
  useInjectCss(css, 'study-reading-loop');
  const text = masteryChangeText(change, kind);
  if (!text) return null;
  return <p className={cx('reading-result__change', className)} data-testid="mastery-change"><MasteryMark summary={change.after} size={18} /> <strong>{text}</strong></p>;
}

/** Where the way back leads: the page or section the reader was on. */
export function placeText(reading) {
  const where = reading?.sectionTitle || (reading?.page ? uiFormat('第 {0} 页', [reading.page]) : '');
  return where ? uiFormat('回到「{0}」', [where]) : ui('回到你读到的位置');
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Is the text of this element cut by its width (one line, ellipsis)? Measured again when the element is resized. */
function useCut(ref, text) {
  const [cut, setCut] = useState(false);
  useIsoLayoutEffect(() => {
    const element = ref.current;
    if (!element) { setCut(false); return undefined; }
    const measure = () => setCut(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text]);
  return cut;
}

/** The primary button of a way back: what it does, and in quiet type under it where it leads. `arrow` puts the back arrow (the Phosphor icon, the one arrow of every way
    back in this family: the reader's 回到阅读 and the review book's 回到复习全书 alike) before the label; `oneLine` keeps the second line to one line, and the whole of it is
    in a tooltip when it was cut (a narrow screen, a long title). */
export function ReturnPrimary({ label, place, onReturn, disabled, arrow = false, oneLine = false, className }) {
  useInjectCss(css, 'study-reading-loop');
  const line = useRef(null), cut = useCut(line, place);
  const button = <Button variant="primary" wrap align="start" className={cx('reading-result__return', className)} disabled={disabled} onClick={onReturn}>
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
  return <section className="reading-result" aria-label={ui('这几页的掌握度')} data-rose={rose || undefined}>
    <MasteryChange change={reading} />
    <p className="reading-result__meaning muted">{scopeLabel(reading.scope)} · {meaningLine()}</p>
    <ReturnPrimary arrow label={ui('回到阅读')} place={placeText(reading)} disabled={busy} onReturn={() => onReturn(reading)} />
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
