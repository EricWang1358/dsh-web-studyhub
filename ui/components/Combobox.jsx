import React, { Suspense, forwardRef, lazy } from 'react';
import css from './select.css';
import fieldCss from './fields.css';
import { useComponentCss } from './css.js';
import { TriggerShell } from './Select.jsx';

/* Select with a search box, groups, a course/chapter tree and footer actions. Like Select, its popup code (Base UI) is a lazily loaded
   chunk and the closed trigger is drawn at once. */
const Impl = lazy(() => import('./combobox-impl.jsx'));

/**
 * options: as Select (options and groups), plus `level` (2 and up hangs an option under the one before it on a hairline, with aria-level)
 * and `keywords` (extra searchable text). value / onChange(value, { option }) / placeholder as Select. Typing in the search box filters
 * by every word, marks the matches, and puts the first match under the highlight, so Enter chooses it; a course shown only to place a
 * matching chapter is not a choice.
 * searchPlaceholder, label (the popup's accessible name), emptyText(query) | string: the sentence when nothing matches.
 * actions: [{ id, label | (query) => label, icon?, onSelect(query), when?(query), enter? }]. Footer buttons, never options: they sit under
 * the list, close the popup and run onSelect with the typed text ("课程设置…", "新建题组「…」"). `enter: true` runs it on Enter when nothing
 * matches the typed text.
 * variant="heading": the trigger is the text you pass as children at the surrounding heading's own size, with only a caret added.
 * Everything else goes to the trigger (id, disabled, invalid, required, aria-*, data-*), so as a Field child it is wired like Select.
 */
export const Combobox = forwardRef(function Combobox(props, ref) {
  useComponentCss(css, 'study-select');
  useComponentCss(fieldCss, 'study-fields');
  // The popup's props (onChange, actions, emptyText, ...) are taken out here; the closed shell has nothing to report.
  const { options = [], value, placeholder, valueLabel, disabled, invalid, required, className, name, variant, children, onChange, actions, emptyText, searchPlaceholder, label, popupClassName, ...rest } = props;
  return (
    <>
      <Suspense fallback={<TriggerShell ref={ref} options={options} value={value} placeholder={placeholder} valueLabel={valueLabel} disabled={disabled} invalid={invalid}
        required={required} className={className} variant={variant} aria-label={label} {...rest}>{variant === 'heading' ? <span className="sh-combobox__heading-text">{children}</span> : null}</TriggerShell>}>
        <Impl ref={ref} {...props} name={undefined} />
      </Suspense>
      {name !== undefined && <input type="hidden" name={name} value={value ?? ''} />}
    </>
  );
});
