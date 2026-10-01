import React, { useEffect, useId, useRef, useState } from 'react';
import { ui } from '../../i18n.js';
import { Button, IconButton, SegmentedControl } from '../../components/index.js';
import { SIZES, stepSize } from './settings.js';

/** The Aa button and its popover: size, measure, typeface and paper tone. */
export default function DisplaySettings({ settings, onChange, onReset }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null), panelId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const onKeyDown = event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };
  const pick = key => value => onChange({ [key]: value });
  return <div className="reader-popover" ref={root} onKeyDown={onKeyDown}>
    <IconButton icon="type" label={ui('显示设置')} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-pressed={open}
      onClick={() => setOpen(state => !state)} />
    {open && <div className="reader-popover__panel" id={panelId} role="group" aria-label={ui('显示设置')}>
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
      <Button size="sm" variant="quiet" className="reader-popover__reset" onClick={onReset}>{ui('恢复默认')}</Button>
    </div>}
  </div>;
}
