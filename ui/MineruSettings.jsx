import React from 'react';
import { ui } from './i18n.js';
import { SettingsSection } from './components/index.js';
import MineruInstallCard from './MineruInstallCard.jsx';

/* 设置 › PDF 转换（MinerU）: MinerU on this computer, installed and kept running by StudyHub in one click (ui/MineruInstallCard.jsx). Nothing is
   uploaded and no token is needed (the cloud route was removed in 3.6). `initialLocal` / `initialPlan` skip the first reads (previews, tests). */
export default function MineruSettings({ call, initialLocal = null, initialPlan = null, initialMore = false, pickDirectory }) {
  return (
    <SettingsSection className="mineru-settings" tour="settings-mineru" title={ui('PDF 转换（MinerU）')}
      lead={ui('在这台电脑上把 PDF 转成带页码的文字：支持扫描件、公式、表格和中文。不上传任何内容，不需要令牌。')}>
      <MineruInstallCard call={call} initialLocal={initialLocal} initialPlan={initialPlan} initialMore={initialMore} pickDirectory={pickDirectory} />
    </SettingsSection>
  );
}
