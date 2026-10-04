import React from 'react';
import { ui } from '../i18n.js';
import { SettingsSection } from '../components/index.js';
import { partAvailable } from '../settings-groups.js';
import MineruSettings from '../MineruSettings.jsx';
import MarkerSettings from '../MarkerSettings.jsx';

/** PDF 转换: the MinerU routes (they need the audio component, as the registry says) and the local Marker route (always shown). */
export default function MineruPane({ capabilities, busy, call }) {
  const routes = partAvailable('mineru', 'routes', capabilities);
  return <>
    {routes && <MineruSettings busy={busy} call={call} />}
    <SettingsSection title={ui('Marker：本机解析')} tour="settings-marker">
      <MarkerSettings disabled={busy} call={call} available={routes} />
    </SettingsSection>
  </>;
}
