import React from 'react';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';

/**
 * A small set of mutually exclusive choices (language, theme, view mode). The
 * active segment is filled and announced with aria-pressed, so "which one is
 * on" never depends on colour alone.
 * options: [{ value, label, icon?, title?, disabled? }]
 */
export default function SegmentedControl({ label, value, options = [], onChange, size = 'md', disabled = false, className, ...rest }) {
  useComponentCss(css);
  return (
    <div role="group" aria-label={label} className={cx('sh-seg', size === 'sm' && 'sh-seg--sm', className)} {...rest}>
      {options.map(option => {
        const active = option.value === value;
        return (
          <button type="button" key={option.value} className={active ? 'sh-seg__item is-active' : 'sh-seg__item'} aria-pressed={active}
            title={option.title} disabled={disabled || option.disabled} onClick={() => { if (!active) onChange?.(option.value); }}>
            {option.icon ? <Icon name={option.icon} size={16} /> : null}{option.label}
          </button>
        );
      })}
    </div>
  );
}
