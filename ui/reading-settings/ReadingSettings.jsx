import React, { createElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, IconButton, SegmentedControl } from '../components/index.js';
import { SIZES, readingProps, stepSize } from './settings.js';
import { useReadingSettings } from './store.js';
import css from './reading.css';

/* The one reading control of the study content: the Aa button with its popover (size, text width, typeface, background,
   恢复默认), and the container that applies the setting. The source reader mounts the same popover with its underline row; every
   other surface (review, results, notes, lessons, the skeleton detail pane, the exam report) mounts <ReadingSettingsButton /> and
   wraps its long-form text in <ReadingBlock>. Only text is styled: a control inside a block keeps its own size and face. */

/** The rows of the popover. `underline` (default on) is the reader's row for link underlines; every other surface passes false. */
export function DisplayControls({ settings, onChange, onReset, underline = true }) {
  const pick = key => value => onChange({ [key]: value });
  return <>
    <div className="reader-setting">
      <span className="reader-setting__label">{ui('字号')}</span>
      <div className="reader-stepper">
        <Button size="sm" aria-label={ui('减小字号')} title={ui('减小字号')} disabled={settings.size <= SIZES[0]}
          onClick={() => onChange({ size: stepSize(settings.size, -1) })}><span aria-hidden="true">A−</span></Button>
        <output className="reader-stepper__value" aria-live="polite">{settings.size}</output>
        <Button size="sm" aria-label={ui('增大字号')} title={ui('增大字号')} disabled={settings.size >= SIZES.at(-1)}
          onClick={() => onChange({ size: stepSize(settings.size, 1) })}><span aria-hidden="true">A＋</span></Button>
      </div>
    </div>
    <div className="reader-setting">
      <span className="reader-setting__label">{ui('版心宽度')}</span>
      <SegmentedControl size="sm" label={ui('版心宽度')} value={settings.width} onChange={pick('width')}
        options={[{ value: 'narrow', label: ui('窄') }, { value: 'standard', label: ui('标准') }, { value: 'wide', label: ui('宽') }]} />
    </div>
    <div className="reader-setting">
      <span className="reader-setting__label">{ui('字体')}</span>
      <SegmentedControl size="sm" label={ui('字体')} value={settings.face} onChange={pick('face')}
        options={[{ value: 'sans', label: ui('无衬线') }, { value: 'serif', label: ui('衬线') }]} />
    </div>
    <div className="reader-setting">
      <span className="reader-setting__label">{ui('背景')}</span>
      <SegmentedControl size="sm" label={ui('背景')} value={settings.tone} onChange={pick('tone')}
        options={[{ value: 'auto', label: ui('跟随界面') }, { value: 'paper', label: ui('纸张') }]} />
    </div>
    {underline && <div className="reader-setting reader-setting--inline">
      <span className="reader-setting__label">{ui('下划线')}</span>
      <SegmentedControl size="sm" label={ui('下划线')} value={settings.underline} onChange={pick('underline')}
        options={[{ value: 'show', label: ui('显示') }, { value: 'hide', label: ui('隐藏') }]} />
    </div>}
    <Button size="sm" variant="quiet" className="reader-popover__reset" onClick={onReset}>{ui('恢复默认')}</Button>
  </>;
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The Aa button and its popover for the given settings. Inside the reader the panel is kept within the viewer; elsewhere within the window. */
export function DisplaySettings({ settings, onChange, onReset, underline = true, className }) {
  useInjectCss(css, 'study-reading');
  const [open, setOpen] = useState(false);
  const root = useRef(null), panel = useRef(null), panelId = useId();
  // On a narrow pane the Aa button can sit anywhere along a wrapped toolbar: slide the panel back inside its bounds (a style write, no state).
  useIsoLayoutEffect(() => {
    const element = panel.current, viewer = root.current?.closest('.study-document-viewer');
    if (!open || !element) return;
    element.style.transform = '';
    const box = element.getBoundingClientRect(), margin = 8;
    const bounds = viewer ? viewer.getBoundingClientRect() : { left: 0, right: window.innerWidth };
    let shift = Math.min(0, bounds.right - margin - box.right);
    shift = Math.max(shift, bounds.left + margin - box.left);
    if (shift) element.style.transform = `translateX(${Math.round(shift)}px)`;
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const onKeyDown = event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };
  return <div className={`reader-popover${className ? ` ${className}` : ''}`} ref={root} onKeyDown={onKeyDown}>
    <IconButton icon="type" label={ui('显示设置')} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-pressed={open}
      onClick={() => setOpen(state => !state)} />
    {open && <div className="reader-popover__panel" ref={panel} id={panelId} role="group" aria-label={ui('显示设置')}>
      <DisplayControls settings={settings} onChange={onChange} onReset={onReset} underline={underline} />
    </div>}
  </div>;
}

/** The Aa button wired to the shared setting: size, text width, typeface and background of every reading block, in every open panel. */
export function ReadingSettingsButton({ underline = false, className }) {
  const [settings, update, reset] = useReadingSettings();
  return <DisplaySettings settings={settings} onChange={update} onReset={reset} underline={underline} className={className} />;
}

/** The props (class, face, tone, size variables) a long-form container carries; spread them on any element, or use <ReadingBlock>. */
export function useReadingProps({ prose = false, className = '', style } = {}) {
  useInjectCss(css, 'study-reading');
  const [settings] = useReadingSettings();
  const own = readingProps(settings);
  return { className: ['study-reading', prose ? 'study-reading--prose' : '', className].filter(Boolean).join(' '), 'data-face': own['data-face'], 'data-tone': own['data-tone'], style: { ...own.style, ...style } };
}

/**
 * A long-form text container that follows the shared reading setting. `as`: the element (div by default). `prose`: the container
 * itself is the text (an article with no controls inside), so its own size is the reading size; without it only the text elements
 * inside (paragraphs, lists, tables, quotes) follow, and buttons, inputs and headings' roles stay as designed.
 */
export function ReadingBlock({ as = 'div', prose = false, className, style, children, ...rest }) {
  const props = useReadingProps({ prose, className, style });
  return createElement(as, { ...rest, ...props }, children);
}
