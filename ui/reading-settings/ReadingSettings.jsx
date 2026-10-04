import React, { createElement } from 'react';
import { ui } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, IconButton, Popover, SegmentedControl } from '../components/index.js';
import { FONT_PRESETS } from '../font-presets.js';
import { FACES, SIZES, readingProps, stepSize } from './settings.js';
import { useReadingSettings } from './store.js';
import css from './reading.css';

/* The one reading control of the study content: the Aa button with its popover (size, text width, typeface, background,
   恢复默认), and the container that applies the setting. The source reader mounts the same popover with its underline row; every
   other surface (review, results, notes, lessons, the skeleton detail pane, the exam report) mounts <ReadingSettingsButton /> and
   wraps its long-form text in <ReadingBlock>. Only text is styled: a control inside a block keeps its own size and face. */

/** The reader's typefaces from the font registry (`sans` follows the interface), and the three light steps of 排版微调. */
const faceOptions = () => FACES.map(id => ({ value: id, label: ui(id === 'sans' ? '跟随界面' : FONT_PRESETS[id].label) }));
const SPACING = [['tight', '紧凑'], ['standard', '标准'], ['loose', '宽松']];
const FINE_TUNING = [['weight', '字重', [['normal', '标准'], ['medium', '稍粗'], ['bold', '加粗']]], ['leading', '行距', SPACING], ['gap', '段间距', SPACING]];

/** The rows of the popover. `underline` (default on) is the reader's row for link underlines; every other surface passes false. */
export function DisplayControls({ settings, onChange, onReset, underline = true, extra = null }) {
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
      <select className="reader-select" aria-label={ui('字体')} value={settings.face} onChange={event => onChange({ face: event.target.value })}>
        {faceOptions().map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
    <div className="reader-setting">
      <span className="reader-setting__label">{ui('背景')}</span>
      <SegmentedControl size="sm" label={ui('背景')} value={settings.tone} onChange={pick('tone')}
        options={[{ value: 'auto', label: ui('跟随界面') }, { value: 'paper', label: ui('纸张') }]} />
    </div>
    <details className="reader-more">
      <summary className="reader-setting__label">{ui('排版微调')}</summary>
      {FINE_TUNING.map(([key, label, options]) => <div className="reader-setting" key={key}>
        <span className="reader-setting__label">{ui(label)}</span>
        <SegmentedControl size="sm" label={ui(label)} value={settings[key]} onChange={pick(key)}
          options={options.map(([value, text]) => ({ value, label: ui(text) }))} />
      </div>)}
    </details>
    {underline && <div className="reader-setting reader-setting--inline">
      <span className="reader-setting__label">{ui('下划线')}</span>
      <SegmentedControl size="sm" label={ui('下划线')} value={settings.underline} onChange={pick('underline')}
        options={[{ value: 'show', label: ui('显示') }, { value: 'hide', label: ui('隐藏') }]} />
    </div>}
    {extra}
    <Button size="sm" variant="quiet" className="reader-popover__reset" onClick={onReset}>{ui('恢复默认')}</Button>
  </>;
}

/** The Aa button and its popover for the given settings. Inside the reader the panel is kept within the viewer; elsewhere within the window. */
export function DisplaySettings({ settings, onChange, onReset, underline = true, className, extra = null }) {
  useInjectCss(css, 'study-reading');
  // On a narrow pane the Aa button can sit anywhere along a wrapped toolbar: Popover slides the panel back inside its bounds at any interface zoom.
  return <Popover label={ui('显示设置')} icon="type" className={`reader-popover${className ? ` ${className}` : ''}`} panelClassName="reader-popover__panel"
    boundsSelector=".study-document-viewer" flip={false}
    trigger={({ props, ref }) => <IconButton ref={ref} icon="type" label={ui('显示设置')} data-usage="reader.display" {...props} />}>
    <DisplayControls settings={settings} onChange={onChange} onReset={onReset} underline={underline} extra={extra} />
  </Popover>;
}

/** The Aa button wired to the shared setting: size, text width, typeface and background of every reading block, in every open panel. */
export function ReadingSettingsButton({ underline = false, className }) {
  const [settings, update, reset] = useReadingSettings();
  return <DisplaySettings settings={settings} onChange={update} onReset={reset} underline={underline} className={className} />;
}

/** The props (class, face, tone, size variables) a long-form container carries; spread them on any element, or use <ReadingBlock>. */
export function useReadingProps({ prose = false, measure = prose, className = '', style } = {}) {
  useInjectCss(css, 'study-reading');
  const [settings] = useReadingSettings();
  const own = readingProps(settings);
  return { className: ['study-reading', prose ? 'study-reading--prose' : '', measure ? 'study-reading--measure' : '', className].filter(Boolean).join(' '), 'data-face': own['data-face'], 'data-tone': own['data-tone'], style: { ...own.style, ...style } };
}

/**
 * A long-form text container that follows the shared reading setting. `as`: the element (div by default). `prose`: the container
 * itself is the text (an article with no controls inside), so its own size is the reading size; without it only the text elements
 * inside (paragraphs, lists, tables, quotes) follow, and buttons, inputs and headings' roles stay as designed. `measure` (on for prose):
 * the block is held to the chosen text width; a block laid out in columns (the skeleton spine) keeps its own width.
 */
export function ReadingBlock({ as = 'div', prose = false, measure = prose, className, style, children, ...rest }) {
  const props = useReadingProps({ prose, measure, className, style });
  return createElement(as, { ...rest, ...props }, children);
}
