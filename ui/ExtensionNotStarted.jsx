import React, { useState } from 'react';
import { ui } from './i18n.js';
import { ConfirmDialog, InlineMessage } from './components/index.js';
import { usePolling } from './use-polling.js';
import { HandOff } from './hand-off/HandOff.jsx';
import { DiagnosticBar } from './install/DiagnosticActions.jsx';
import { SETUP_FAILED_WHAT, extensionDiagnostic } from './install/install-diagnostics.js';

/* The search extension is installed but its search service did not start (retrieval.status companion.notStarted): say so, say the likely
   reason when StudyHub knows it (the index was reset), and offer the one repair. Shown by ExtensionPanel in Settings and on the 大教材建议 card.
   It keeps asking quietly, so the card goes away by itself once the service is up. */

/** The one wording of "the index was reset" (`reset`: retrieval.status companion.reset): broken and reset by the extension, or reset by 修复. */
export const resetLine = (reset) => (reset?.reason === 'repair' ? ui('索引已经重置，需要重新建立索引。') : ui('索引坏了，已经重置，需要重新建立索引。'));

/** Props: status (retrieval.status), refresh() (reads the status again), repair() (retrieval.index.repair). */
export default function ExtensionNotStarted({ status, refresh, repair: runRepair }) {
  const [confirm, setConfirm] = useState(false), [repaired, setRepaired] = useState(false);
  usePolling(() => refresh(), { intervalMs: 3000 });
  const desktop = !!status?.extension?.desktop;
  const reset = status?.companion?.reset;
  const awaitingRestart = repaired || !!reset?.pendingRestart;
  const repairFailedAfterRestart = !awaitingRestart && !!reset?.restartedAfterRepair;
  async function repair() {
    await runRepair();
    setRepaired(true);
    await refresh();
  }
  const action = awaitingRestart || repairFailedAfterRestart ? undefined : {
    label: ui('修复'),
    onClick: () => setConfirm(true),
    tip: `${ui('把现在的索引移到一旁（不删除），清掉这份资料库的索引记录。')}\n${desktop
      ? ui('之后完全退出 DSH 桌面版（包括托盘图标）后重新打开，再重新建立索引。')
      : ui('之后重启 DSH，再重新建立索引。')}`,
  };
  return (
    <div className="extension-panel__stopped" data-state="not-started">
      <InlineMessage tone="warning" boxed actionsBelow title={ui('检索扩展装好了，但检索服务没有启动')} action={action}>
        {repairFailedAfterRestart
          ? <p className="extension-panel__reason">{ui('上次已重置过索引并重启了 DSH，检索服务还是没有启动，说明问题不在索引损坏。请点下面的「发给主会话」或复制诊断信息排查运行环境。')}</p>
          : <>
            {reset && <p className="extension-panel__reason">{resetLine(reset)}</p>}
            <p className="extension-panel__reason">{awaitingRestart
              ? (desktop
                ? ui('已修复。请完全退出 DSH 桌面版（包括托盘图标）后重新打开，然后重新建立索引。')
                : ui('已修复。请重启 DSH，然后重新建立索引。'))
              : (desktop
                ? ui('先完全退出 DSH 桌面版（包括托盘图标）后重新打开再看；还不行就点修复。')
                : ui('重启 DSH 后再看；还不行就点修复。'))}</p>
          </>}
        <DiagnosticBar row resetKey={repairFailedAfterRestart ? 'repair-failed' : awaitingRestart ? 'repair-pending' : reset?.reason || 'not-started'}
          diagnostic={() => extensionDiagnostic({
            status,
            code: repairFailedAfterRestart ? 'companion-not-started-after-repair' : 'companion-not-started',
            summary: ui('检索扩展装好了，但检索服务没有启动'),
          })}>
          {input => <HandOff id="setup.failed" input={input} what={SETUP_FAILED_WHAT} />}
        </DiagnosticBar>
      </InlineMessage>
      {confirm && <ConfirmDialog tone="primary" title={ui('修复检索索引？')} confirmLabel={ui('修复')} onConfirm={repair} onClose={() => setConfirm(false)}
        description={desktop
          ? ui('现在的索引会移到一旁（不删除），这份资料库的索引记录会清空。之后完全退出 DSH 桌面版（包括托盘图标）后重新打开，再重新建立索引；资料多的话要花一些时间。')
          : ui('现在的索引会移到一旁（不删除），这份资料库的索引记录会清空。之后重启 DSH，再重新建立索引；资料多的话要花一些时间。')} />}
    </div>
  );
}
