import React, { useState } from 'react';
import { ui } from './i18n.js';
import { ConfirmDialog, InlineMessage } from './components/index.js';
import { usePolling } from './use-polling.js';

/* The search extension is installed but its search service did not start (retrieval.status companion.notStarted): say so, say the likely
   reason when StudyHub knows it (the index was reset), and offer the one repair. Shown by ExtensionPanel in Settings and on the 大教材建议 card.
   It keeps asking quietly, so the card goes away by itself once the service is up. */

/** The one wording of "the index was reset" (`reset`: retrieval.status companion.reset): broken and reset by the extension, or reset by 修复. */
export const resetLine = (reset) => (reset?.reason === 'repair' ? ui('索引已经重置，需要重新建立索引。') : ui('索引坏了，已经重置，需要重新建立索引。'));

/** Props: status (retrieval.status), refresh() (reads the status again), repair() (retrieval.index.repair). */
export default function ExtensionNotStarted({ status, refresh, repair: runRepair }) {
  const [confirm, setConfirm] = useState(false), [repaired, setRepaired] = useState(false);
  usePolling(() => refresh(), { intervalMs: 3000 });
  const reset = status?.companion?.reset;
  async function repair() {
    await runRepair();
    setRepaired(true);
    await refresh();
  }
  const action = repaired ? undefined : { label: ui('修复'), onClick: () => setConfirm(true),
    tip: `${ui('把现在的索引移到一旁（不删除），清掉这份资料库的索引记录。')}\n${ui('之后重启 DSH，再重新建立索引。')}` };
  return (
    <div className="extension-panel__stopped" data-state="not-started">
      <InlineMessage tone="warning" boxed actionsBelow title={ui('检索扩展装好了，但检索服务没有启动')} action={action}>
        {reset && <p className="extension-panel__reason">{resetLine(reset)}</p>}
        <p className="extension-panel__reason">{repaired ? ui('已修复。请重启 DSH，然后重新建立索引。') : ui('重启 DSH 后再看；还不行就点修复。')}</p>
      </InlineMessage>
      {confirm && <ConfirmDialog tone="primary" title={ui('修复检索索引？')} confirmLabel={ui('修复')} onConfirm={repair} onClose={() => setConfirm(false)}
        description={ui('现在的索引会移到一旁（不删除），这份资料库的索引记录会清空。之后重启 DSH，再重新建立索引；资料多的话要花一些时间。')} />}
    </div>
  );
}
