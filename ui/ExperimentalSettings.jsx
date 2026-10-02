import React, { useId } from 'react';
import { ui } from './i18n.js';

/* 设置 › 高级 › 实验性功能. The one switch behind everything experimental (lib/experimental.js): off by default, and while it is off nothing
   experimental is drawn anywhere. Turning it on adds the experimental block (today: Jev) right below; turning it off hides all of it again
   and stops every experimental feature at once, keeping the choices made inside (they are simply inactive). */

export function ExperimentalSection({ enabled, busy, onChange, children }) {
  const id = useId();
  return (
    <fieldset className="settings-section experimental-settings" data-tour="settings-experimental">
      <legend className="settings-section__title">{ui('实验性功能')}</legend>
      <p className="settings-section__lead">{ui('还在试验的功能，可能出错、效果没有经过验证。默认不显示。')}</p>
      <label className="experimental-switch" htmlFor={id}>
        <input id={id} name="show-experimental" data-usage="settings.experimental" type="checkbox" checked={!!enabled} disabled={busy} onChange={event => onChange?.(event.target.checked)} />
        <span><strong>{ui('显示实验性功能')}</strong>
          <small>{ui('关掉后，它们全部隐藏并停止；里面已有的选择会保留，但不再生效。')}</small></span>
      </label>
      {enabled && children}
    </fieldset>
  );
}
