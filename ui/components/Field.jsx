import React, { cloneElement, forwardRef, isValidElement, useId } from 'react';
import css from './fields.css';
import { useComponentCss, cx } from './css.js';
import { Hint } from './Hint.jsx';

/* One label + control + hint + error. The label, the hint (always the same size) and the spacing are the same on every
   settings page; the control gets its id and aria-describedby / aria-invalid from here, so nothing is wired by hand. */

const WIDTHS = new Set(['sm', 'md', 'full']);
const NATIVE_CONTROLS = new Set(['input', 'select', 'textarea']);

/**
 * `label` names the control; `hint` is the one small note under it; `error` replaces nothing but adds an alert and marks the
 * control aria-invalid. `htmlFor` keeps a control's own id; `inline` puts the label beside the control; `width` caps the field
 * (sm | md (default) | full); `required` marks it and sets `required` on the control. `group` is for a control that carries its own
 * name (a SegmentedControl): the label becomes plain text and only the hint wiring is added. `children` is one element (cloned with
 * id / aria props) or a function ({ id, describedBy, invalid }) for anything else.
 */
export function Field({ label, hint, error, htmlFor, inline = false, width = 'md', required = false, group = false, className, children, ...rest }) {
  useComponentCss(css, 'study-fields');
  const uid = useId();
  const only = typeof children !== 'function' && isValidElement(children) ? children : null;
  const controlId = htmlFor || only?.props.id || `${uid}-control`;
  const hintId = hint ? `${uid}-hint` : undefined, errorId = error ? `${uid}-error` : undefined;
  const describedBy = [only?.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
  let control = children;
  if (typeof children === 'function') control = children({ id: controlId, describedBy, invalid: !!error });
  else if (only) {
    const takesRequired = typeof only.type !== 'string' || NATIVE_CONTROLS.has(only.type);
    control = cloneElement(only, { ...(group ? {} : { id: controlId }), 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': true } : {}),
      ...(required && !group && takesRequired ? { required: true } : {}) });
  }
  const text = label && (<>{label}{required && <span className="sh-field__required" aria-hidden="true">*</span>}</>);
  return (
    <div className={cx('sh-field', `sh-field--${WIDTHS.has(width) ? width : 'md'}`, inline && 'sh-field--inline', className)} {...rest}>
      {text && (group ? <span className="sh-field__label">{text}</span> : <label className="sh-field__label" htmlFor={controlId}>{text}</label>)}
      {control}
      {hint && <Hint id={hintId}>{hint}</Hint>}
      {error && <Hint id={errorId} tone="error" role="alert">{error}</Hint>}
    </div>
  );
}

/** The text-like inputs: one look (.sh-input), every attribute passed through. `invalid` is for a page that sets it without a Field. */
export const TextInput = forwardRef(function TextInput({ type = 'text', invalid, className, ...rest }, ref) {
  useComponentCss(css, 'study-fields');
  return <input ref={ref} type={type} className={cx('sh-input', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const TextArea = forwardRef(function TextArea({ rows = 3, invalid, className, ...rest }, ref) {
  useComponentCss(css, 'study-fields');
  return <textarea ref={ref} rows={rows} className={cx('sh-input', className)} aria-invalid={invalid || undefined} {...rest} />;
});

/** The single-choice dropdown (ui/components/Select.jsx: Base UI, options as data). It replaces the native <select>; Combobox is its searchable sibling. */
export { Select } from './Select.jsx';

/** A number input; `suffix` (a unit such as 分钟) sits beside it. min / max / step are the native ones. */
export const NumberInput = forwardRef(function NumberInput({ suffix, invalid, inputMode = 'decimal', className, ...rest }, ref) {
  useComponentCss(css, 'study-fields');
  const input = <input ref={ref} type="number" inputMode={inputMode} className={cx('sh-input', className)} aria-invalid={invalid || undefined} {...rest} />;
  return suffix ? <span className="sh-number">{input}<span className="sh-number__suffix">{suffix}</span></span> : input;
});
