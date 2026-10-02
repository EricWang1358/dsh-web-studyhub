import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ui } from '../../i18n.js';
import { Button, IconButton, SegmentedControl } from '../../components/index.js';
import { SIZES, stepSize } from './settings.js';

/** The rows of the popover: size, measure, typeface, paper tone and the link underlines. */
export function DisplayControls({ settings, onChange, onReset, extra = null }) {
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
    <div className="reader-setting reader-setting--inline">
      <span className="reader-setting__label">{ui('下划线')}</span>
      <SegmentedControl size="sm" label={ui('下划线')} value={settings.underline} onChange={pick('underline')}
        options={[{ value: 'show', label: ui('显示') }, { value: 'hide', label: ui('隐藏') }]} />
    </div>
    {extra}
    <Button size="sm" variant="quiet" className="reader-popover__reset" onClick={onReset}>{ui('恢复默认')}</Button>
  </>;
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The Aa button and its popover. */
export default function DisplaySettings({ settings, onChange, onReset, extra = null }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null), panel = useRef(null), panelId = useId();
  // On a narrow pane the Aa button can sit anywhere along the wrapped toolbar: slide the panel back inside the viewer (a style write, no state).
  useIsoLayoutEffect(() => {
    const element = panel.current, viewer = root.current?.closest('.study-document-viewer');
    if (!open || !element || !viewer) return;
    element.style.transform = '';
    const box = element.getBoundingClientRect(), bounds = viewer.getBoundingClientRect(), margin = 8;
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
  return <div className="reader-popover" ref={root} onKeyDown={onKeyDown}>
    <IconButton icon="type" label={ui('显示设置')} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-pressed={open}
      onClick={() => setOpen(state => !state)} />
    {open && <div className="reader-popover__panel" ref={panel} id={panelId} role="group" aria-label={ui('显示设置')}>
      <DisplayControls settings={settings} onChange={onChange} onReset={onReset} extra={extra} />
    </div>}
  </div>;
}
