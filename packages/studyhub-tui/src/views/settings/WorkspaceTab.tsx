import React, { memo, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  atomicWriteExportJson,
  atomicWriteJsonFile,
  atomicWriteTextFile,
} from '../../host/atomic-write.js';
import { tryAction } from '../../host/sample-actions.js';
import { useShellActions } from '../../shell/actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { LibraryContextModal } from './LibraryContextModal.js';
import { ReleaseUpdateModal } from './ReleaseUpdateModal.js';
import { RetrievalDiagModal } from './RetrievalDiagModal.js';
import { UsageReportModal } from './UsageReportModal.js';
import { useWorkspaceActions } from './useWorkspaceActions.js';
import {
  defaultBackupPath,
  describeAutoUpdateBadge,
  describeRetrievalBadge,
  describeRetrievalCoverage,
  describeUsageBadge,
  formatBytes,
  resolveBackupPath,
  summarizeExportPayload,
  truncatePathMiddle,
  type RestorePointEntry,
  type WorkspaceTabProps,
} from './workspace-model.js';

export { atomicWriteJsonFile, atomicWriteTextFile };
export {
  defaultBackupPath,
  describeRetrievalCoverage,
  resolveBackupPath,
  summarizeExportPayload,
  truncatePathMiddle,
  type RestorePointEntry,
  type WorkspaceTabProps,
};

export const WorkspaceTab: React.FC<WorkspaceTabProps> = memo(function WorkspaceTab({
  host,
  binding,
  width,
  height,
  isActive,
  onRefreshBinding,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const desktopConfig = useTuiStore((s) => s.desktopConfig);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const sampleLoaded = Boolean(snapshot?.sample?.loaded);

  const ws = useWorkspaceActions({
    host,
    binding,
    lang,
    asciiMode,
    ell,
    sampleLoaded,
    initialExperimental: Boolean(snapshot?.experimental),
    snapshotRevision: snapshot?.revision,
    onRefreshBinding,
    refreshSnapshot,
  });

  const { busyAction, mountedRef, setBusyAction, setExportingBackup } = ws;

  const handleExportBackup = useCallback(
    async (raw: string) => {
      if (busyAction) return;
      const baseDir = binding?.root || host.getLibraryRoot() || process.cwd();
      setExportingBackup(false);
      let targetPath = '';
      try {
        targetPath = resolveBackupPath(raw, baseDir);
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        notify(t(lang, `导出备份失败：${msg}`, `Export failed: ${msg}`), 'error');
        return;
      }
      if (!targetPath) return;
      setBusyAction(t(lang, `导出学习库备份${ell}`, `Exporting library backup${ell}`));
      try {
        const res = await tryAction<Record<string, unknown>>(host, 'export', {});
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          notify(res.error?.message || t(lang, '导出学习库备份失败', 'Failed to export library backup'), 'error');
          return;
        }
        const written = await atomicWriteExportJson(targetPath, res.value);
        if (!mountedRef.current) return;
        const { decksCount, cardsCount, referencedOriginals } = summarizeExportPayload(res.value);
        const arrow = asciiMode ? '->' : '→';
        const refSuffix =
          referencedOriginals > 0
            ? t(
                lang,
                `；${referencedOriginals} 份外部原文件仅记录路径`,
                `; ${referencedOriginals} external originals referenced by path`,
              )
            : '';
        notify(
          t(
            lang,
            `已导出备份 (${formatBytes(written.bytes)}, ${decksCount} 牌组, ${cardsCount} 卡片) ${arrow} ${written.path}${refSuffix}`,
            `Exported backup (${formatBytes(written.bytes)}, ${decksCount} decks, ${cardsCount} cards) ${arrow} ${written.path}${refSuffix}`,
          ),
          'success',
        );
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        notify(t(lang, `导出备份失败：${msg}`, `Export failed: ${msg}`), 'error');
      } finally {
        if (mountedRef.current) setBusyAction(null);
      }
    },
    [asciiMode, binding?.root, busyAction, ell, host, lang, mountedRef, notify, setBusyAction, setExportingBackup],
  );

  const modalOpen =
    ws.editingRoot ||
    ws.exportingBackup ||
    ws.confirmSampleRemove ||
    Boolean(ws.confirmRestore) ||
    ws.confirmClearUsage ||
    ws.retrievalDiagOpen ||
    ws.updateModalOpen ||
    ws.usageReportOpen ||
    ws.libraryCtxOpen;
  const claimed = useMemo(() => ['e', 's', 'x', 'c', 'f', 'u', 'U', 'a', 'A', 'v', 't', 'i', 'L'], []);

  useKeyScope({
    id: 'settings:workspace',
    active: isActive && !modalOpen,
    keys: claimed,
    onKey: (input, key) => {
      if (key.ctrl && !key.meta && input === 'r') {
        void ws.loadPoints();
        void ws.loadRetrieval();
        void ws.loadUsage();
        void ws.loadUpdatePrefs();
        return false;
      }
      if (key.return && !key.ctrl && !key.meta && ws.restorePoints[ws.selectedPointIdx]) {
        ws.setConfirmRestore(ws.restorePoints[ws.selectedPointIdx]);
        return true;
      }
      if (!isPlainKey(input, key)) return false;
      if (input === 'e') {
        ws.setRootDraft(binding?.root || host.getLibraryRoot() || '');
        ws.setEditingRoot(true);
        return true;
      }
      if (input === 's') {
        void ws.handleToggleSample();
        return true;
      }
      if (input === 'x') {
        if (ws.busyAction) return true;
        const baseDir = binding?.root || host.getLibraryRoot() || process.cwd();
        ws.setExportPathDraft(defaultBackupPath(baseDir));
        ws.setExportingBackup(true);
        return true;
      }
      if (input === 'L') {
        if (ws.busyAction) return true;
        ws.setLibraryCtxExportPath(null);
        ws.setLibraryCtxError(null);
        ws.setLibraryCtxOpen(true);
        void ws.loadLibraryContext();
        return true;
      }
      if (input === 'c' && desktopConfig && !desktopConfig.libraryPlaceConfirmed) {
        void ws.handleConfirmLocation();
        return true;
      }
      if (input === 'f') {
        void ws.handleToggleExperimental();
        return true;
      }
      if (input === 'u') {
        void ws.handleToggleUsage();
        return true;
      }
      if (input === 'U') {
        if (!ws.busyAction) ws.setConfirmClearUsage(true);
        return true;
      }
      if (input === 'i') {
        if (ws.busyAction) return true;
        ws.setUsageReportExportPath(null);
        ws.setUsageReportError(null);
        ws.setUsageReportOpen(true);
        void ws.loadUsageReport(ws.usageReportPeriod);
        return true;
      }
      if (input === 'a') {
        void ws.handleToggleAutoCheck();
        return true;
      }
      if (input === 'A') {
        if (ws.busyAction) return true;
        ws.setUpdateModalOpen(true);
        void ws.runUpdateCheck();
        return true;
      }
      if (input === 'v') {
        void ws.handleCycleRetrievalProvider();
        return true;
      }
      if (input === 't') {
        if (ws.busyAction) return true;
        ws.setRetrievalDiagOpen(true);
        void ws.runRetrievalDiag();
        return true;
      }
      return false;
    },
  });

  const rootPath = binding?.root || host.getLibraryRoot() || '';
  const defaultRoot = binding?.defaultRoot || '';
  const confirmed = desktopConfig?.libraryPlaceConfirmed ?? true;

  const compactLayout = width < 84;
  const infoPanelH = compactLayout ? 11 : 10;
  const listPanelH = Math.max(6, height - infoPanelH);
  const listRows = Math.max(1, listPanelH - 2);

  const renderPoint = useCallback(
    (pt: RestorePointEntry, ctx: VirtualListRenderContext) => {
      const ts = pt.createdAt ? pt.createdAt.slice(0, 19).replace('T', ' ') : pt.id;
      const bytes = pt.extraBytes ?? pt.sizeBytes;
      const cards = pt.summary?.cards ?? pt.cards;
      const tag = pt.reason || pt.tier;
      const sep = asciiMode ? ' - ' : ' · ';
      const right = `${formatBytes(bytes)}${cards !== undefined ? `${sep}${cards} cards` : ''}`;
      const rightW = displayWidth(right);
      const leftW = Math.max(8, ctx.width - rightW - 4);
      const pointer = ctx.selected ? (asciiMode ? '>' : '❯') : ' ';
      const label = truncateDisplay(`${pointer} ${ts}${tag ? `${sep}${tag}` : ''}`, leftW);
      return (
        <Box width={ctx.width} height={1}>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {padDisplay(label, leftW + 2)}
          </Text>
          <Text color={theme.muted}>{padDisplay(right, rightW + 2, 'right')}</Text>
        </Box>
      );
    },
    [asciiMode, theme.muted, theme.selectionFg, theme.text],
  );

  const modalW = Math.min(72, Math.max(40, width - 6));
  const sampleActionLabel = `[s] ${sampleLoaded ? t(lang, '移除示例课程', 'Remove sample') : t(lang, '载入示例课程', 'Load sample')}`;
  const exportActionLabel = `[x] ${t(lang, '导出学习库备份', 'Export backup')}`;
  const confirmActionLabel = `[c] ${t(lang, '确认位置', 'Confirm place')}`;
  const experimentalBadgeLabel = ws.experimentalEnabled
    ? asciiMode
      ? t(lang, '已开启 +', 'Enabled +')
      : t(lang, '已开启 ✓', 'Enabled ✓')
    : t(lang, '已关闭', 'Disabled');
  const experimentalActionLabel = `[f] ${t(lang, '切换', 'Toggle')}`;
  const retrievalBadge = describeRetrievalBadge(ws.retrievalStatus, ws.retrievalLoaded, lang, asciiMode);
  const retrievalCoverageLabel = describeRetrievalCoverage(ws.retrievalCoverage, lang, asciiMode);
  const retrievalSwitchLabel = `[v] ${t(lang, '切换', 'Switch')}`;
  const retrievalDiagLabel = `[t] ${t(lang, '诊断', 'Diag')}`;
  const usageBadge = describeUsageBadge(ws.usageStatus, ws.usageLoaded, lang, asciiMode);
  const usageToggleLabel = `[u] ${t(lang, '切换', 'Toggle')}`;
  const usageClearLabel = `[U] ${t(lang, '清空记录', 'Clear data')}`;
  const autoUpdateBadge = describeAutoUpdateBadge(ws.autoCheckEnabled, ws.updateLoaded, lang, asciiMode);
  const autoUpdateToggleLabel = `[a] ${t(lang, '切换', 'Toggle')}`;
  const contextActionLabel = `[L] ${t(lang, '上下文', 'Context')}`;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel
        title={t(lang, '学习库路径与工作区', 'Library Root & Workspace')}
        subtitle={ws.busyAction || binding?.rootSource || undefined}
        focused={isActive && !modalOpen}
        width={width}
        height={infoPanelH}
      >
        <Box flexDirection="row" gap={1}>
          <Text color={theme.muted}>{t(lang, '当前学习库:', 'Current Root:')}</Text>
          <Text color={theme.primary} bold>
            {truncatePathMiddle(rootPath, Math.max(10, width - 22), ell)}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={theme.muted}>{t(lang, '默认路径:  ', 'Default Root:')}</Text>
          <Text color={theme.dim}>{truncatePathMiddle(defaultRoot || '-', Math.max(10, width - 22), ell)}</Text>
        </Box>
        <Box flexDirection="row" gap={2} marginTop={0}>
          <Text color={theme.muted}>
            {t(lang, '位置确认:', 'Place Status:')}{' '}
            <Badge
              label={confirmed ? t(lang, '已确认', 'Confirmed') : t(lang, '待确认 [c]', 'Unconfirmed [c]')}
              tone={confirmed ? 'success' : 'warning'}
              variant="soft"
            />
          </Text>
          <Text color={theme.muted}>
            {t(lang, '示例课程:', 'Sample:')}{' '}
            <Badge
              label={sampleLoaded ? t(lang, '已载入', 'Loaded') : t(lang, '未载入', 'Not Loaded')}
              tone={sampleLoaded ? 'accent' : 'muted'}
              variant="soft"
            />
          </Text>
        </Box>
        <Box flexDirection="row" gap={2} marginTop={0} height={1} overflow="hidden">
          <Text color={theme.muted}>
            {t(lang, '实验性功能:', 'Experimental Features:')}{' '}
            <Badge
              label={experimentalBadgeLabel}
              tone={ws.experimentalEnabled ? 'accent' : 'muted'}
              variant="soft"
            />
          </Text>
          <Text color={theme.accent}>{experimentalActionLabel}</Text>
        </Box>
        <Box flexDirection="row" gap={compactLayout ? 1 : 2} marginTop={0} height={1} overflow="hidden">
          <Text color={theme.muted}>
            {t(lang, '语义检索:', 'Retrieval:')}{' '}
            <Badge label={retrievalBadge.label} tone={retrievalBadge.tone} variant="soft" />
          </Text>
          {retrievalCoverageLabel ? <Text color={theme.dim}>{retrievalCoverageLabel}</Text> : null}
          <Text color={theme.accent}>{retrievalSwitchLabel}</Text>
          <Text color={theme.accent}>{retrievalDiagLabel}</Text>
        </Box>
        <Box flexDirection="row" gap={compactLayout ? 1 : 2} marginTop={0} height={1} overflow="hidden">
          <Text color={theme.muted}>
            {t(lang, '使用频率记录:', 'Usage Frequency:')}{' '}
            <Badge label={usageBadge.label} tone={usageBadge.tone} variant="soft" />
          </Text>
          <Text color={theme.accent}>{usageToggleLabel}</Text>
          <Text color={theme.accent}>[i] {t(lang, '报表', 'Report')}</Text>
          <Text color={theme.warning}>{usageClearLabel}</Text>
        </Box>
        <Box flexDirection="row" gap={compactLayout ? 1 : 2} marginTop={0} height={1} overflow="hidden">
          <Text color={theme.muted}>
            {t(lang, '自动检查更新:', 'Auto Update:')}{' '}
            <Badge label={autoUpdateBadge.label} tone={autoUpdateBadge.tone} variant="soft" />
          </Text>
          <Text color={theme.accent}>{autoUpdateToggleLabel}</Text>
          <Text color={theme.accent}>[A] {t(lang, '检查更新', 'Check now')}</Text>
        </Box>
        {compactLayout ? (
          <>
            <Box flexDirection="row" gap={2} marginTop={0} height={1} overflow="hidden">
              <Text color={theme.accent}>{`[e] ${t(lang, '更改文件夹路径', 'Change folder')}`}</Text>
              <Text color={theme.accent}>{sampleActionLabel}</Text>
            </Box>
            <Box flexDirection="row" gap={2} height={1} overflow="hidden">
              <Text color={theme.accent}>{exportActionLabel}</Text>
              <Text color={theme.accent}>{contextActionLabel}</Text>
              {!confirmed ? <Text color={theme.warning}>{confirmActionLabel}</Text> : null}
            </Box>
          </>
        ) : (
          <Box flexDirection="row" gap={width < 92 ? 1 : 2} marginTop={0} height={1} overflow="hidden">
            <Text color={theme.accent}>{`[e] ${t(lang, '更改文件夹路径', 'Change folder')}`}</Text>
            <Text color={theme.accent}>{sampleActionLabel}</Text>
            <Text color={theme.accent}>{exportActionLabel}</Text>
            <Text color={theme.accent}>{contextActionLabel}</Text>
            {!confirmed ? <Text color={theme.warning}>{confirmActionLabel}</Text> : null}
          </Box>
        )}
      </Panel>

      <Panel
        title={t(lang, '学习库自动备份点 (Enter 恢复)', 'Library Restore Points (Enter to Restore)')}
        badge={ws.restorePoints.length}
        subtitle={ws.loadingPoints ? t(lang, `加载中${ell}`, `Loading${ell}`) : t(lang, '[Ctrl+R] 刷新', '[Ctrl+R] Refresh')}
        width={width}
        height={listPanelH}
      >
        {ws.loadingPoints && ws.restorePoints.length === 0 ? (
          <Spinner label={t(lang, `正在读取备份列表${ell}`, `Loading restore points${ell}`)} active={isActive} />
        ) : ws.restorePoints.length === 0 ? (
          <Text color={theme.muted}>
            {truncateDisplay(
              t(lang, '暂无备份点（学习库发生重要变更时会自动创建快照）', 'No restore points yet (created automatically on major edits).'),
              Math.max(10, width - 4),
              ell,
            )}
          </Text>
        ) : (
          <VirtualList
            items={ws.restorePoints}
            height={listRows}
            width={Math.max(10, width - 4)}
            selectedIndex={ws.selectedPointIdx}
            onChange={(idx) => ws.setSelectedPointIdx(idx)}
            onSelect={(pt) => ws.setConfirmRestore(pt)}
            renderItem={renderPoint}
            keyExtractor={(pt) => pt.id}
            isActive={isActive && !modalOpen}
          />
        )}
      </Panel>

      {ws.editingRoot ? (
        <Modal
          title={t(lang, '更改学习库文件夹路径', 'Change Library Folder Path')}
          width={modalW}
          onClose={() => ws.setEditingRoot(false)}
          isActive={isActive}
          hints={[
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>
            {t(lang, '输入绝对路径（留空恢复默认位置），支持 Linux/Windows 路径：', 'Enter folder path (empty resets to default):')}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={ws.rootDraft}
              onChange={ws.setRootDraft}
              onSubmit={(v) => void ws.handleSaveRoot(v)}
              onCancel={() => ws.setEditingRoot(false)}
              width={Math.max(12, modalContentWidth(modalW) - 4)}
              isActive={isActive}
              prompt={asciiMode ? '>' : '›'}
              placeholder={defaultRoot || '/path/to/StudyHub'}
            />
          </Box>
        </Modal>
      ) : null}

      {ws.exportingBackup ? (
        <Modal
          title={t(lang, '导出学习库备份', 'Export Library Backup')}
          width={modalW}
          onClose={() => ws.setExportingBackup(false)}
          isActive={isActive}
          hints={[
            { key: 'Enter', label: t(lang, '导出 JSON', 'Export JSON') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>
            {t(
              lang,
              '输入备份文件路径（支持 Linux/Windows 及拖拽路径，留空取消）：',
              'Enter backup file path (supports Linux/Windows & dropped paths):',
            )}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={ws.exportPathDraft}
              onChange={ws.setExportPathDraft}
              onSubmit={(v) => void handleExportBackup(v)}
              onCancel={() => ws.setExportingBackup(false)}
              width={Math.max(12, modalContentWidth(modalW) - 4)}
              isActive={isActive}
              prompt={asciiMode ? '>' : '›'}
              placeholder={defaultBackupPath(rootPath)}
            />
          </Box>
        </Modal>
      ) : null}

      {ws.confirmSampleRemove ? (
        <ConfirmDialog
          title={t(lang, '移除示例课程', 'Remove Sample Course')}
          message={t(lang, '确定要从当前学习库移除内置示例课程吗？', 'Remove the built-in sample course from this library?')}
          danger
          onConfirm={() => void ws.handleRemoveSample()}
          onCancel={() => ws.setConfirmSampleRemove(false)}
          isActive={isActive}
        />
      ) : null}

      {ws.confirmRestore ? (
        <ConfirmDialog
          title={t(lang, '恢复备份点', 'Restore Backup Point')}
          message={t(
            lang,
            `确定要恢复到 ${ws.confirmRestore.createdAt || ws.confirmRestore.id} 吗？当前未保存的更改将被替换。`,
            `Restore library to ${ws.confirmRestore.createdAt || ws.confirmRestore.id}?`,
          )}
          danger
          onConfirm={() => void ws.handleRestorePoint(ws.confirmRestore!)}
          onCancel={() => ws.setConfirmRestore(null)}
          isActive={isActive}
        />
      ) : null}

      {ws.confirmClearUsage ? (
        <ConfirmDialog
          title={t(lang, '删除全部使用记录', 'Clear Usage Frequency Data')}
          message={t(
            lang,
            '确定要删除所有本地记录的使用次数和日期吗？不影响学习库，也不会改变当前的开启/关闭开关。',
            'Delete all locally recorded usage counts and dates? This does not affect your study library or change the recording switch.',
          )}
          confirmLabel={t(lang, '清空记录', 'Clear Data')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          width={Math.min(62, Math.max(40, width - 6))}
          onConfirm={() => void ws.handleClearUsage()}
          onCancel={() => ws.setConfirmClearUsage(false)}
          isActive={isActive}
        />
      ) : null}

      {ws.retrievalDiagOpen ? (
        <RetrievalDiagModal
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          width={modalW}
          isActive={isActive}
          loading={ws.retrievalDiagLoading}
          providerFallback={ws.retrievalStatus?.effective || ws.retrievalStatus?.selected || 'builtin'}
          hfEndpoint={ws.retrievalStatus?.hfEndpoint ?? ''}
          plan={ws.retrievalPlan}
          testResult={ws.retrievalTest}
          error={ws.retrievalDiagError}
          onRefresh={() => void ws.runRetrievalDiag()}
          onPreview={ws.handleRetrievalPreview}
          onSaveEndpoint={ws.handleSaveHfEndpoint}
          onClose={() => ws.setRetrievalDiagOpen(false)}
        />
      ) : null}

      {ws.updateModalOpen ? (
        <ReleaseUpdateModal
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          width={modalW}
          isActive={isActive}
          loading={ws.updateCheckLoading}
          snoozeBusy={ws.updateSnoozeBusy}
          info={ws.updateInfo}
          error={ws.updateError}
          onRefresh={() => void ws.runUpdateCheck()}
          onToggleSnooze={() => void ws.handleToggleSnooze()}
          onClose={() => ws.setUpdateModalOpen(false)}
        />
      ) : null}

      {ws.usageReportOpen ? (
        <UsageReportModal
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          width={modalW}
          isActive={isActive}
          loading={ws.usageReportLoading}
          actionBusy={ws.usageReportActionBusy}
          period={ws.usageReportPeriod}
          usageStatus={ws.usageStatus}
          report={ws.usageReport}
          error={ws.usageReportError}
          lastExportPath={ws.usageReportExportPath}
          onSelectPeriod={ws.handleSelectUsagePeriod}
          onTogglePause={() => void ws.handleToggleUsagePause()}
          onExport={() => void ws.handleExportUsageReport()}
          onRefresh={() => void ws.loadUsageReport(ws.usageReportPeriod)}
          onClose={() => ws.setUsageReportOpen(false)}
        />
      ) : null}

      {ws.libraryCtxOpen ? (
        <LibraryContextModal
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          width={modalW}
          isActive={isActive}
          loading={ws.libraryCtxLoading}
          actionBusy={ws.libraryCtxActionBusy}
          contextData={ws.libraryCtxData}
          fallbackRoot={rootPath}
          error={ws.libraryCtxError}
          lastExportPath={ws.libraryCtxExportPath}
          onRefresh={() => void ws.loadLibraryContext()}
          onExport={() => void ws.handleExportLibraryContext()}
          onClose={() => ws.setLibraryCtxOpen(false)}
        />
      ) : null}
    </Box>
  );
});
