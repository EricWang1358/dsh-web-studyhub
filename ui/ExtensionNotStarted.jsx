import React, { useEffect, useRef, useState } from 'react';
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

function notStartedReason({ isDesktopApp, awaitingRestart, desktop }) {
  if (isDesktopApp) return ui('先点「重试启动」（不清空索引）；仍无法启动再点「修复」自动重置索引并重启检索服务，或复制诊断信息排查运行环境。');
  if (awaitingRestart) {
    return desktop
      ? ui('已修复。请完全退出 DSH 桌面版（包括托盘图标）后重新打开，然后重新建立索引。')
      : ui('已修复。请重启 DSH，然后重新建立索引。');
  }
  return desktop
    ? ui('先完全退出 DSH 桌面版（包括托盘图标）后重新打开再看；还不行就点修复。')
    : ui('重启 DSH 后再看；还不行就点修复。');
}

/** Props: status (retrieval.status), refresh() (reads the status again), repair() (retrieval.index.repair), restart() (optional desktop hot-restart). */
export default function ExtensionNotStarted({ status, refresh, repair: runRepair, restart: runRestart }) {
  const [confirm, setConfirm] = useState(false), [repaired, setRepaired] = useState(false), [retrying, setRetrying] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  usePolling(() => refresh(), { intervalMs: 3000 });
  const desktop = !!status?.extension?.desktop;
  const isDesktopApp = !!status?.extension?.desktopHost;
  const reset = status?.companion?.reset;
  const awaitingRestart = !isDesktopApp && (repaired || !!reset?.pendingRestart);
  const repairFailed = isDesktopApp
    ? (repaired || !!reset?.restartedAfterRepair)
    : (!awaitingRestart && !!reset?.restartedAfterRepair);
  async function repair() {
    await runRepair();
    await refresh();
    if (alive.current) setRepaired(true);
  }
  async function retryStart() {
    if (retrying || typeof runRestart !== 'function') return;
    setRetrying(true);
    try {
      const next = await runRestart();
      await refresh(next);
    } finally {
      if (alive.current) setRetrying(false);
    }
  }
  const repairAction = awaitingRestart || repairFailed ? undefined : {
    label: ui('修复'),
    onClick: () => setConfirm(true),
    tip: `${ui('把现在的索引移到一旁（不删除），清掉这份资料库的索引记录。')}\n${isDesktopApp
      ? ui('修复后会自动重启检索服务，无需重启 StudyHub，之后再重新建立索引。')
      : desktop
        ? ui('之后完全退出 DSH 桌面版（包括托盘图标）后重新打开，再重新建立索引。')
        : ui('之后重启 DSH，再重新建立索引。')}`,
  };
  const retryAction = isDesktopApp && typeof runRestart === 'function' ? {
    label: retrying ? ui('正在启动…') : ui('重试启动'),
    disabled: retrying,
    onClick: retryStart,
    tip: ui('只重新启动检索服务，不重置已有索引。'),
  } : undefined;
  const action = retryAction || repairAction;
  const secondary = retryAction ? repairAction : undefined;
  return (
    <div className="extension-panel__stopped" data-state="not-started">
      <InlineMessage tone="warning" boxed actionsBelow title={ui('检索扩展装好了，但检索服务没有启动')} action={action} secondary={secondary}>
        {repairFailed
          ? <p className="extension-panel__reason">{isDesktopApp
            ? ui('已重置索引并尝试重启检索服务，但检索服务仍未启动，说明问题不在索引损坏。请复制诊断信息或复制提示词排查运行环境。')
            : ui('上次已重置过索引并重启了 DSH，检索服务还是没有启动，说明问题不在索引损坏。请点下面的「发给主会话」或复制诊断信息排查运行环境。')}</p>
          : <>
            {reset && <p className="extension-panel__reason">{resetLine(reset)}</p>}
            <p className="extension-panel__reason">{notStartedReason({ isDesktopApp, awaitingRestart, desktop })}</p>
          </>}
        <DiagnosticBar row resetKey={repairFailed ? 'repair-failed' : awaitingRestart ? 'repair-pending' : reset?.reason || 'not-started'}
          diagnostic={() => extensionDiagnostic({
            status,
            code: repairFailed ? 'companion-not-started-after-repair' : 'companion-not-started',
            summary: ui('检索扩展装好了，但检索服务没有启动'),
          })}>
          {input => <HandOff id="setup.failed" input={input} what={SETUP_FAILED_WHAT} />}
        </DiagnosticBar>
      </InlineMessage>
      {confirm && <ConfirmDialog tone="primary" title={ui('修复检索索引？')} confirmLabel={ui('修复')} onConfirm={repair} onClose={() => setConfirm(false)}
        description={isDesktopApp
          ? ui('现在的索引会移到一旁（不删除），这份资料库的索引记录会清空，并自动重启检索服务（无需重启 StudyHub）。之后再重新建立索引；资料多的话要花一些时间。')
          : desktop
            ? ui('现在的索引会移到一旁（不删除），这份资料库的索引记录会清空。之后完全退出 DSH 桌面版（包括托盘图标）后重新打开，再重新建立索引；资料多的话要花一些时间。')
            : ui('现在的索引会移到一旁（不删除），这份资料库的索引记录会清空。之后重启 DSH，再重新建立索引；资料多的话要花一些时间。')} />}
    </div>
  );
}
