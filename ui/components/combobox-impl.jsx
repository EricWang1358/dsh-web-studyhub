import React, { forwardRef, useMemo, useRef, useState } from 'react';
import { Combobox as Base } from '@base-ui/react/combobox';
import { ui, uiFormat } from '../i18n.js';
import { cx } from './css.js';
import Icon from './Icon.jsx';
import { filterEntries, flattenOptions, isGroup, resolveActions } from './option-list.js';
import { Highlighted, TriggerValue, chosenOption, indexOfValue, mergeRefs, popupHost } from './option-parts.jsx';

/* Combobox on Base UI (loaded lazily by Combobox.jsx): the trigger is a button, the popup holds the search box, the list and the footer
   actions. Filtering is ours (option-list.js: every word, the tree kept); Base UI gets the filtered list and does the keyboard, focus
   and the popup. Items carry their position in the unfiltered list as `key`, which is how a choice is compared. */
const keyed = (entries) => {
  let key = 0;
  return entries.map((entry) => (isGroup(entry) ? { ...entry, options: entry.options.map((option) => ({ ...option, key: String(key++) })) } : { ...entry, key: String(key++) }));
};

export default forwardRef(function ComboboxImpl({ options = [], value, onChange, placeholder, valueLabel, searchPlaceholder, emptyText, actions = [], variant = 'field', children, label,
  disabled, invalid, required, className, popupClassName, name, ...rest }, ref) {
  const trigger = useRef(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const entries = useMemo(() => keyed(options), [options]);
  const all = useMemo(() => flattenOptions(entries), [entries]);
  const byKey = useMemo(() => new Map(all.map((option) => [option.key, option])), [all]);
  const shown = useMemo(() => filterEntries(entries, query), [entries, query]);
  const choices = useMemo(() => flattenOptions(shown).filter((option) => !option.context).map((option) => byKey.get(option.key)), [shown, byKey]);
  const tree = all.some((option) => (option.level || 1) > 1);
  const selected = all[indexOfValue(all, value)] ?? null;
  const text = query.trim();
  const footer = resolveActions(actions, text);
  const emptyLabel = typeof emptyText === 'function' ? emptyText(text) : emptyText || (text ? uiFormat('没有找到「{0}」', [text]) : ui('没有可选的项'));
  const run = (action) => { setOpen(false); action.onSelect?.(text); };
  const changed = (item) => { if (item && item.value !== value) onChange?.(item.value, { option: byKey.get(item.key) }); };
  const onInputKey = (event) => {
    if (event.key !== 'Enter' || choices.length) return;
    const action = footer.find((candidate) => candidate.enter && !candidate.disabled);
    if (action) { event.preventDefault(); run(action); }
  };
  const item = (option, index) => {
    const level = option.level || 1;
    return (
      <Base.Item key={option.key} value={byKey.get(option.key)} index={index} disabled={option.disabled} className={cx('sh-opt', level > 1 && 'sh-opt--sub')}
        data-level={level > 1 ? level : undefined} aria-level={tree ? level : undefined}>
        <span className="sh-opt__check"><Base.ItemIndicator><Icon name="check" size={16} /></Base.ItemIndicator></span>
        <span className="sh-opt__label"><Highlighted text={option.label} query={query} /></span>
        {option.hint ? <span className="sh-opt__hint">{option.hint}</span> : null}
      </Base.Item>
    );
  };
  // Headings are drawn between the choices; only the choices are Base UI items, numbered in order.
  let position = 0;
  const rowOf = (entry) => {
    if (entry.context) {
      return <div key={entry.key} role="presentation" className={cx('sh-opt sh-opt--context', (entry.level || 1) > 1 && 'sh-opt--sub')}><span className="sh-opt__check" /><span className="sh-opt__label">{entry.label}</span></div>;
    }
    return item(entry, position++);
  };
  const content = shown.map((entry, at) => (isGroup(entry)
    ? <Base.Group key={`g${at}`} className="sh-pop__group"><Base.GroupLabel className="sh-pop__group-label">{entry.group}</Base.GroupLabel>{entry.options.map(rowOf)}</Base.Group>
    : rowOf(entry)));
  const heading = variant === 'heading';
  return (
    <Base.Root items={all} filteredItems={choices} value={selected ? byKey.get(selected.key) : null} onValueChange={changed} open={open} disabled={disabled} required={required}
      onOpenChange={(next) => { setOpen(next); }} onOpenChangeComplete={(next) => { if (!next) setQuery(''); }}
      inputValue={query} onInputValueChange={(next, details) => { if (details.reason === 'input-change') setQuery(next); }}
      itemToStringLabel={(option) => option?.label ?? ''} isItemEqualToValue={(a, b) => a?.key === b?.key} autoHighlight modal={false}>
      <Base.Trigger ref={mergeRefs(ref, trigger)} aria-invalid={invalid || undefined} aria-label={label} {...rest}
        className={cx(heading ? 'sh-combobox__heading' : 'sh-input sh-select__trigger', className)}>
        {heading ? <span className="sh-combobox__heading-text">{children}</span>
          : <Base.Value className="sh-select__valuebox">{() => <TriggerValue option={chosenOption(all, value, valueLabel)} placeholder={placeholder} />}</Base.Value>}
        <Base.Icon className="sh-select__caret"><Icon name="chevron-down" size={heading ? 18 : 16} /></Base.Icon>
      </Base.Trigger>
      <Base.Portal container={popupHost(trigger.current)}>
        <Base.Positioner className="sh-pop" side="bottom" align="start" sideOffset={4} collisionPadding={8}>
          <Base.Popup className={cx('sh-pop__popup', heading ? 'sh-pop__popup--wide' : 'sh-pop__popup--match', popupClassName)} aria-label={label}>
            <div className="sh-combobox__search">
              <Icon name="search" size={16} />
              <Base.Input className="sh-combobox__input" placeholder={searchPlaceholder || ui('搜索')} aria-label={searchPlaceholder || label || ui('搜索')} onKeyDown={onInputKey} />
            </div>
            <Base.Empty className="sh-combobox__empty">{emptyLabel}</Base.Empty>
            <Base.List className="sh-pop__list">{content}</Base.List>
            {footer.length > 0 && <div className="sh-combobox__foot">
              {footer.map((action) => (
                <button key={action.id} type="button" className="sh-combobox__action" disabled={action.disabled} onClick={() => run(action)}>
                  {action.icon && <Icon name={action.icon} size={16} />}
                  <span className="sh-combobox__action-label">{action.label}</span>
                </button>))}
            </div>}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
});
