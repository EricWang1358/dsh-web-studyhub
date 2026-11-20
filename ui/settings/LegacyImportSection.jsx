import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Disclosure, Field, Hint, TextInput, useToast } from '../components/index.js';
import { useStudy } from '../study-context.jsx';

/** Import an existing local library (study-lib-spar), keeping the review records that can move. */
export default function LegacyImportSection({ legacy, setLegacy }) {
  const { busy, act } = useStudy();
  const toast = useToast();
  return (
    <Disclosure className="legacy-import-disclosure settings-disclosure" summaryClassName="settings-disclosure__summary" bodyClassName="settings-disclosure__body"
      data-tour="settings-legacy-import" summary={ui('从旧版 study-lib-spar 导入')} meta={ui('仅限早期工具老用户')}>
      <Hint>{ui('仅限早期 study-lib-spar 工具老用户；导入会合并进当前库，不覆盖现有内容，并保留可迁移的复习记录。')}</Hint>
      <Field label={ui('原学习库路径')}>
        <TextInput value={legacy} placeholder={ui('例如：D:\\study-lib-spar 或 ~/study-lib-spar')} onChange={(e) => setLegacy(e.target.value)} />
      </Field>
      <div className="settings-actions">
        <Button disabled={!legacy} lock={busy} onClick={() =>
          act('legacy.import', { path: legacy }, (r) =>
            toast.success(r.reused ? ui('该学习库已导入') : uiFormat('已导入 {0} 道题。{1}', [r.count, (r.warnings || []).join('；')])))}>{ui('导入学习库')}</Button>
      </div>
    </Disclosure>
  );
}
