import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { BindingSnapshot, HostClient } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { cleanPathInput, loadSampleCourse, removeSampleCourse, tryAction } from '../../host/index.js';
import { useShellActions } from '../../shell/index.js';
import {
  Badge,
  ConfirmDialog,
  Modal,
  Panel,
  Spinner,
  TextInput,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/index.js';

export interface RestorePointEntry {
  id: string;
  createdAt?: string;
  reason?: string;
  sizeBytes?: number;
  cards?: number;
}

export interface WorkspaceTabProps {
  host: HostClient;
  binding: BindingSnapshot | null;
  width: number;
  height: number;
  isActive: boolean;
  onRefreshBinding: () => Promise<void>;
}

function formatBytes(bytes?: number): string {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

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
  const snapshot = useTuiStore((s) => s.snapshot);
  const desktopConfig = useTuiStore((s) => s.desktopConfig);
  const notify = useTuiStore((s) => s.notify);
  const { refresh: refreshSnapshot } = useShellActions();

  const sampleLoaded = Boolean(snapshot?.sample?.loaded);

  const [restorePoints, setRestorePoints] = useState<RestorePointEntry[]>([]);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [selectedPointIdx, setSelectedPointIdx] = useState(0);

  const [editingRoot, setEditingRoot] = useState(false);
  const [rootDraft, setRootDraft] = useState('');
  const [confirmSampleRemove, setConfirmSampleRemove] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<RestorePointEntry | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPoints = useCallback(async () => {
    setLoadingPoints(true);
    const res = await tryAction<{ points?: RestorePointEntry[] }>(host, 'library.restorePoints.list', {});
    if (!mountedRef.current) return;
    setLoadingPoints(false);
    if (res.ok && Array.isArray(res.value?.points)) {
      setRestorePoints(res.value.points);
    }
  }, [host]);

  useEffect(() => {
    void loadPoints();
  }, [loadPoints, snapshot?.revision]);

  const handleSaveRoot = useCallback(
    async (raw: string) => {
      const cleaned = cleanPathInput(raw);
      setEditingRoot(false);
      if (!cleaned) return;
      setBusyAction(t(lang, '切换学习库路径…', 'Switching library folder…'));
      const res = await tryAction<BindingSnapshot>(host, 'binding.set', { root: cleaned });
      if (!mountedRef.current) return;
      setBusyAction(null);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '切换学习库失败', 'Failed to change library folder'), 'error');
        return;
      }
      await Promise.all([onRefreshBinding(), refreshSnapshot()]);
      notify(t(lang, `学习库已切换到 ${cleaned}`, `Library switched to ${cleaned}`), 'success');
    },
    [host, lang, notify, onRefreshBinding, refreshSnapshot],
  );

  const handleConfirmLocation = useCallback(async () => {
    setBusyAction(t(lang, '确认当前位置…', 'Confirming location…'));
    const res = await tryAction(host, 'desktop.library.confirm', {});
    if (!mountedRef.current) return;
    setBusyAction(null);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '确认失败', 'Failed to confirm location'), 'error');
      return;
    }
    await onRefreshBinding();
    notify(t(lang, '已确认当前学习库位置', 'Library location confirmed'), 'success');
  }, [host, lang, notify, onRefreshBinding]);

  const handleToggleSample = useCallback(async () => {
    if (busyAction) return;
    if (sampleLoaded) {
      setConfirmSampleRemove(true);
      return;
    }
    setBusyAction(t(lang, '载入示例课程…', 'Loading sample course…'));
    try {
      await loadSampleCourse(host, { language: lang });
      await refreshSnapshot();
      notify(t(lang, '示例课程已载入', 'Sample course loaded'), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  }, [busyAction, host, lang, notify, refreshSnapshot, sampleLoaded]);

  const handleRemoveSample = useCallback(async () => {
    setConfirmSampleRemove(false);
    setBusyAction(t(lang, '移除示例课程…', 'Removing sample course…'));
    try {
      await removeSampleCourse(host);
      await refreshSnapshot();
      notify(t(lang, '示例课程已移除', 'Sample course removed'), 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  }, [host, lang, notify, refreshSnapshot]);

  const handleRestorePoint = useCallback(
    async (point: RestorePointEntry) => {
      setConfirmRestore(null);
      setBusyAction(t(lang, '恢复备份点…', 'Restoring backup…'));
      const res = await tryAction(host, 'library.restorePoints.restore', { id: point.id });
      if (!mountedRef.current) return;
      setBusyAction(null);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '恢复备份失败', 'Failed to restore backup'), 'error');
        return;
      }
      await Promise.all([refreshSnapshot(), loadPoints()]);
      notify(t(lang, '已恢复到选定备份点', 'Restored selected backup'), 'success');
    },
    [host, lang, loadPoints, notify, refreshSnapshot],
  );

  const modalOpen = editingRoot || confirmSampleRemove || Boolean(confirmRestore);
  const claimed = useMemo(() => ['e', 's', 'r', 'c'], []);
  useClaimKeys(claimed, isActive && !modalOpen);

  useInput(
    (input, key) => {
      if (input === 'e') {
        setRootDraft(binding?.root || host.getLibraryRoot() || '');
        setEditingRoot(true);
        return;
      }
      if (input === 's') {
        void handleToggleSample();
        return;
      }
      if (input === 'c' && desktopConfig && !desktopConfig.libraryPlaceConfirmed) {
        void handleConfirmLocation();
        return;
      }
      if (input === 'r') {
        void loadPoints();
        return;
      }
      if (key.return && restorePoints[selectedPointIdx]) {
        setConfirmRestore(restorePoints[selectedPointIdx]);
      }
    },
    { isActive: isActive && !modalOpen },
  );

  const rootPath = binding?.root || host.getLibraryRoot() || '';
  const defaultRoot = binding?.defaultRoot || '';
  const confirmed = desktopConfig?.libraryPlaceConfirmed ?? true;

  const infoPanelH = 9;
  const listPanelH = Math.max(6, height - infoPanelH);
  const listRows = Math.max(1, listPanelH - 2);

  const renderPoint = useCallback(
    (pt: RestorePointEntry, ctx: VirtualListRenderContext) => {
      const ts = pt.createdAt ? pt.createdAt.slice(0, 19).replace('T', ' ') : pt.id;
      const right = `${formatBytes(pt.sizeBytes)}${pt.cards !== undefined ? ` · ${pt.cards} cards` : ''}`;
      const rightW = displayWidth(right);
      const leftW = Math.max(8, ctx.width - rightW - 4);
      const label = truncateDisplay(`${ctx.selected ? '❯' : ' '} ${ts} ${pt.reason ? `· ${pt.reason}` : ''}`, leftW);
      return (
        <Box width={ctx.width} height={1}>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {padDisplay(label, leftW + 2)}
          </Text>
          <Text color={theme.muted}>{padDisplay(right, rightW + 2, 'right')}</Text>
        </Box>
      );
    },
    [theme.muted, theme.selectionFg, theme.text],
  );

  const modalW = Math.min(72, Math.max(40, width - 6));

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Panel
        title={t(lang, '学习库路径与工作区', 'Library Root & Workspace')}
        subtitle={busyAction || binding?.rootSource || undefined}
        focused={isActive && !modalOpen}
        width={width}
        height={infoPanelH}
      >
        <Box flexDirection="row" gap={1}>
          <Text color={theme.muted}>{t(lang, '当前学习库:', 'Current Root:')}</Text>
          <Text color={theme.primary} bold>
            {truncateDisplay(rootPath, Math.max(10, width - 22))}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={theme.muted}>{t(lang, '默认路径:  ', 'Default Root:')}</Text>
          <Text color={theme.dim}>{truncateDisplay(defaultRoot || '-', Math.max(10, width - 22))}</Text>
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
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Text color={theme.accent}>{`[e] ${t(lang, '更改文件夹路径', 'Change folder')}`}</Text>
          <Text color={theme.accent}>
            {`[s] ${sampleLoaded ? t(lang, '移除示例课程', 'Remove sample') : t(lang, '载入示例课程', 'Load sample')}`}
          </Text>
          {!confirmed ? <Text color={theme.warning}>{`[c] ${t(lang, '确认位置', 'Confirm place')}`}</Text> : null}
        </Box>
      </Panel>

      <Panel
        title={t(lang, '学习库自动备份点 (Enter 恢复)', 'Library Restore Points (Enter to Restore)')}
        badge={restorePoints.length}
        subtitle={loadingPoints ? t(lang, '加载中…', 'Loading…') : '[r] 刷新'}
        width={width}
        height={listPanelH}
      >
        {loadingPoints && restorePoints.length === 0 ? (
          <Spinner label={t(lang, '正在读取备份列表…', 'Loading restore points…')} active={isActive} />
        ) : restorePoints.length === 0 ? (
          <Text color={theme.muted}>
            {t(lang, '暂无备份点（学习库发生重要变更时会自动创建快照）', 'No restore points yet (created automatically on major edits).')}
          </Text>
        ) : (
          <VirtualList
            items={restorePoints}
            height={listRows}
            width={Math.max(10, width - 4)}
            selectedIndex={selectedPointIdx}
            onChange={(idx) => setSelectedPointIdx(idx)}
            onSelect={(pt) => setConfirmRestore(pt)}
            renderItem={renderPoint}
            keyExtractor={(pt) => pt.id}
            isActive={isActive && !modalOpen}
          />
        )}
      </Panel>

      {editingRoot ? (
        <Modal
          title={t(lang, '更改学习库文件夹路径', 'Change Library Folder Path')}
          width={modalW}
          onClose={() => setEditingRoot(false)}
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
              value={rootDraft}
              onChange={setRootDraft}
              onSubmit={(v) => void handleSaveRoot(v)}
              onCancel={() => setEditingRoot(false)}
              width={modalContentWidth(modalW)}
              isActive={isActive}
              prompt="›"
              placeholder={defaultRoot || '/path/to/StudyHub'}
            />
          </Box>
        </Modal>
      ) : null}

      {confirmSampleRemove ? (
        <ConfirmDialog
          title={t(lang, '移除示例课程', 'Remove Sample Course')}
          message={t(lang, '确定要从当前学习库移除内置示例课程吗？', 'Remove the built-in sample course from this library?')}
          danger
          onConfirm={() => void handleRemoveSample()}
          onCancel={() => setConfirmSampleRemove(false)}
          isActive={isActive}
        />
      ) : null}

      {confirmRestore ? (
        <ConfirmDialog
          title={t(lang, '恢复备份点', 'Restore Backup Point')}
          message={t(
            lang,
            `确定要恢复到 ${confirmRestore.createdAt || confirmRestore.id} 吗？当前未保存的更改将被替换。`,
            `Restore library to ${confirmRestore.createdAt || confirmRestore.id}?`,
          )}
          danger
          onConfirm={() => void handleRestorePoint(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
          isActive={isActive}
        />
      ) : null}
    </Box>
  );
});
