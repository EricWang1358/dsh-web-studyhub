import React from 'react';
import { ui } from './i18n.js';
import { Checkbox } from './components/index.js';
import { kinds } from './shared.js';
import { BASIC_KINDS } from '../lib/generation-settings.js';
import { toggleKind } from './generate-form.js';

/* The question types of a run, as a group of checkboxes: any combination of the five basic types, at least one (the last ticked box cannot be unticked). The same group
   sets the default in 设置 › 出题偏好 and the types of one run in 创建题组. `value` is the ticked list, onChange(list) gets the new one in the order shown. */
export default function KindPicker({ value, onChange, disabled = false, name = 'kinds', className, ...rest }) {
  const ticked = Array.isArray(value) && value.length ? value : ['quiz'];
  return (
    <div role="group" aria-label={ui('题型')} className={['sh-check-group', className].filter(Boolean).join(' ')} {...rest}>
      {BASIC_KINDS.map(kind => {
        const on = ticked.includes(kind), last = on && ticked.length === 1;
        return <Checkbox key={kind} name={`${name}-${kind}`} label={kinds[kind]} checked={on} disabled={disabled || last}
          title={last ? ui('至少保留一种题型') : undefined} onChange={checked => onChange?.(toggleKind(ticked, kind, checked))} />;
      })}
    </div>
  );
}
