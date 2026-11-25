import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import { type DocumentGroup, normalizeFolderName } from './source-helpers.js';

export type FolderModalMode = 'filter' | 'assign';
type FolderSubMode = 'list' | 'create' | 'rename' | 'delete' | 'ai-confirm' | 'ai-preview';

interface FolderSuggestionItem {
  key: string;
  title: string;
  currentFolder: string | null;
  suggestedFolder: string;
}

export interface FolderModalProps {
  host: HostClient;
  mode: FolderModalMode;
  folders: readonly string[];
  folderCounts: ReadonlyMap<string, number>;
  totalCount: number;
  activeFolder: string | null;
  selectedItem?: DocumentGroup;
  isActive: boolean;
  onSelectFilter: (folder: string | null) => void;
  onRefresh: () => Promise<void> | void;
  onClose: () => void;
}

type FolderRow =
  | { kind: 'all'; id: string; label: string; count: number }
  | { kind: 'folder'; id: string; name: string; label: string; count: number }
  | { kind: 'unfiled'; id: string; label: string; count: number }
  | { kind: 'unfile'; id: string; label: string; count: number };

interface PendingClassifyEntry {
  jobId?: string;
  course?: string;
  createdAt?: string;
  folders?: string[];
  suggestions?: unknown[];
  unmatchedKeys?: string[];
}

function resolvePendingClassify(
  settings: Record<string, unknown> | undefined,
  focusCourse: string,
): { entry: PendingClassifyEntry; course: string } | null {
  if (!settings || typeof settings !== 'object') return null;
  const byCourse = settings.materialClassifyPendingByCourse;
  if (byCourse && typeof byCourse === 'object' && !Array.isArray(byCourse)) {
    const map = byCourse as Record<string, unknown>;
    if (focusCourse && map[focusCourse] && typeof map[focusCourse] === 'object') {
      return { entry: map[focusCourse] as PendingClassifyEntry, course: focusCourse };
    }
    if (map['*'] && typeof map['*'] === 'object') {
      return { entry: map['*'] as PendingClassifyEntry, course: '' };
    }
    let bestSlot = '';
    let bestEntry: PendingClassifyEntry | null = null;
    for (const [slot, val] of Object.entries(map)) {
      if (!val || typeof val !== 'object') continue;
      const cand = val as PendingClassifyEntry;
      if (!bestEntry || String(cand.createdAt || '') >= String(bestEntry.createdAt || '')) {
        bestEntry = cand;
        bestSlot = slot;
      }
    }
    if (bestEntry) {
      return { entry: bestEntry, course: bestSlot === '*' ? '' : bestSlot };
    }
  }
  const legacy = settings.materialClassifyPending;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    const entry = legacy as PendingClassifyEntry;
    const rawCourse = typeof entry.course === 'string' ? entry.course.trim() : '';
    const course = rawCourse === '*' ? '' : rawCourse;
    return { entry, course };
  }
  return null;
}

export const FolderModal = memo(function FolderModal({
  host,
  mode,
  folders,
  folderCounts,
  totalCount,
  activeFolder,
  selectedItem,
  isActive,
  onSelectFilter,
  onRefresh,
  onClose,
}: FolderModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useStableWindowSize();

  const focusCourse = useMemo(() => {
    const raw = (snapshot?.focus as { course?: unknown } | undefined)?.course;
    return typeof raw === 'string' ? raw.trim() : '';
  }, [snapshot]);

  const pendingClassify = useMemo(
    () => resolvePendingClassify(snapshot?.settings, focusCourse),
    [snapshot, focusCourse],
  );
  const pendingCount = Array.isArray(pendingClassify?.entry.suggestions)
    ? pendingClassify.entry.suggestions.length
    : 0;

  const [subMode, setSubMode] = useState<FolderSubMode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [renameTarget, setRenameTarget] = useState('');
  const [deleteTarget, setDeleteTarget] = useState('');
  const [aiSuggestions, setAiSuggestions] = useState<FolderSuggestionItem[]>([]);
  const [aiPreviewIndex, setAiPreviewIndex] = useState(0);
  const [aiUnmatchedCount, setAiUnmatchedCount] = useState(0);
  const [aiPhaseLabel, setAiPhaseLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const items: FolderRow[] = useMemo(() => {
    const folderRows: FolderRow[] = folders.map((name) => ({
      kind: 'folder',
      id: `folder:${name}`,
      name,
      label: name,
      count: folderCounts.get(name) ?? 0,
    }));
    if (mode === 'filter') {
      return [
        { kind: 'all', id: '__all__', label: t(lang, '全部资料', 'All Materials'), count: totalCount },
        ...folderRows,
        { kind: 'unfiled', id: '__unfiled__', label: t(lang, '未归类资料', 'Unfiled'), count: folderCounts.get('') ?? 0 },
      ];
    }
    return [
      ...folderRows,
      { kind: 'unfile', id: '__unfile__', label: t(lang, '移出文件夹（未归类）', 'Unfile (No folder)'), count: folderCounts.get('') ?? 0 },
    ];
  }, [folders, folderCounts, lang, mode, totalCount]);

  const initFocusRef = useRef({ activeFolder, items, selectedFolder: selectedItem?.folder });
  initFocusRef.current = { activeFolder, items, selectedFolder: selectedItem?.folder };

  // Pre-position cursor on active filter or current source folder on mount.
  useEffect(() => {
    const { activeFolder: initFolder, items: initItems, selectedFolder } = initFocusRef.current;
    const targetName = mode === 'assign' ? (selectedFolder || '') : initFolder;
    if (targetName === null) {
      setSelectedIndex(0);
      return;
    }
    if (targetName === '') {
      const idx = initItems.findIndex((r) => r.kind === 'unfiled' || r.kind === 'unfile');
      if (idx >= 0) setSelectedIndex(idx);
      return;
    }
    const idx = initItems.findIndex((r) => r.kind === 'folder' && r.name === targetName);
    if (idx >= 0) setSelectedIndex(idx);
    // Only run on initial open / mode change
  }, [mode]);

  useEffect(() => {
    if (selectedIndex >= items.length) {
      setSelectedIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, selectedIndex]);

  const currentRow = items[selectedIndex];

  const assignFolder = useCallback(
    async (folder: string | null) => {
      if (!selectedItem || busyRef.current || busy) return;
      busyRef.current = true;
      setBusy(true);
      setErr(null);
      try {
        const res = await tryAction(host, 'source.folder.set', {
          key: selectedItem.key,
          folder,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          setErr(res.error?.message || t(lang, '移动文件夹失败', 'Failed to move material'));
          return;
        }
        await onRefresh();
        if (!mountedRef.current) return;
        notify(
          folder
            ? t(lang, `已移入文件夹「${folder}」`, `Moved to "${folder}"`)
            : t(lang, '已移出文件夹', 'Unfiled material'),
          'success',
        );
        onClose();
      } catch (error) {
        if (mountedRef.current) setErr(errorMessage(error));
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, lang, notify, onClose, onRefresh, selectedItem],
  );

  const handleRowActivate = useCallback(
    async (row: FolderRow) => {
      if (busyRef.current || busy) return;
      if (mode === 'filter') {
        if (row.kind === 'all') onSelectFilter(null);
        else if (row.kind === 'unfiled') onSelectFilter('');
        else if (row.kind === 'folder') onSelectFilter(row.name);
        onClose();
        return;
      }
      if (row.kind === 'folder') {
        await assignFolder(row.name);
      } else if (row.kind === 'unfile') {
        await assignFolder(null);
      }
    },
    [assignFolder, busy, mode, onClose, onSelectFilter],
  );

  const handleCreateSubmit = useCallback(
    async (raw: string) => {
      if (busyRef.current || busy) return;
      const name = normalizeFolderName(raw);
      if (!name) {
        setErr(t(lang, '请输入文件夹名称', 'Please enter a folder name'));
        return;
      }
      if (name.length > 80) {
        setErr(t(lang, '文件夹名称最多 80 个字符', 'Folder name must be at most 80 characters'));
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setErr(null);
      try {
        const res = await tryAction(host, 'source.folder.create', { name });
        if (!mountedRef.current) return;
        if (!res.ok) {
          setErr(res.error?.message || t(lang, '创建文件夹失败', 'Create folder failed'));
          return;
        }
        await onRefresh();
        if (!mountedRef.current) return;
        notify(t(lang, `已创建文件夹「${name}」`, `Created folder "${name}"`), 'success');
        setSubMode('list');
        setInputValue('');
        // Focus newly created folder
        const nextIdx = mode === 'filter' ? folders.length + 1 : folders.length;
        setSelectedIndex(nextIdx);
      } catch (error) {
        if (mountedRef.current) setErr(errorMessage(error));
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, folders.length, host, lang, mode, notify, onRefresh],
  );

  const handleRenameSubmit = useCallback(
    async (raw: string) => {
      if (busyRef.current || busy) return;
      const to = normalizeFolderName(raw);
      if (!to) {
        setErr(t(lang, '请输入新的文件夹名称', 'Please enter a new folder name'));
        return;
      }
      if (to.length > 80) {
        setErr(t(lang, '文件夹名称最多 80 个字符', 'Folder name must be at most 80 characters'));
        return;
      }
      if (to === renameTarget) {
        setSubMode('list');
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setErr(null);
      try {
        const res = await tryAction(host, 'source.folder.rename', { from: renameTarget, to });
        if (!mountedRef.current) return;
        if (!res.ok) {
          setErr(res.error?.message || t(lang, '重命名文件夹失败', 'Rename folder failed'));
          return;
        }
        if (activeFolder === renameTarget) {
          onSelectFilter(to);
        }
        await onRefresh();
        if (!mountedRef.current) return;
        notify(t(lang, `已重命名为「${to}」`, `Renamed to "${to}"`), 'success');
        setSubMode('list');
        setInputValue('');
      } catch (error) {
        if (mountedRef.current) setErr(errorMessage(error));
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [activeFolder, busy, host, lang, notify, onRefresh, onSelectFilter, renameTarget],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (busyRef.current || busy || !deleteTarget) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const res = await tryAction(host, 'source.folder.delete', {
        folder: deleteTarget,
        unfile: true,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setErr(res.error?.message || t(lang, '删除文件夹失败', 'Delete folder failed'));
        setSubMode('list');
        return;
      }
      if (activeFolder === deleteTarget) {
        onSelectFilter(null);
      }
      await onRefresh();
      if (!mountedRef.current) return;
      notify(t(lang, `已删除文件夹「${deleteTarget}」`, `Deleted folder "${deleteTarget}"`), 'success');
      setSubMode('list');
      setDeleteTarget('');
    } catch (error) {
      if (mountedRef.current) {
        setErr(errorMessage(error));
        setSubMode('list');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [activeFolder, busy, deleteTarget, host, lang, notify, onRefresh, onSelectFilter]);

  const handleAiSuggest = useCallback(async () => {
    if (busyRef.current || busy) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    setAiPhaseLabel(t(lang, `正在调用 AI 生成文件夹建议${ell}`, `Suggesting folders with AI${ell}`));
    setSubMode('list');
    try {
      const res = await tryAction<{
        folders?: string[];
        suggestions?: Array<{
          key?: string;
          title?: string;
          currentFolder?: string | null;
          suggestedFolder?: string;
        }>;
        unmatchedKeys?: string[];
      }>(host, 'source.folder.suggest', {
        mode: 'auto',
        language: lang,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setErr(res.error?.message || t(lang, 'AI 文件夹分类建议失败', 'Failed to suggest folders'));
        return;
      }
      const rawSuggestions = Array.isArray(res.value.suggestions) ? res.value.suggestions : [];
      const normalized: FolderSuggestionItem[] = [];
      for (const item of rawSuggestions) {
        const key = typeof item?.key === 'string' ? item.key.trim() : '';
        const suggestedFolder = normalizeFolderName(item?.suggestedFolder);
        if (!key || !suggestedFolder) continue;
        normalized.push({
          key,
          title: (typeof item?.title === 'string' && item.title.trim()) || key,
          currentFolder:
            typeof item?.currentFolder === 'string' && item.currentFolder.trim()
              ? item.currentFolder.trim()
              : null,
          suggestedFolder,
        });
      }
      if (normalized.length === 0) {
        setErr(t(lang, '未生成可应用的文件夹分类建议', 'No folder suggestions returned'));
        return;
      }
      setAiSuggestions(normalized);
      setAiPreviewIndex(0);
      setAiUnmatchedCount(Array.isArray(res.value.unmatchedKeys) ? res.value.unmatchedKeys.length : 0);
      setSubMode('ai-preview');
    } catch (error) {
      if (mountedRef.current) {
        setErr(errorMessage(error, lang));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setAiPhaseLabel(null);
      }
    }
  }, [busy, ell, host, lang]);

  const handleAiApply = useCallback(async () => {
    if (busyRef.current || busy || aiSuggestions.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    setAiPhaseLabel(t(lang, `正在应用 AI 文件夹分类${ell}`, `Applying folder assignments${ell}`));
    try {
      const assignments = aiSuggestions.map((item) => ({
        key: item.key,
        folder: item.suggestedFolder,
      }));
      const res = await tryAction<{ updated?: number; createdFolders?: string[] }>(
        host,
        'source.folder.apply',
        { assignments },
      );
      if (!mountedRef.current) return;
      if (!res.ok) {
        setErr(res.error?.message || t(lang, '应用文件夹分类失败', 'Failed to apply folder assignments'));
        return;
      }
      await onRefresh();
      if (!mountedRef.current) return;
      const count = res.value?.updated ?? assignments.length;
      notify(
        t(lang, `已应用 ${count} 份资料的 AI 文件夹分类`, `Applied AI folder classification to ${count} material(s)`),
        'success',
      );
      setAiSuggestions([]);
      setAiUnmatchedCount(0);
      setSubMode('list');
    } catch (error) {
      if (mountedRef.current) {
        setErr(errorMessage(error, lang));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setAiPhaseLabel(null);
      }
    }
  }, [aiSuggestions, busy, ell, host, lang, notify, onRefresh]);

  const discardAiPreview = useCallback(() => {
    if (busyRef.current || busy) return;
    setErr(null);
    setAiSuggestions([]);
    setAiUnmatchedCount(0);
    setSubMode('list');
  }, [busy]);

  const handleDismissPending = useCallback(async () => {
    if (busyRef.current || busy || !pendingClassify) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    setAiPhaseLabel(t(lang, `正在清除待审分夹建议${ell}`, `Dismissing pending proposals${ell}`));
    try {
      const course = pendingClassify.course;
      const res = await tryAction<{ dismissed?: boolean }>(
        host,
        'source.folder.dismiss',
        { ...(course ? { course } : {}) },
      );
      if (!mountedRef.current) return;
      if (!res.ok) {
        setErr(res.error?.message || t(lang, '清除待审分夹建议失败', 'Failed to dismiss pending folder proposals'));
        return;
      }
      await onRefresh();
      if (!mountedRef.current) return;
      notify(
        t(lang, '已清除待审文件夹分类建议', 'Dismissed pending folder classification proposal'),
        'success',
      );
    } catch (error) {
      if (mountedRef.current) setErr(errorMessage(error, lang));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setAiPhaseLabel(null);
      }
    }
  }, [busy, ell, host, lang, notify, onRefresh, pendingClassify]);

  const listActive = isActive && subMode === 'list' && !busy;
  const previewActive = isActive && subMode === 'ai-preview' && !busy;

  useInput(
    (input) => {
      if (!listActive || busyRef.current || busy) return;
      if (input === 'a') {
        setErr(null);
        setInputValue('');
        setSubMode('create');
      } else if (input === 'r' && currentRow?.kind === 'folder') {
        setErr(null);
        setRenameTarget(currentRow.name);
        setInputValue(currentRow.name);
        setSubMode('rename');
      } else if (input === 'd' && currentRow?.kind === 'folder') {
        setErr(null);
        setDeleteTarget(currentRow.name);
        setSubMode('delete');
      } else if (input === 'g') {
        setErr(null);
        setSubMode('ai-confirm');
      } else if (input === 'X' && pendingClassify) {
        void handleDismissPending();
      } else if (input === '0' || input === 'x') {
        if (mode === 'filter') {
          onSelectFilter(null);
          onClose();
        } else {
          void assignFolder(null);
        }
      }
    },
    { isActive: listActive },
  );

  useInput(
    (input, key) => {
      if (!previewActive || busyRef.current || busy) return;
      if (key.return || input === 'y' || input === 'Y') {
        void handleAiApply();
      }
    },
    { isActive: previewActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (subMode === 'create' || subMode === 'rename') {
      return [
        { key: 'Enter', label: t(lang, '保存', 'Save') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (subMode === 'ai-preview') {
      return [
        { key: 'Enter/y', label: t(lang, '应用分类', 'Apply') },
        { key: 'Esc', label: t(lang, '放弃', 'Discard') },
      ];
    }
    const listHints: KeyHint[] = [
      { key: 'Enter', label: mode === 'assign' ? t(lang, '移入', 'Move') : t(lang, '筛选', 'Filter') },
      { key: 'a', label: t(lang, '新建', 'New') },
      { key: 'r', label: t(lang, '重命名', 'Rename') },
      { key: 'd', label: t(lang, '删除', 'Delete') },
      { key: 'g', label: t(lang, 'AI分类', 'AI Classify') },
    ];
    if (pendingClassify) {
      listHints.push({ key: 'X', label: t(lang, '清除待审', 'Dismiss') });
    }
    listHints.push({ key: '0/x', label: mode === 'assign' ? t(lang, '移出', 'Unfile') : t(lang, '清空筛选', 'Clear') });
    return listHints;
  }, [lang, mode, pendingClassify, subMode]);

  const frameWidth = Math.max(46, Math.min(68, columns - 4));
  const innerWidth = modalContentWidth(frameWidth);
  const listHeight = Math.max(4, Math.min(12, termRows - (pendingClassify ? 14 : 12)));
  const arrow = asciiMode ? '->' : '→';

  const title =
    subMode === 'ai-preview'
      ? t(lang, 'AI 文件夹分类预览', 'AI Folder Preview')
      : mode === 'assign'
        ? t(lang, '移动资料到文件夹', 'Move to Folder')
        : t(lang, '资料文件夹管理', 'Material Folders');

  const subtitle =
    subMode === 'ai-preview'
      ? `${aiSuggestions.length} ${t(lang, '条建议', 'suggestions')}`
      : mode === 'assign' && selectedItem
        ? selectedItem.title
        : `${folders.length} ${t(lang, '个文件夹', 'folders')}`;

  return (
    <>
      <Modal
        title={title}
        subtitle={subtitle}
        icon={asciiMode ? '*' : '◈'}
        width={frameWidth}
        isActive={isActive && !busy && subMode !== 'delete' && subMode !== 'ai-confirm'}
        onClose={
          subMode === 'list'
            ? onClose
            : subMode === 'ai-preview'
              ? discardAiPreview
              : () => { setErr(null); setSubMode('list'); }
        }
        hints={hints}
      >
        {mode === 'assign' && selectedItem && subMode !== 'ai-preview' ? (
          <Box marginBottom={1} flexDirection="row">
            <Text color={theme.muted}>{t(lang, '当前位置: ', 'Current: ')}</Text>
            <Badge
              label={selectedItem.folder || t(lang, '未归类', 'Unfiled')}
              tone={selectedItem.folder ? 'accent' : 'muted'}
              variant="soft"
            />
          </Box>
        ) : null}

        {subMode === 'create' ? (
          <Box flexDirection="column" marginY={1}>
            <Text color={theme.primary} bold>
              {t(lang, '新建文件夹名称:', 'New folder name:')}
            </Text>
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(val) => void handleCreateSubmit(val)}
                onCancel={() => { setErr(null); setSubMode('list'); }}
                placeholder={t(lang, '例如：讲义、历年真题、实验笔记', 'e.g. Lectures, Past Exams')}
                width={Math.max(16, innerWidth - 4)}
                maxLength={80}
                isActive={isActive && !busy && subMode === 'create'}
                prompt={asciiMode ? '>' : '›'}
              />
            </Box>
          </Box>
        ) : subMode === 'rename' ? (
          <Box flexDirection="column" marginY={1}>
            <Text color={theme.primary} bold>
              {t(lang, `重命名文件夹「${renameTarget}」:`, `Rename folder "${renameTarget}":`)}
            </Text>
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(val) => void handleRenameSubmit(val)}
                onCancel={() => { setErr(null); setSubMode('list'); }}
                width={Math.max(16, innerWidth - 4)}
                maxLength={80}
                isActive={isActive && !busy && subMode === 'rename'}
                prompt={asciiMode ? '>' : '›'}
              />
            </Box>
          </Box>
        ) : subMode === 'ai-preview' ? (
          <Box flexDirection="column">
            <Box marginBottom={1} flexDirection="row" width={innerWidth}>
              <Badge
                label={`${t(lang, '建议', 'Suggestions')} ${aiSuggestions.length}`}
                tone="info"
                variant="soft"
              />
              {aiUnmatchedCount > 0 ? (
                <>
                  <Text> </Text>
                  <Badge
                    label={`${t(lang, '未匹配', 'Unmatched')} ${aiUnmatchedCount}`}
                    tone="muted"
                    variant="outline"
                  />
                </>
              ) : null}
              <Box flexGrow={1} />
              <Text color={theme.dim}>
                {t(lang, 'Enter/y 应用  Esc 放弃', 'Enter/y apply  Esc discard')}
              </Text>
            </Box>
            <VirtualList
              items={aiSuggestions}
              height={listHeight}
              width={innerWidth}
              selectedIndex={aiPreviewIndex}
              onChange={(idx) => setAiPreviewIndex(idx)}
              isActive={previewActive}
              keyExtractor={(item) => item.key}
              renderItem={(item, ctx) => {
                const cursor = ctx.selected ? (asciiMode ? '> ' : '› ') : '  ';
                const sep = ` ${arrow} `;
                const avail = Math.max(8, ctx.width - displayWidth(cursor) - displayWidth(sep));
                const folderMax = Math.max(6, Math.min(Math.floor(avail * 0.45), displayWidth(item.suggestedFolder)));
                const folderStr = truncateDisplay(item.suggestedFolder, folderMax, ell);
                const titleMax = Math.max(4, avail - displayWidth(folderStr));
                const titleStr = truncateDisplay(item.title, titleMax, ell);
                return (
                  <Box flexDirection="row" width={ctx.width}>
                    <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                    <Text color={theme.text} bold={ctx.selected}>
                      {titleStr}
                    </Text>
                    <Box flexGrow={1} />
                    <Text color={theme.dim}>{sep}</Text>
                    <Text color={theme.accent}>{folderStr}</Text>
                  </Box>
                );
              }}
            />
          </Box>
        ) : (
          <Box flexDirection="column">
            {pendingClassify ? (
              <Box marginBottom={1} flexDirection="row" width={innerWidth}>
                <Badge
                  label={t(lang, `待审分夹 ${pendingCount}`, `Pending classify ${pendingCount}`)}
                  tone="warning"
                  variant="soft"
                />
                <Text> </Text>
                <Text color={theme.dim} wrap="truncate-end">
                  {t(lang, '[X] 清除待审分夹建议', '[X] Dismiss pending')}
                </Text>
              </Box>
            ) : null}
            {mode === 'assign' && folders.length === 0 ? (
              <Box marginBottom={1}>
                <Text color={theme.dim}>
                  {t(lang, '暂无自定义文件夹，按 [a] 新建一个。', 'No folders yet. Press [a] to create one.')}
                </Text>
              </Box>
            ) : null}
            <VirtualList
              items={items}
              height={listHeight}
              width={innerWidth}
              selectedIndex={selectedIndex}
              onChange={(idx) => setSelectedIndex(idx)}
              onSelect={(row) => void handleRowActivate(row)}
              isActive={listActive && !busy}
              keyExtractor={(row) => row.id}
              renderItem={(row, ctx) => {
                const isCurrentFilter =
                  mode === 'filter' &&
                  ((row.kind === 'all' && activeFolder === null) ||
                    (row.kind === 'unfiled' && activeFolder === '') ||
                    (row.kind === 'folder' && activeFolder === row.name));
                const isCurrentAssign =
                  mode === 'assign' &&
                  ((row.kind === 'folder' && selectedItem?.folder === row.name) ||
                    (row.kind === 'unfile' && !selectedItem?.folder));
                const tag = isCurrentFilter
                  ? t(lang, ' [当前筛选]', ' [Active]')
                  : isCurrentAssign
                    ? t(lang, ' [当前]', ' [Current]')
                    : '';
                const countText = `${row.count}`;
                const icon =
                  row.kind === 'folder'
                    ? asciiMode
                      ? '> '
                      : '▸ '
                    : row.kind === 'all'
                      ? asciiMode
                        ? '* '
                        : '◈ '
                      : asciiMode
                        ? 'o '
                        : '○ ';
                const maxLabel = Math.max(10, ctx.width - countText.length - tag.length - 6);
                return (
                  <Box flexDirection="row" width={ctx.width}>
                    <Text color={ctx.selected ? theme.primary : theme.muted}>
                      {ctx.selected ? (asciiMode ? '> ' : '› ') : '  '}
                    </Text>
                    <Text color={row.kind === 'folder' ? theme.accent : theme.muted}>{icon}</Text>
                    <Text color={theme.text} bold={ctx.selected}>
                      {truncateDisplay(row.label, maxLabel, ell)}
                    </Text>
                    {tag ? <Text color={theme.success}>{tag}</Text> : null}
                    <Box flexGrow={1} />
                    <Text color={theme.dim}>{countText}</Text>
                  </Box>
                );
              }}
            />
          </Box>
        )}

        {busy ? (
          <Box marginTop={1}>
            <Spinner label={aiPhaseLabel ?? t(lang, `正在保存文件夹变更${ell}`, `Updating folders${ell}`)} />
          </Box>
        ) : null}
        {err ? (
          <Box marginTop={1}>
            <Text color={theme.error}>{`${asciiMode ? 'x' : '✕'} ${err}`}</Text>
          </Box>
        ) : null}
      </Modal>

      {subMode === 'delete' ? (
        <ConfirmDialog
          title={t(lang, '删除文件夹', 'Delete Folder')}
          message={t(
            lang,
            `确定删除文件夹「${deleteTarget}」吗？其中的资料会移回“未归类”，原文与引用均保留。`,
            `Delete folder "${deleteTarget}"? Its materials will become unfiled without deleting any text or citations.`,
          )}
          confirmLabel={t(lang, '确认删除', 'Delete')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && subMode === 'delete' && !busy}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setSubMode('list')}
        />
      ) : null}

      {subMode === 'ai-confirm' ? (
        <ConfirmDialog
          title={t(lang, 'AI 智能文件夹分类', 'AI Auto-Classify Folders')}
          message={t(
            lang,
            '将调用 AI 模型为资料生成主题文件夹分类建议（仅预览结果，确认应用前不会修改任何文件夹）。是否继续？',
            'Invoke the AI model to suggest topic folder assignments for your materials. Preview only - no folders will be changed until you apply.',
          )}
          confirmLabel={t(lang, '开始分析', 'Analyze')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive && subMode === 'ai-confirm' && !busy}
          onConfirm={() => void handleAiSuggest()}
          onCancel={() => setSubMode('list')}
        />
      ) : null}
    </>
  );
});
