/* Server-render tests read what a page offers in a dropdown (its options, groups and footer actions). The real Select and Combobox draw only a
   closed trigger until they are opened in a browser (their popup is Base UI, loaded on demand), so these tests bundle this stand-in for
   ui/components/Select.jsx and Combobox.jsx (tests/helpers/native-selects.mjs): the same props, drawn as a native <select> plus the footer
   actions as buttons. The real components are exercised in a browser by tests/select-combobox-browser.test.mjs. */
import React from 'react';

const optionNode = (option, index) => <option key={index} value={String(option.value ?? '')} disabled={option.disabled || undefined} data-level={option.level > 1 ? option.level : undefined}>{option.label}{option.hint ? ` · ${option.hint}` : ''}</option>;
const groups = (options = []) => options.map((entry, index) => (Array.isArray(entry.options)
  ? <optgroup key={`g${index}`} label={entry.group}>{entry.options.map(optionNode)}</optgroup> : optionNode(entry, index)));

export function Select({ options = [], value, onChange: _onChange, placeholder, valueLabel: _valueLabel, invalid, className, ...rest }) {
  return <select className={['sh-input', className].filter(Boolean).join(' ')} value={value ?? ''} aria-invalid={invalid || undefined} onChange={() => {}} {...rest}>
    {placeholder && <option value="">{placeholder}</option>}{groups(options)}</select>;
}

export function Combobox({ options = [], value, onChange: _onChange, placeholder, valueLabel: _valueLabel, invalid, className, variant, children, label, actions = [], emptyText: _emptyText, searchPlaceholder: _searchPlaceholder, popupClassName: _popupClassName, ...rest }) {
  return <>
    {variant === 'heading' && <span className="sh-combobox__heading-text">{children}</span>}
    <select className={['sh-input', className].filter(Boolean).join(' ')} data-combobox={variant || 'field'} value={value ?? ''} aria-label={label} aria-invalid={invalid || undefined} onChange={() => {}} {...rest}>
      {placeholder && <option value="">{placeholder}</option>}{groups(options)}</select>
    {actions.map(action => <button key={action.id} type="button" data-footer-action={action.id}>{typeof action.label === 'function' ? action.label('') : action.label}</button>)}
  </>;
}
