import React, { useId } from 'react';
import css from './fields.css';
import { useComponentCss, cx } from './css.js';
import { Hint } from './Hint.jsx';

/* Checkbox, Switch and RadioCard: the choice rows of every settings page. A bold title, one small hint, the control beside them;
   the whole row is the click target and the input is described by its hint. */

const join = (...ids) => ids.filter(Boolean).join(' ') || undefined;

/**
 * A labelled checkbox row. onChange(checked, event). `hint` is the one note under the label. Everything else (name, data-usage,
 * aria-*) lands on the input.
 */
export function Checkbox({ label, hint, checked, onChange, disabled, role, className, 'aria-describedby': describedBy, ...rest }) {
  useComponentCss(css, 'study-fields');
  const uid = useId(), hintId = hint ? `${uid}-hint` : undefined;
  const isSwitch = role === 'switch';
  return (
    <label className={cx('sh-check', isSwitch && 'sh-switch', disabled && 'is-disabled', className)}>
      <input type="checkbox" role={role} className="sh-check__input" checked={!!checked} disabled={disabled}
        aria-describedby={join(describedBy, hintId)} onChange={event => onChange?.(event.target.checked, event)} {...rest} />
      {isSwitch && <span className="sh-switch__track" aria-hidden="true"><span className="sh-switch__thumb" /></span>}
      <span className="sh-check__text">
        <span className="sh-check__label">{label}</span>
        {hint && <Hint as="span" id={hintId}>{hint}</Hint>}
      </span>
    </label>
  );
}

/** The same row as a switch (role="switch"): for a setting that turns something on or off at once. */
export function Switch(props) {
  return <Checkbox {...props} role="switch" />;
}

/**
 * One choice among a few that deserve a sentence each (a route, a tier, a mode). Put them in a RadioCardGroup. `badges` sit beside
 * the title; onSelect(value) fires when the card is chosen.
 */
export function RadioCard({ name, value, checked, title, hint, badges, onSelect, disabled, className, 'aria-describedby': describedBy, ...rest }) {
  useComponentCss(css, 'study-fields');
  const uid = useId(), hintId = hint ? `${uid}-hint` : undefined;
  return (
    <label className={cx('sh-radio-card', checked && 'is-selected', disabled && 'is-disabled', className)}>
      <input type="radio" className="sh-radio-card__input" name={name} value={value} checked={!!checked} disabled={disabled}
        aria-describedby={join(describedBy, hintId)} onChange={() => onSelect?.(value)} {...rest} />
      <span className="sh-radio-card__body">
        <span className="sh-radio-card__title">{title}{badges && <span className="sh-radio-card__badges">{badges}</span>}</span>
        {hint && <Hint as="span" id={hintId}>{hint}</Hint>}
      </span>
    </label>
  );
}

/** The fieldset that names a set of RadioCards. */
export function RadioCardGroup({ legend, className, children, ...rest }) {
  useComponentCss(css, 'study-fields');
  return <fieldset className={cx('sh-radio-group', className)} {...rest}>{legend && <legend>{legend}</legend>}{children}</fieldset>;
}
