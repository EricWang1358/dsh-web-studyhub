import React from 'react';
import { ui } from './i18n.js';
import { SettingsSection, Switch } from './components/index.js';

/* 设置 › 高级 › 实验性功能. The one switch behind everything experimental (lib/experimental.js): off by default, and while it is off nothing
   experimental is drawn anywhere. Turning it on adds the experimental block (today: Jev) right below; turning it off hides all of it again
   and stops every experimental feature at once, keeping the choices made inside (they are simply inactive). */

export function ExperimentalSection({ enabled, busy, onChange, children }) {
  return (
    <SettingsSection className="experimental-settings" tour="settings-experimental" title={ui('实验性功能')}
      lead={ui('还在试验的功能，可能出错、效果没有经过验证。默认不显示。')}>
      <Switch name="show-experimental" data-usage="settings.experimental" label={ui('显示实验性功能')}
        hint={ui('关掉后，它们全部隐藏并停止；里面已有的选择会保留，但不再生效。')} checked={!!enabled} disabled={busy} onChange={onChange} />
      {enabled && children}
    </SettingsSection>
  );
}
