import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  Modal,
  Spinner,
  TextInput,
  VirtualList,
  modalContentWidth,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import { type DocumentGroup, normalizeFolderName } from './source-helpers.js';

export type FolderModalMode = 'filter' | 'assign';
type FolderSubMode = 'list' | 'create' | 'rename' | 'delete';

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
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useWindowSize();

  const [subMode, setSubMode] = useState<FolderSubMode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
  const [renameTarget, setRenameTarget] = useState('');
  const [deleteTarget, setDeleteTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  // Pre-position cursor on active filter or current source folder on mount.
  useEffect(() => {
    const targetName = mode === 'assign' ? (selectedItem?.folder || '') : activeFolder;
    if (targetName === null) {
      setSelectedIndex(0);
      return;
    }
    if (targetName === '') {
      const idx = items.findIndex((r) => r.kind === 'unfiled' || r.kind === 'unfile');
      if (idx >= 0) setSelectedIndex(idx);
      return;
    }
    const idx = items.findIndex((r) => r.kind === 'folder' && r.name === targetName);
    if (idx >= 0) setSelectedIndex(idx);
    // Only run on initial open / mode change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (selectedIndex >= items.length) {
      setSelectedIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, selectedIndex]);

  const currentRow = items[selectedIndex];

  const assignFolder = useCallback(
    async (folder: string | null) => {
      if (!selectedItem || busy) return;
      setBusy(true);
      setErr(null);
      try {
        const res = await tryAction(host, 'source.folder.set', {
          key: selectedItem.key,
          folder,
        });
        if (!res.ok) {
          setErr(res.error?.message || t(lang, '移动文件夹失败', 'Failed to move material'));
          return;
        }
        await onRefresh();
        notify(
          folder
            ? t(lang, `已移入文件夹「${folder}」`, `Moved to "${folder}"`)
            : t(lang, '已移出文件夹', 'Unfiled material'),
          'success',
        );
        onClose();
      } catch (error) {
        setErr(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [busy, host, lang, notify, onClose, onRefresh, selectedItem],
  );

  const handleRowActivate = useCallback(
    async (row: FolderRow) => {
      if (busy) return;
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
      if (busy) return;
      const name = normalizeFolderName(raw);
      if (!name) {
        setErr(t(lang, '请输入文件夹名称', 'Please enter a folder name'));
        return;
      }
      if (name.length > 80) {
        setErr(t(lang, '文件夹名称最多 80 个字符', 'Folder name must be at most 80 characters'));
        return;
      }
      setBusy(true);
      setErr(null);
      try {
        const res = await tryAction(host, 'source.folder.create', { name });
        if (!res.ok) {
          setErr(res.error?.message || t(lang, '创建文件夹失败', 'Create folder failed'));
          return;
        }
        await onRefresh();
        notify(t(lang, `已创建文件夹「${name}」`, `Created folder "${name}"`), 'success');
        setSubMode('list');
        setInputValue('');
        // Focus newly created folder
        const nextIdx = mode === 'filter' ? folders.length + 1 : folders.length;
        setSelectedIndex(nextIdx);
      } catch (error) {
        setErr(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [busy, folders.length, host, lang, mode, notify, onRefresh],
  );

  const handleRenameSubmit = useCallback(
    async (raw: string) => {
      if (busy) return;
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
      setBusy(true);
      setErr(null);
      try {
        const res = await tryAction(host, 'source.folder.rename', { from: renameTarget, to });
        if (!res.ok) {
          setErr(res.error?.message || t(lang, '重命名文件夹失败', 'Rename folder failed'));
          return;
        }
        if (activeFolder === renameTarget) {
          onSelectFilter(to);
        }
        await onRefresh();
        notify(t(lang, `已重命名为「${to}」`, `Renamed to "${to}"`), 'success');
        setSubMode('list');
        setInputValue('');
      } catch (error) {
        setErr(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [activeFolder, busy, host, lang, notify, onRefresh, onSelectFilter, renameTarget],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (busy || !deleteTarget) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await tryAction(host, 'source.folder.delete', {
        folder: deleteTarget,
        unfile: true,
      });
      if (!res.ok) {
        setErr(res.error?.message || t(lang, '删除文件夹失败', 'Delete folder failed'));
        setSubMode('list');
        return;
      }
      if (activeFolder === deleteTarget) {
        onSelectFilter(null);
      }
      await onRefresh();
      notify(t(lang, `已删除文件夹「${deleteTarget}」`, `Deleted folder "${deleteTarget}"`), 'success');
      setSubMode('list');
      setDeleteTarget('');
    } catch (error) {
      setErr(errorMessage(error));
      setSubMode('list');
    } finally {
      setBusy(false);
    }
  }, [activeFolder, busy, deleteTarget, host, lang, notify, onRefresh, onSelectFilter]);

  const listActive = isActive && subMode === 'list';

  useInput(
    (input) => {
      if (!listActive || busy) return;
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

  const hints: KeyHint[] = useMemo(() => {
    if (subMode === 'create' || subMode === 'rename') {
      return [
        { key: 'Enter', label: t(lang, '保存', 'Save') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    return [
      { key: 'Enter', label: mode === 'assign' ? t(lang, '移入', 'Move') : t(lang, '筛选', 'Filter') },
      { key: 'a', label: t(lang, '新建', 'New') },
      { key: 'r', label: t(lang, '重命名', 'Rename') },
      { key: 'd', label: t(lang, '删除', 'Delete') },
      { key: '0/x', label: mode === 'assign' ? t(lang, '移出', 'Unfile') : t(lang, '清空筛选', 'Clear') },
    ];
  }, [lang, mode, subMode]);

  const frameWidth = Math.max(46, Math.min(68, columns - 4));
  const innerWidth = modalContentWidth(frameWidth);
  const listHeight = Math.max(4, Math.min(12, termRows - 12));

  const title =
    mode === 'assign'
      ? t(lang, '移动资料到文件夹', 'Move to Folder')
      : t(lang, '资料文件夹管理', 'Material Folders');

  const subtitle =
    mode === 'assign' && selectedItem
      ? selectedItem.title
      : `${folders.length} ${t(lang, '个文件夹', 'folders')}`;

  return (
    <>
      <Modal
        title={title}
        subtitle={subtitle}
        icon={asciiMode ? '*' : '◈'}
        width={frameWidth}
        isActive={isActive && subMode !== 'delete'}
        onClose={subMode === 'list' ? onClose : () => { setErr(null); setSubMode('list'); }}
        hints={hints}
      >
        {mode === 'assign' && selectedItem ? (
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
        ) : (
          <Box flexDirection="column">
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
            <Spinner label={t(lang, `正在保存文件夹变更${ell}`, `Updating folders${ell}`)} />
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
          isActive={isActive && subMode === 'delete'}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setSubMode('list')}
        />
      ) : null}
    </>
  );
});
