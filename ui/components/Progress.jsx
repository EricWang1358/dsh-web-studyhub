import React from 'react';
import { ui, uiFormat, uiLocale } from '../i18n.js';
import css from './feedback.css';
import { useComponentCss, cx } from './css.js';
import { toneOf } from './tones.js';

const clamp = (value, max) => Math.min(Math.max(Number(value) || 0, 0), max);

/**
 * The one progress bar. A named `role="progressbar"` whose fill is drawn with
 * transform: scaleX (never width), so it moves on the compositor and honours
 * prefers-reduced-motion. `label` is its accessible name. `ahead` draws the
 * part now being worked on, behind the fill; `indeterminate` is for work whose
 * length nobody knows (no aria-valuenow then).
 */
export function ProgressBar({ value = 0, max = 100, label, tone = 'accent', indeterminate = false, size = 'md', ahead = 0, className, ...rest }) {
  useComponentCss(css, 'study-feedback');
  const top = max > 0 ? max : 100;
  const done = clamp(value, top);
  const flight = clamp(done + (Number(ahead) || 0), top);
  return (
    <div className={cx('sh-progress', `sh-progress--${size === 'sm' ? 'sm' : 'md'}`, indeterminate && 'sh-progress--indeterminate', className)}
      data-tone={toneOf(tone, 'accent')} role="progressbar" aria-label={label || ui('进度')}
      aria-valuemin={0} aria-valuemax={top} aria-valuenow={indeterminate ? undefined : done} {...rest}>
      {!indeterminate && flight > done && <span className="sh-progress__ahead" style={{ transform: `scaleX(${flight / top})` }} />}
      <span className="sh-progress__fill" style={indeterminate ? undefined : { transform: `scaleX(${done / top})` }} />
    </div>
  );
}

/**
 * Parts of a whole in one bar. segments: [{ value, tone, label, title? }]; empty
 * ones are not drawn. The bar is one image named by `label` plus its parts (or by
 * `name` when the caller's own sentence reads better); `legend` adds a visible key
 * (outside the image, so it stays readable). size: md | lg (a taller bar for a result).
 */
export function StackedBar({ segments = [], label, name: sentence, legend = false, size = 'md', className, ...rest }) {
  useComponentCss(css, 'study-feedback');
  const parts = segments.filter(part => Number(part?.value) > 0);
  const list = new Intl.ListFormat(uiLocale(), { style: 'narrow', type: 'unit' });
  const spoken = parts.map(part => `${part.label ?? ''} ${part.value}`.trim());
  const name = sentence || (spoken.length ? uiFormat('{0}：{1}', [label || ui('分布'), list.format(spoken)]) : label || ui('分布'));
  return (
    <div className={cx('sh-stacked', size === 'lg' && 'sh-stacked--lg', className)} {...rest}>
      <div className="sh-stacked__bar" role="img" aria-label={name}>
        {parts.map((part, index) => <span key={index} className="sh-stacked__segment" data-tone={toneOf(part.tone)} title={part.title} style={{ flexGrow: Number(part.value) }} />)}
      </div>
      {legend && parts.length > 0 && <ul className="sh-stacked__legend">
        {parts.map((part, index) => <li key={index} className="sh-stacked__key" data-tone={toneOf(part.tone)}>
          <span className="sh-stacked__swatch" aria-hidden="true" />{part.label} <strong>{part.value}</strong>
        </li>)}
      </ul>}
    </div>
  );
}
