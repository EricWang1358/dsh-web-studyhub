import React from 'react';
import { ui } from '../i18n.js';
import { InlineMessage, SettingsSection } from '../components/index.js';
import { partAvailable } from '../settings-groups.js';
import MineruSettings from '../MineruSettings.jsx';
import MarkerSettings from '../MarkerSettings.jsx';
import { useStudy } from '../study-context.jsx';

/** PDF 转换: MinerU on this computer (it needs the audio component, as the registry says) and the local Marker route (always shown). */
export default function MineruPane({ capabilities }) {
  const { busy } = useStudy();
  const routes = partAvailable('mineru', 'routes', capabilities);
  return <>
    {routes && <InlineMessage tone="info">{ui('两套工具二选一即可，不需要都装：首选推荐下方 MinerU（自带 Python，中文、扫描件与公式效果好）；Marker 为备选方案，适合已有 Python 环境或想对比、替代 MinerU 时使用。')}</InlineMessage>}
    {routes && <MineruSettings />}
    <SettingsSection title={ui('Marker：本机解析')} tour="settings-marker"
      lead={ui('备选方案：与上方 MinerU 二选一即可，适合已有 Python 环境或想对比、替代 MinerU 时使用。')}>
      <MarkerSettings disabled={busy} available={routes} />
    </SettingsSection>
  </>;
}
