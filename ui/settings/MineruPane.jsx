import React from 'react';
import { ui } from '../i18n.js';
import { Disclosure, SettingsSection } from '../components/index.js';
import { partAvailable } from '../settings-groups.js';
import MineruSettings from '../MineruSettings.jsx';
import MarkerSettings from '../MarkerSettings.jsx';
import PdfExternalConvertGuide from '../PdfExternalConvertGuide.jsx';
import { useStudy } from '../study-context.jsx';

/** PDF 转换: MinerU on this computer leads; Marker stays available inside a collapsed Disclosure (open when audio routes are off). */
export default function MineruPane({ capabilities }) {
  const { busy } = useStudy();
  const routes = partAvailable('mineru', 'routes', capabilities);
  return <>
    {routes && <MineruSettings />}
    <div data-tour="settings-marker">
      <Disclosure summary={ui('其他本机引擎：Marker')} meta={ui('备选 · 进阶')} defaultOpen={!routes}>
        <SettingsSection title={ui('Marker：本机解析')}
          lead={ui('备选方案：与上方 MinerU 二选一即可，适合已有 Python 环境或想对比、替代 MinerU 时使用。')}>
          <MarkerSettings disabled={busy} available={routes} />
        </SettingsSection>
      </Disclosure>
    </div>
    <PdfExternalConvertGuide />
  </>;
}
