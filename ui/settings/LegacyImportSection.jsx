import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Field, SettingsSection, TextInput, useToast } from '../components/index.js';

/** Import an existing local library (study-lib-spar), keeping the review records that can move. */
export default function LegacyImportSection({ busy, act, legacy, setLegacy }) {
  const toast = useToast();
  return (
    <SettingsSection title={ui('导入 study-lib-spar')} lead={ui('从已有本地学习库导入，保留可迁移的复习记录。')}>
      <Field label={ui('原学习库路径')}><TextInput value={legacy} onChange={(e) => setLegacy(e.target.value)} /></Field>
      <div className="settings-actions">
        <Button disabled={busy || !legacy} onClick={() =>
          act('legacy.import', { path: legacy }, (r) =>
            toast.success(r.reused ? ui('该学习库已导入') : uiFormat('已导入 {0} 道题。{1}', [r.count, (r.warnings || []).join('；')])))}>{ui('导入学习库')}</Button>
      </div>
    </SettingsSection>
  );
}
