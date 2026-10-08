import React, { Suspense, forwardRef, lazy, useMemo } from 'react';
import css from './select.css';
import fieldCss from './fields.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';
import { flattenOptions } from './option-list.js';
import { TriggerTip, TriggerValue, chosenOption } from './option-parts.jsx';

/* The single-choice dropdown for a short list (no search; Combobox is the one that searches). The popup code (Base UI) is a lazily loaded
   chunk: the trigger below is drawn at once, in the same look, and is replaced by the real one when the chunk arrives (the first Select
   on a page starts the load). Base UI appears only in select-impl.jsx and combobox-impl.jsx; pages import from ui/components. */
const Impl = lazy(() => import('./select-impl.jsx'));

/** A closed trigger without Base UI: what shows until the popup code loads, and what a server render draws. It carries the same id and
    label wiring, so a Field's label already points at it. */
export const TriggerShell = forwardRef(function TriggerShell({ options, value, placeholder, valueLabel, disabled, invalid, required, className, variant, children, ...rest }, ref) {
  const flat = useMemo(() => flattenOptions(options), [options]);
  const chosen = chosenOption(flat, value, valueLabel);
  return (
    <TriggerTip flat={flat} chosen={chosen}>
      <button ref={ref} type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-required={required || undefined} disabled={disabled}
        aria-invalid={invalid || rest['aria-invalid'] || undefined} {...rest}
        className={cx(variant === 'heading' ? 'sh-combobox__heading' : 'sh-input sh-select__trigger', className)}>
        {variant === 'heading' ? children : <TriggerValue option={chosen} placeholder={placeholder} />}
        <span className="sh-select__caret" aria-hidden="true"><Icon name="chevron-down" size={16} /></span>
      </button>
    </TriggerTip>
  );
});

/**
 * options: [{ value, label, hint?, disabled?, triggerLabel?, tip?, wrap? } | { group: 'Heading', options: [...] }], `label` a string. value: the chosen option's value
 * (strings, numbers, '' all work; an unknown value shows `valueLabel` when given, else the placeholder; an option's `triggerLabel` is what the
 * closed trigger says for it, the full course path for a chapter, or the short words when the label is long). `tip` (a string, '' for none) is the
 * sentence the trigger carries in a hover and focus tooltip while that option is chosen; `wrap` lets the label run over lines in the popup, which is then
 * as wide as the label needs (up to a limit) instead of cutting it. onChange(value, { option }). placeholder: what an empty trigger says. Everything else goes to the trigger: id, name (a hidden input carries the value), required, disabled, invalid
 * (aria-invalid), aria-label, aria-describedby, data-*. As a Field child it takes id / aria-describedby / aria-invalid / required from Field.
 * Keyboard: Enter/Space/ArrowDown opens, arrows and Home/End move, typing jumps to a match, Enter chooses, Escape closes and
 * returns focus to the trigger. The popup is as wide as the trigger and as tall as the room below (or above) allows.
 */
export const Select = forwardRef(function Select(props, ref) {
  useComponentCss(css, 'study-select');
  useComponentCss(fieldCss, 'study-fields');
  // onChange is the popup's; the closed shell has nothing to report.
  const { options = [], value, placeholder, valueLabel, disabled, invalid, required, className, name, onChange, ...rest } = props;
  return (
    <>
      <Suspense fallback={<TriggerShell ref={ref} options={options} value={value} placeholder={placeholder} valueLabel={valueLabel} disabled={disabled} invalid={invalid}
        required={required} className={className} {...rest} />}>
        <Impl ref={ref} {...props} name={undefined} />
      </Suspense>
      {name !== undefined && <input type="hidden" name={name} value={value ?? ''} />}
    </>
  );
});
