import React from 'react';
import { ui } from '../i18n.js';
import { SettingsSection } from '../components/index.js';
import { partAvailable } from '../settings-groups.js';
import MineruSettings from '../MineruSettings.jsx';
import MarkerSettings from '../MarkerSettings.jsx';
import { useStudy } from '../study-context.jsx';

/** PDF 转换: MinerU on this computer (it needs the audio component, as the registry says) and the local Marker route (always shown). */
export default function MineruPane({ capabilities }) {
  const { busy } = useStudy();
  const routes = partAvailable('mineru', 'routes', capabilities);
  return <>
    {routes && <MineruSettings />}
    <SettingsSection title={ui('Marker：本机解析')} tour="settings-marker">
      <MarkerSettings disabled={busy} available={routes} />
    </SettingsSection>
  </>;
}
