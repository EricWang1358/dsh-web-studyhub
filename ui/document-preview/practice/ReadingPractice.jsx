import React, { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button } from '../../components/index.js';
import { useInjectCss } from '../../shared.js';
import { MasteryMark } from './MasteryMark.jsx';
import { countsLine, meaningLine, questionsWord, rangeLabel, stateLabel } from './mastery-copy.js';
import css from './practice.css';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The note about parked courses: the learner is reading this document, so those questions are offered, and said to be parked. */
export function InactiveNote({ summary, courses = [] }) {
  if (!summary?.inactive) return null;
  const names = courses.filter(Boolean).join('、');
  return <p className="reader-practice__note" role="note">{names
    ? uiFormat('其中 {0} 道在未激活的课程「{1}」里。你正在读这份资料，所以仍可以练习。', [summary.inactive, names])
    : uiFormat('其中 {0} 道在未激活的课程里。你正在读这份资料，所以仍可以练习。', [summary.inactive])}</p>;
}

/**
 * "做这几页的题": the persistent control of the reader and its panel. The panel names what is about to be practised (the range
 * chooser: this page / this chapter / what was just read), how many questions that is and how many are due, new and weak, and
 * only then starts; with no question yet it offers one button, 为这几页出题.
 * Props: `loop` (practice/useReadingLoop), `unit` ('page' | 'slide' | 'section'), `busy`.
 */
export default function ReadingPractice({ loop, unit = 'section', busy = false, onStart, onGenerate }) {
  useInjectCss(css, 'study-reading-loop');
  const { open, setOpen, status, options, kind, setKind, selected } = loop;
  const root = useRef(null), panel = useRef(null), panelId = useId(), groupName = useId();
  // On a narrow pane the button can sit anywhere along the wrapped toolbar: slide the panel back inside the viewer.
  useIsoLayoutEffect(() => {
    const element = panel.current, viewer = root.current?.closest('.study-document-viewer');
    if (!open || !element || !viewer) return;
    element.style.transform = '';
    const box = element.getBoundingClientRect(), bounds = viewer.getBoundingClientRect(), margin = 8;
    let shift = Math.min(0, bounds.right - margin - box.right);
    shift = Math.max(shift, bounds.left + margin - box.left);
    if (shift) element.style.transform = `translateX(${Math.round(shift)}px)`;
  }, [open, status, kind, options.length]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, setOpen]);
  const onKeyDown = event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
  const summary = selected?.summary, total = summary?.total || 0, ready = status === 'ready';
  return <div className="reader-popover reader-practice" ref={root} onKeyDown={onKeyDown} data-tour="reader-practice">
    <Button size="sm" variant="secondary" icon="success" className="reader-practice__button" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-haspopup="dialog" aria-keyshortcuts="P" data-usage="reader.practice" title={ui('做这几页的题 · 快捷键 P')} onClick={() => setOpen(state => !state)}>
      <span className="reader-practice__label">{ui('做这几页的题')}</span>
    </Button>
    {open && <div className="reader-popover__panel reader-practice__panel" ref={panel} id={panelId} role="dialog" aria-label={ui('做这几页的题')}>
      {status === 'loading' && <p className="reader-practice__status" role="status">{ui('正在读取这几页的题…')}</p>}
      {(status === 'error' || status === 'unavailable') && <>
        <p className="reader-practice__status" role="alert">{status === 'unavailable' ? ui('这个版本暂时读不到这几页的题。') : ui('没能读取这几页的题。')}</p>
        <Button size="sm" onClick={loop.reload}>{ui('重试')}</Button>
      </>}
      {ready && <>
        {options.length > 1 && <fieldset className="reader-practice__ranges">
          <legend>{ui('做题范围')}</legend>
          {options.map(option => <label key={option.kind} className="reader-practice__range" data-checked={option.kind === selected.kind || undefined}>
            <input type="radio" name={groupName} value={option.kind} checked={option.kind === selected.kind} onChange={() => setKind(option.kind)} />
            <span>{rangeLabel(option, unit)}</span>
            <small>{option.summary.total ? questionsWord(option.summary.total) : ui('还没出题')}</small>
          </label>)}
        </fieldset>}
        {options.length === 1 && <p className="reader-practice__scope">{rangeLabel(selected, unit)}</p>}
        {total > 0 ? <>
          <p className="reader-practice__counts" data-testid="practice-counts">{countsLine(summary)}</p>
          <p className="reader-practice__mastery"><MasteryMark summary={summary} size={16} />
            <span>{summary.state === 'unlearned' ? stateLabel('unlearned') : `${uiFormat('掌握 {0}%', [summary.percent])} · ${stateLabel(summary.state)}`}</span></p>
          <p className="reader-practice__meaning">{meaningLine()}</p>
          <InactiveNote summary={summary} courses={loop.inactiveCourses} />
          <Button variant="primary" icon="arrow-right" disabled={busy} onClick={() => onStart(selected)}>
            {total === 1 ? ui('开始做这 1 道题') : uiFormat('开始做这 {0} 道题', [total])}</Button>
        </> : <>
          <p className="reader-practice__none" data-testid="practice-none"><MasteryMark summary={null} size={16} /> {ui('这几页还没有题')}</p>
          <Button variant="primary" icon="sparkle" disabled={busy} onClick={() => onGenerate(selected)}>{ui('为这几页出题')}</Button>
        </>}
      </>}
    </div>}
  </div>;
}
