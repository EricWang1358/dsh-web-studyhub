import React from 'react';
import { ui } from './i18n.js';
import { Checkbox, Tooltip } from './components/index.js';
import { kinds } from './shared.js';
import { BASIC_KINDS } from '../lib/generation-settings.js';
import { toggleKind } from './generate-form.js';

/* The question types of a run, as a group of checkboxes: any combination of the basic types, at least one. The same group sets the default in 设置 › 出题偏好
   and the types of one run in 创建题组. `value` is the ticked list, onChange(list) gets the new one in the order shown. The last ticked box looks like any ticked
   one (it is the default, not something unusable, #1701): it is aria-disabled, stays ticked, and says why on a click, on keyboard focus and on hover. */
export default function KindPicker({ value, onChange, disabled = false, name = 'kinds', className, ...rest }) {
  const ticked = Array.isArray(value) && value.length ? value : ['quiz'];
  const whyId = React.useId();
  // A try to untick the last box holds its card open until the pointer or the focus leaves it, or the card is dismissed.
  const [tried, setTried] = React.useState(false);
  const stop = () => setTried(false);
  return (
    <div role="group" aria-label={ui('题型')} className={['sh-check-group', className].filter(Boolean).join(' ')} {...rest}>
      {BASIC_KINDS.map(kind => {
        const on = ticked.includes(kind), last = on && ticked.length === 1;
        return (
          <Tooltip key={kind} layer id={last ? whyId : undefined} content={last ? ui('至少保留一种题型') : ''} forceOpen={last && tried}
            onOpenChange={last ? open => { if (!open) stop(); } : undefined}>
            <span onBlur={stop} onPointerLeave={event => { if (event.pointerType !== 'touch') stop(); }}>
              <Checkbox name={`${name}-${kind}`} label={kinds[kind]} checked={on} disabled={disabled}
                aria-disabled={last || undefined} aria-describedby={last ? whyId : undefined}
                onChange={checked => { if (last) setTried(true); else onChange?.(toggleKind(ticked, kind, checked)); }} />
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
