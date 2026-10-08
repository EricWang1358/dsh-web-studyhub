import React, { forwardRef, useMemo, useRef, useState } from 'react';
import { Select as Base } from '@base-ui/react/select';
import { cx } from './css.js';
import Icon from './Icon.jsx';
import { flattenOptions, isGroup } from './option-list.js';
import { TriggerTip, TriggerValue, chosenOption, indexOfValue, mergeRefs, popupHost, wrapsLabels } from './option-parts.jsx';

/* Select on Base UI (loaded lazily by Select.jsx). Options carry their position in the flat list as their Base UI value, so '' / numbers /
   duplicates in the caller's values need no special case; the caller's value is looked up on the way in and out. */
export default forwardRef(function SelectImpl({ options = [], value, onChange, placeholder, valueLabel, disabled, invalid, required, className, name, ...rest }, ref) {
  const trigger = useRef(null);
  // Re-renders when it opens: the popup's host is found from the trigger at that moment (Base UI keeps the open state itself), and the trigger's tooltip steps aside.
  const [open, setOpen] = useState(false);
  const flat = useMemo(() => flattenOptions(options), [options]);
  const chosen = indexOfValue(flat, value);
  const tree = flat.some((option) => (option.level || 1) > 1);
  const changed = (key) => { const option = flat[Number(key)]; if (option && option.value !== value) onChange?.(option.value, { option }); };
  const item = (option, index) => (
    <Base.Item key={index} value={String(index)} label={option.label} disabled={option.disabled} className={cx('sh-opt', (option.level || 1) > 1 && 'sh-opt--sub', option.wrap && 'sh-opt--wrap')}
      data-level={(option.level || 1) > 1 ? option.level : undefined} aria-level={tree ? option.level || 1 : undefined}>
      <span className="sh-opt__check"><Base.ItemIndicator><Icon name="check" size={16} /></Base.ItemIndicator></span>
      <Base.ItemText className="sh-opt__label">{option.label}</Base.ItemText>
      {option.hint ? <span className="sh-opt__hint">{option.hint}</span> : null}
    </Base.Item>
  );
  let position = 0;
  const content = options.map((entry, at) => (isGroup(entry)
    ? <Base.Group key={`g${at}`} className="sh-pop__group"><Base.GroupLabel className="sh-pop__group-label">{entry.group}</Base.GroupLabel>{entry.options.map((option) => item(option, position++))}</Base.Group>
    : item(entry, position++)));
  return (
    <Base.Root value={chosen >= 0 ? String(chosen) : null} onValueChange={changed} onOpenChange={setOpen} disabled={disabled} required={required} modal={false}>
      <TriggerTip flat={flat} chosen={chosenOption(flat, value, valueLabel)} open={open}>
        <Base.Trigger ref={mergeRefs(ref, trigger)} aria-invalid={invalid || undefined} {...rest} className={cx('sh-input sh-select__trigger', className)}>
          <Base.Value className="sh-select__valuebox" placeholder={placeholder}>{() => <TriggerValue option={chosenOption(flat, value, valueLabel)} placeholder={placeholder} />}</Base.Value>
          <Base.Icon className="sh-select__caret"><Icon name="chevron-down" size={16} /></Base.Icon>
        </Base.Trigger>
      </TriggerTip>
      <Base.Portal container={popupHost(trigger.current)}>
        <Base.Positioner className="sh-pop" side="bottom" align="start" sideOffset={4} collisionPadding={8} alignItemWithTrigger={false}>
          <Base.Popup className={cx('sh-pop__popup', wrapsLabels(flat) ? 'sh-pop__popup--fit' : 'sh-pop__popup--match')}>
            <Base.List className="sh-pop__list">{content}</Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
});
