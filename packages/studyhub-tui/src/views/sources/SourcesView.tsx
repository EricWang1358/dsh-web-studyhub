import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { ScrollView } from '../../components/ScrollView.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys, useInputCapture } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { useTheme } from '../../theme/tokens.js';
import { currentCourse } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { atomicWriteExportText, defaultBackupFilePath, todayLocalYmd } from '../../host/atomic-write.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import {
  type DocumentGroup,
  formatLabel,
  formatTone,
  groupSourcesFromSnapshot,
  materialFoldersFromSnapshot,
  normalizeFolderName,
} from './source-helpers.js';
const ImportModal = lazy(() => import('./ImportModal.js').then((m) => ({ default: m.ImportModal })));
const DocumentReader = lazy(() => import('./DocumentReader.js').then((m) => ({ default: m.DocumentReader })));
const FolderModal = lazy(() => import('./FolderModal.js').then((m) => ({ default: m.FolderModal })));
const CompanionsModal = lazy(() => import('./CompanionsModal.js').then((m) => ({ default: m.CompanionsModal })));
const OrganizeSourcesModal = lazy(() => import('./OrganizeSourcesModal.js').then((m) => ({ default: m.OrganizeSourcesModal })));
const SourceCoverageModal = lazy(() => import('./SourceCoverageModal.js').then((m) => ({ default: m.SourceCoverageModal })));
const MinerUModal = lazy(() => import('./MinerUModal.js').then((m) => ({ default: m.MinerUModal })));
const RereadQueueModal = lazy(() => import('./RereadQueueModal.js').then((m) => ({ default: m.RereadQueueModal })));
const OriginalFileModal = lazy(() => import('./OriginalFileModal.js').then((m) => ({ default: m.OriginalFileModal })));

export interface SourcesCatalogExportGroup extends DocumentGroup {
  originalStatus?: string;
  originalPath?: string;
  original?: {
    status?: string;
    path?: string;
    mode?: string;
  };
}

export interface SourcesCatalogExportInput {
  groups: readonly SourcesCatalogExportGroup[];
  course?: string | null;
  folderLabel?: string | null;
  lang: UiLanguage;
  generatedAt?: string | Date;
}

function escapeMdCell(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function formatCatalogDate(generatedAt?: string | Date): string {
  if (typeof generatedAt === 'string' && generatedAt.trim()) return generatedAt.trim();
  if (generatedAt instanceof Date) {
    const y = generatedAt.getFullYear();
    const m = String(generatedAt.getMonth() + 1).padStart(2, '0');
    const d = String(generatedAt.getDate()).padStart(2, '0');
    const hh = String(generatedAt.getHours()).padStart(2, '0');
    const mm = String(generatedAt.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }
  return todayLocalYmd();
}

function formatGroupStatus(group: SourcesCatalogExportGroup, lang: UiLanguage): string {
  if (group.pinned && group.archived) {
    return t(lang, '置顶 / 已归档', 'Pinned / Archived');
  }
  if (group.pinned) return t(lang, '已置顶', 'Pinned');
  if (group.archived) return t(lang, '已归档', 'Archived');
  return t(lang, '正常', 'Active');
}

/** Format a catalog of study material groups into a clean Markdown table and breakdown. */
export function formatSourcesCatalogMarkdown({
  groups,
  course,
  folderLabel,
  lang,
  generatedAt,
}: SourcesCatalogExportInput): string {
  const dateStr = formatCatalogDate(generatedAt);
  const totalPages = groups.reduce((sum, g) => sum + (Number(g.pageCount) || 0), 0);
  const totalCards = groups.reduce((sum, g) => sum + (Number(g.cardCount) || 0), 0);
  const cleanCourse = course ? escapeMdCell(course) : '';
  const cleanFolder = folderLabel ? escapeMdCell(folderLabel) : '';

  const lines: string[] = [
    `# ${t(lang, 'StudyHub 学习资料目录与引用覆盖', 'StudyHub Materials Catalog & Citation Coverage')}`,
    '',
    `- **${t(lang, '生成日期', 'Date')}**: ${dateStr}`,
  ];
  if (cleanCourse) {
    lines.push(`- **${t(lang, '课程筛选', 'Course Filter')}**: ${cleanCourse}`);
  }
  if (cleanFolder) {
    lines.push(`- **${t(lang, '文件夹筛选', 'Folder Filter')}**: ${cleanFolder}`);
  }
  lines.push(
    `- **${t(lang, '资料总数', 'Total Documents')}**: ${groups.length}`,
    `- **${t(lang, '总页数', 'Total Pages')}**: ${totalPages}`,
    `- **${t(lang, '关联题目总数', 'Total Linked Cards')}**: ${totalCards}`,
  );

  if (groups.length === 0) {
    lines.push('', t(lang, '当前筛选条件下暂无可导出的资料。', 'No materials match the current filters.'), '');
    return lines.join('\n');
  }

  lines.push(
    '',
    `## ${t(lang, '资料总览表', 'Materials Summary')}`,
    '',
    lang === 'zh'
      ? '| # | 标题 | 课程 | 文件夹 | 页数 | 关联题 | 状态 |'
      : '| # | Title | Course(s) | Folder | Pages | Linked Cards | Status |',
    '| ---: | --- | --- | --- | ---: | ---: | --- |',
  );

  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    const title = escapeMdCell(g.title || g.key) || t(lang, '未命名资料', 'Untitled');
    const coursesText =
      g.courses && g.courses.length > 0
        ? escapeMdCell(g.courses.join(', '))
        : t(lang, '未分配', 'Unassigned');
    const folderText = g.folder ? escapeMdCell(g.folder) : t(lang, '未归类', 'Unfiled');
    const pages = Number(g.pageCount) || 0;
    const cards = Number(g.cardCount) || 0;
    const status = formatGroupStatus(g, lang);
    lines.push(`| ${i + 1} | ${title} | ${coursesText} | ${folderText} | ${pages} | ${cards} | ${status} |`);
  }

  lines.push('', `## ${t(lang, '资料明细', 'Document Breakdown')}`, '');
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    const title = escapeMdCell(g.title || g.key) || t(lang, '未命名资料', 'Untitled');
    const fmt = formatLabel(g.format || 'text');
    const pages = Number(g.pageCount) || 0;
    const cards = Number(g.cardCount) || 0;
    const chars = (Number(g.chars) || 0).toLocaleString('en-US');
    const origStatus = g.originalStatus || g.original?.status;
    const origPath = g.originalPath || g.original?.path;
    const origParts: string[] = [];
    if (origStatus) origParts.push(escapeMdCell(origStatus));
    if (origPath) origParts.push(`\`${escapeMdCell(origPath)}\``);
    const origSuffix =
      origParts.length > 0
        ? `, ${t(lang, '原文件', 'Original')}: ${origParts.join(' ')}`
        : '';
    lines.push(
      `- **${i + 1}. ${title}** (${fmt}) — ${pages} ${t(lang, '页', 'pages')}, ${cards} ${t(lang, '关联题', 'linked cards')}, ${chars} ${t(lang, '字符', 'chars')}${origSuffix}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

type ActiveOverlay =
  | 'none'
  | 'import'
  | 'mineru'
  | 'rename'
  | 'course'
  | 'archive'
  | 'delete'
  | 'search'
  | 'folders-filter'
  | 'folders-assign'
  | 'folders-assign-batch'
  | 'companions'
  | 'organize'
  | 'coverage'
  | 'reread'
  | 'original';

type BatchFolderRow =
  | { kind: 'folder'; id: string; name: string; label: string; count: number }
  | { kind: 'unfile'; id: string; label: string; count: number };

interface BatchFolderModalProps {
  host: HostClient;
  selectedKeys: readonly string[];
  folders: readonly string[];
  folderCounts: ReadonlyMap<string, number>;
  isActive: boolean;
  onRefresh: () => Promise<void> | void;
  onAssigned: () => void;
  onClose: () => void;
}

const BatchFolderModal = memo(function BatchFolderModal({
  host,
  selectedKeys,
  folders,
  folderCounts,
  isActive,
  onRefresh,
  onAssigned,
  onClose,
}: BatchFolderModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useWindowSize();
  const ell = asciiMode ? '...' : '…';

  const [subMode, setSubMode] = useState<'list' | 'create'>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState('');
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

  const items: BatchFolderRow[] = useMemo(() => {
    const folderRows: BatchFolderRow[] = folders.map((name) => ({
      kind: 'folder',
      id: `folder:${name}`,
      name,
      label: name,
      count: folderCounts.get(name) ?? 0,
    }));
    return [
      ...folderRows,
      {
        kind: 'unfile',
        id: '__unfile__',
        label: t(lang, '移出文件夹（未归类）', 'Unfile (No folder)'),
        count: folderCounts.get('') ?? 0,
      },
    ];
  }, [folders, folderCounts, lang]);

  useEffect(() => {
    if (selectedIndex >= items.length) {
      setSelectedIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, selectedIndex]);

  const assignAll = useCallback(
    async (folder: string | null) => {
      if (busyRef.current || busy || selectedKeys.length === 0) return;
      busyRef.current = true;
      setBusy(true);
      setErr(null);
      try {
        const result = await executeBatchSourceFolderSet(host, selectedKeys, folder, lang);
        if (!mountedRef.current) return;
        if (!result.ok) {
          if (result.partial) await onRefresh();
          if (!mountedRef.current) return;
          setErr(result.error || t(lang, '批量移动文件夹失败', 'Batch move failed'));
          return;
        }
        await onRefresh();
        if (!mountedRef.current) return;
        onAssigned();
        notify(
          folder
            ? t(lang, `已将 ${result.updated} 份资料移入「${folder}」`, `Moved ${result.updated} materials to "${folder}"`)
            : t(lang, `已将 ${result.updated} 份资料移出文件夹`, `Unfiled ${result.updated} materials`),
          'success',
        );
        onClose();
      } catch (error) {
        if (mountedRef.current) setErr(errorMessage(error, lang));
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, lang, notify, onAssigned, onClose, onRefresh, selectedKeys],
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
        setSelectedIndex(folders.length);
      } catch (error) {
        if (mountedRef.current) setErr(errorMessage(error, lang));
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, folders.length, host, lang, notify, onRefresh],
  );

  const listActive = isActive && subMode === 'list' && !busy;
  useInput(
    (input) => {
      if (!listActive || busyRef.current || busy) return;
      if (input === 'a') {
        setErr(null);
        setInputValue('');
        setSubMode('create');
      } else if (input === '0' || input === 'x') {
        void assignAll(null);
      }
    },
    { isActive: listActive },
  );

  const hints: KeyHint[] = useMemo(
    () =>
      subMode === 'create'
        ? [
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '返回', 'Back') },
          ]
        : [
            { key: 'Enter', label: t(lang, '批量移入', 'Move all') },
            { key: 'a', label: t(lang, '新建', 'New') },
            { key: '0/x', label: t(lang, '移出', 'Unfile') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ],
    [lang, subMode],
  );

  const frameWidth = Math.max(46, Math.min(68, columns - 4));
  const innerWidth = modalContentWidth(frameWidth);
  const listHeight = Math.max(4, Math.min(12, termRows - 12));

  return (
    <Modal
      title={t(lang, '批量移动资料到文件夹', 'Batch Move to Folder')}
      subtitle={t(lang, `已选 ${selectedKeys.length} 份`, `${selectedKeys.length} selected`)}
      icon={asciiMode ? '*' : '◈'}
      width={frameWidth}
      isActive={isActive && !busy}
      onClose={
        subMode === 'list'
          ? onClose
          : () => {
              setErr(null);
              setSubMode('list');
            }
      }
      hints={hints}
    >
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
              onCancel={() => {
                setErr(null);
                setSubMode('list');
              }}
              placeholder={t(lang, '例如：讲义、历年真题、实验笔记', 'e.g. Lectures, Past Exams')}
              width={Math.max(16, innerWidth - 4)}
              maxLength={80}
              isActive={isActive && !busy && subMode === 'create'}
              prompt={asciiMode ? '>' : '›'}
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {folders.length === 0 ? (
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
            onSelect={(row) => void assignAll(row.kind === 'folder' ? row.name : null)}
            isActive={listActive}
            keyExtractor={(row) => row.id}
            renderItem={(row, ctx) => {
              const countText = `${row.count}`;
              const icon =
                row.kind === 'folder'
                  ? asciiMode
                    ? '> '
                    : '▸ '
                  : asciiMode
                    ? 'o '
                    : '○ ';
              const maxLabel = Math.max(10, ctx.width - countText.length - 6);
              return (
                <Box flexDirection="row" width={ctx.width}>
                  <Text color={ctx.selected ? theme.primary : theme.muted}>
                    {ctx.selected ? (asciiMode ? '> ' : '› ') : '  '}
                  </Text>
                  <Text color={row.kind === 'folder' ? theme.accent : theme.muted}>{icon}</Text>
                  <Text color={theme.text} bold={ctx.selected}>
                    {truncateDisplay(row.label, maxLabel, ell)}
                  </Text>
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
  );
});

export const SOURCE_BATCH_MAX = 100;

function chunkSourceBatch<T>(items: readonly T[], maxSize = SOURCE_BATCH_MAX): T[][] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const size = Math.max(1, Math.floor(maxSize));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function executeBatchSourceArchive(
  host: HostClient,
  sourceIds: readonly string[],
  archived: boolean,
  lang: 'zh' | 'en',
): Promise<{ ok: boolean; processedIds: string[]; partial: boolean; error?: string }> {
  const chunks = chunkSourceBatch(sourceIds, SOURCE_BATCH_MAX);
  const processedIds: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const res = await tryAction(host, 'source.archive', { sourceIds: chunk, archived });
    if (!res.ok) {
      const baseErr = res.error?.message || t(lang, '归档操作失败', 'Archive failed');
      const error =
        processedIds.length > 0
          ? t(
              lang,
              `已处理 ${processedIds.length}/${sourceIds.length} 份资料，第 ${i + 1}/${chunks.length} 批失败：${baseErr}`,
              `Processed ${processedIds.length}/${sourceIds.length} source(s); batch ${i + 1}/${chunks.length} failed: ${baseErr}`,
            )
          : baseErr;
      return { ok: false, processedIds, partial: processedIds.length > 0, error };
    }
    processedIds.push(...chunk);
  }
  return { ok: true, processedIds, partial: false };
}

export async function executeBatchSourceRemove(
  host: HostClient,
  sourceIds: readonly string[],
  lang: 'zh' | 'en',
): Promise<{ ok: boolean; removedCount: number; partial: boolean; error?: string }> {
  const uniqueIds = [...new Set(sourceIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { ok: true, removedCount: 0, partial: false };
  }
  // Backend `source.remove` has no 100-item cap and runs an atomic citation check across all
  // sourceIds; submitting as a single batch prevents half-deleting before hitting a referenced item.
  const res = await tryAction(host, 'source.remove', { sourceIds: uniqueIds, confirm: true });
  if (!res.ok) {
    const baseErr =
      res.error?.message || t(lang, '删除失败（可能被题组引用）', 'Delete failed (may be referenced by cards)');
    return { ok: false, removedCount: 0, partial: false, error: baseErr };
  }
  return { ok: true, removedCount: uniqueIds.length, partial: false };
}

export async function executeBatchSourceFolderSet(
  host: HostClient,
  keys: readonly string[],
  folder: string | null,
  lang: 'zh' | 'en',
): Promise<{ ok: boolean; updated: number; partial: boolean; error?: string }> {
  const chunks = chunkSourceBatch(keys, SOURCE_BATCH_MAX);
  let updated = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const res = await tryAction<{ updated?: number }>(host, 'source.folder.set', {
      keys: chunk,
      folder,
    });
    if (!res.ok) {
      const baseErr = res.error?.message || t(lang, '批量移动文件夹失败', 'Batch move failed');
      const error =
        updated > 0
          ? t(
              lang,
              `已移动 ${updated}/${keys.length} 份资料，第 ${i + 1}/${chunks.length} 批失败：${baseErr}`,
              `Moved ${updated}/${keys.length} material(s); batch ${i + 1}/${chunks.length} failed: ${baseErr}`,
            )
          : baseErr;
      return { ok: false, updated, partial: updated > 0, error };
    }
    updated += typeof res.value?.updated === 'number' ? res.value.updated : chunk.length;
  }
  return { ok: true, updated, partial: false };
}

export const SourcesView: React.FC<ViewProps> = memo(function SourcesView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navContext = useTuiStore((s) => s.navContext);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh } = useShellActions();

  const focusCourse = currentCourse(snapshot);
  const [courseFilterOn, setCourseFilterOn] = useState(Boolean(focusCourse));
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [overlay, setOverlay] = useState<ActiveOverlay>('none');

  // Reader state
  const [readerTarget, setReaderTarget] = useState<{
    sourceId?: string;
    documentId?: string;
    pageNumber?: number;
    title?: string;
    format?: string;
    course?: string;
    totalPages?: number;
  } | null>(null);

  // Small bounded preview cache (1 snippet at a time — memory NFR)
  const [previewSnippet, setPreviewSnippet] = useState<{ id: string; text: string }>({ id: '', text: '' });

  // Rename / Course edit buffers
  const [renameValue, setRenameValue] = useState('');
  const [courseValue, setCourseValue] = useState('');
  const [busy, setBusy] = useState(false);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const exportBusyRef = useRef(false);
  const pendingFocusKeyRef = useRef<string | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Sync navContext triggers (citation deep link or import trigger)
  const lastNavSig = React.useRef('');
  useEffect(() => {
    const sig = `${navContext.sourceId || ''}:${navContext.pageNumber || ''}:${navContext.mode || ''}`;
    if (sig === lastNavSig.current) return;
    lastNavSig.current = sig;

    if (navContext.mode === 'import') {
      setOverlay('import');
      return;
    }
    if (navContext.sourceId) {
      const groups = groupSourcesFromSnapshot(snapshot);
      const matched = groups.find((g) => g.sourceIds.includes(navContext.sourceId!));
      const matchedPage = matched?.pages.find((p) => p.sourceId === navContext.sourceId)?.page;
      setReaderTarget({
        sourceId: navContext.sourceId,
        documentId: matched?.documentId,
        pageNumber: navContext.pageNumber ?? matchedPage ?? 1,
        title: matched?.title,
        format: matched?.format,
        course: matched?.courses[0] || focusCourse || undefined,
        totalPages: matched?.pageCount ?? 1,
      });
    }
  }, [navContext.sourceId, navContext.pageNumber, navContext.mode, snapshot, focusCourse]);

  const allGroups = useMemo(() => groupSourcesFromSnapshot(snapshot), [snapshot]);
  const materialFolders = useMemo(() => materialFoldersFromSnapshot(snapshot), [snapshot]);

  useEffect(() => {
    setSelectedKeys((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(allGroups.map((g) => g.key));
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (valid.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allGroups]);

  const courseScopedGroups = useMemo(() => {
    if (!courseFilterOn || !focusCourse) return allGroups;
    return allGroups.filter((g) => g.courses.includes(focusCourse));
  }, [allGroups, courseFilterOn, focusCourse]);

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of courseScopedGroups) {
      const f = g.folder || '';
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return counts;
  }, [courseScopedGroups]);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return courseScopedGroups.filter((g) => {
      if (folderFilter !== null) {
        if (folderFilter === '') {
          if (g.folder) return false;
        } else if (g.folder !== folderFilter) {
          return false;
        }
      }
      if (!q) return true;
      return (
        g.title.toLowerCase().includes(q) ||
        g.format.toLowerCase().includes(q) ||
        (g.folder ? g.folder.toLowerCase().includes(q) : false) ||
        g.courses.some((c) => c.toLowerCase().includes(q))
      );
    });
  }, [courseScopedGroups, folderFilter, searchQuery]);

  useEffect(() => {
    const targetKey = pendingFocusKeyRef.current;
    if (targetKey && filteredGroups.length > 0) {
      const nextIdx = filteredGroups.findIndex((g) => g.key === targetKey);
      if (nextIdx >= 0) {
        pendingFocusKeyRef.current = null;
        setSelectedIndex(nextIdx);
        return;
      }
    }
    if (selectedIndex >= filteredGroups.length) {
      setSelectedIndex(Math.max(0, filteredGroups.length - 1));
    }
  }, [filteredGroups, selectedIndex]);

  const shownPinnedKeys = useMemo(
    () => filteredGroups.filter((g) => g.pinned).map((g) => g.key),
    [filteredGroups],
  );

  const selectedItem: DocumentGroup | undefined = filteredGroups[selectedIndex];

  // Fetch small preview snippet for selected document (bounded 800 chars).
  useEffect(() => {
    const firstId = selectedItem?.sourceIds[0];
    if (!isActive || readerTarget || !firstId) {
      if (!firstId) setPreviewSnippet({ id: '', text: '' });
      return;
    }
    if (previewSnippet.id === firstId) return;
    let cancelled = false;
    void tryAction<{ text?: string }>(host, 'source.get', { id: firstId, offset: 0, limit: 800 }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.value) {
        setPreviewSnippet({ id: firstId, text: String(res.value.text || '') });
      } else {
        setPreviewSnippet({ id: firstId, text: '' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [host, isActive, readerTarget, selectedItem?.sourceIds, previewSnippet.id]);

  const openSelectedReader = useCallback((item: DocumentGroup) => {
    setReaderTarget({
      sourceId: item.sourceIds[0],
      documentId: item.documentId,
      pageNumber: item.pages[0]?.page ?? 1,
      title: item.title,
      format: item.format,
      course: item.courses[0] || focusCourse || undefined,
      totalPages: item.pageCount,
    });
  }, [focusCourse]);

  const handleOpenRereadSource = useCallback(
    (sourceKey: string, page?: number) => {
      setOverlay('none');
      const matched = allGroups.find(
        (g) => g.sourceIds.includes(sourceKey) || g.documentId === sourceKey || g.key === sourceKey,
      );
      const matchedSourceId = matched?.sourceIds.includes(sourceKey)
        ? sourceKey
        : page
          ? matched?.pages.find((p) => p.page === page)?.sourceId ?? matched?.sourceIds[0]
          : matched?.sourceIds[0];
      const matchedPage = matched?.pages.find((p) => p.sourceId === (matchedSourceId ?? sourceKey))?.page;
      setReaderTarget({
        sourceId: matchedSourceId ?? sourceKey,
        documentId: matched?.documentId,
        pageNumber: page ?? matchedPage ?? 1,
        title: matched?.title,
        format: matched?.format,
        course: matched?.courses[0] || focusCourse || undefined,
        totalPages: matched?.pageCount ?? 1,
      });
    },
    [allGroups, focusCourse],
  );

  const handleTogglePin = useCallback(
    async (item: DocumentGroup) => {
      if (busyRef.current || busy) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await tryAction(host, 'source.pin', { key: item.key, pinned: !item.pinned });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '置顶操作失败', 'Pin failed'), 'error');
          return;
        }
        pendingFocusKeyRef.current = item.key;
        await refresh();
        if (!mountedRef.current) return;
        notify(item.pinned ? t(lang, '已取消置顶', 'Unpinned') : t(lang, '已置顶', 'Pinned'), 'success');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, lang, notify, refresh],
  );

  const handleMovePin = useCallback(
    async (direction: 'up' | 'down') => {
      if (busyRef.current || busy) return;
      if (!selectedItem) {
        notify(t(lang, '当前列表暂无资料', 'No materials available to reorder'), 'info');
        return;
      }
      if (!selectedItem.pinned) {
        notify(
          t(lang, '请先按 [p] 置顶资料后再调整顺序', 'Press [p] to pin this material before reordering'),
          'info',
        );
        return;
      }
      const pinIdx = shownPinnedKeys.indexOf(selectedItem.key);
      if (pinIdx < 0) {
        notify(
          t(lang, '未能定位置顶顺序，请按 Ctrl+R 刷新后重试', 'Could not locate pinned order; press Ctrl+R to refresh'),
          'warning',
        );
        return;
      }
      if (direction === 'up' && pinIdx === 0) {
        notify(t(lang, '已经是第一个置顶资料', 'Already the first pinned material'), 'info');
        return;
      }
      if (direction === 'down' && pinIdx === shownPinnedKeys.length - 1) {
        notify(t(lang, '已经是最后一个置顶资料', 'Already the last pinned material'), 'info');
        return;
      }
      const req =
        direction === 'up'
          ? { key: selectedItem.key, before: shownPinnedKeys[pinIdx - 1] }
          : { key: selectedItem.key, after: shownPinnedKeys[pinIdx + 1] };

      busyRef.current = true;
      setBusy(true);
      try {
        const res = await tryAction<{ pins?: string[] }>(host, 'source.pin.move', req);
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '调整置顶顺序失败', 'Failed to reorder pinned material'), 'error');
          return;
        }
        pendingFocusKeyRef.current = selectedItem.key;
        await refresh();
        if (!mountedRef.current) return;
        notify(
          direction === 'up'
            ? t(lang, `已上移置顶「${selectedItem.title}」`, `Moved pinned "${selectedItem.title}" up`)
            : t(lang, `已下移置顶「${selectedItem.title}」`, `Moved pinned "${selectedItem.title}" down`),
          'success',
        );
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, lang, notify, refresh, selectedItem, shownPinnedKeys],
  );

  const [archivePendingGroups, setArchivePendingGroups] = useState<DocumentGroup[]>([]);

  const handleToggleArchive = useCallback(
    async (explicitGroups?: readonly DocumentGroup[]) => {
      if (busyRef.current || busy) return;
      const targetGroups =
        explicitGroups && explicitGroups.length > 0
          ? [...explicitGroups]
          : selectedKeys.size > 0
            ? allGroups.filter((g) => selectedKeys.has(g.key))
            : [];
      if (targetGroups.length === 0) return;
      const sourceIds = [...new Set(targetGroups.flatMap((g) => g.sourceIds))];
      if (sourceIds.length === 0) return;
      const nextArchived = !targetGroups.every((g) => g.archived);

      busyRef.current = true;
      setBusy(true);
      try {
        const result = await executeBatchSourceArchive(host, sourceIds, nextArchived, lang);
        if (!mountedRef.current) return;
        if (!result.ok) {
          if (result.partial) await refresh();
          if (!mountedRef.current) return;
          notify(result.error || t(lang, '归档操作失败', 'Archive failed'), result.partial ? 'warning' : 'error');
          return;
        }
        const batchCount = selectedKeys.size > 0 ? targetGroups.length : 0;
        if (batchCount > 0) setSelectedKeys(new Set());
        await refresh();
        if (!mountedRef.current) return;
        if (batchCount > 1) {
          notify(
            nextArchived
              ? t(lang, `已归档 ${batchCount} 份资料`, `Archived ${batchCount} materials`)
              : t(lang, `已恢复 ${batchCount} 份资料`, `Restored ${batchCount} materials`),
            'success',
          );
        } else {
          notify(nextArchived ? t(lang, '已归档资料', 'Archived') : t(lang, '已恢复资料', 'Restored'), 'success');
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [allGroups, busy, host, lang, notify, refresh, selectedKeys],
  );

  const handleEnrich = useCallback(async () => {
    if (busyRef.current || busy) return;
    const targetGroups =
      selectedKeys.size > 0
        ? allGroups.filter((g) => selectedKeys.has(g.key))
        : selectedItem
          ? [selectedItem]
          : [];
    if (targetGroups.length === 0) {
      notify(t(lang, '请先选择要补全元信息的资料', 'Select at least one material to enrich'), 'info');
      return;
    }
    const sourceIds = [...new Set(targetGroups.flatMap((g) => g.sourceIds))];
    if (sourceIds.length === 0) return;

    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<{
        updated?: number;
        changes?: Array<{ id: string; fields?: string[] }>;
        unresolved?: Array<{ id: string; fields?: string[] }>;
      }>(host, 'materials.enrich', { sourceIds });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '补全资料元信息失败', 'Failed to enrich metadata'), 'error');
        return;
      }
      const changedCount = Array.isArray(res.value.changes)
        ? res.value.changes.length
        : Number(res.value.updated ?? 0);
      const unresolvedCount = Array.isArray(res.value.unresolved) ? res.value.unresolved.length : 0;
      await refresh();
      if (!mountedRef.current) return;
      if (changedCount > 0) {
        notify(
          unresolvedCount > 0
            ? t(
                lang,
                `已补全 ${changedCount} 份元信息（${unresolvedCount} 份仍缺原始文件或导入时间）`,
                `Enriched ${changedCount} source(s) (${unresolvedCount} unresolved)`,
              )
            : t(
                lang,
                `已补全 ${changedCount} 份元信息`,
                `Enriched ${changedCount} source(s)`,
              ),
          'success',
        );
      } else {
        notify(
          unresolvedCount > 0
            ? t(
                lang,
                `元信息已检查（0 项变更，${unresolvedCount} 份缺原始文件或导入时间）`,
                `Metadata checked (0 changes, ${unresolvedCount} unresolved)`,
              )
            : t(lang, '所选资料元信息已完整', 'Selected metadata already complete'),
          'info',
        );
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [allGroups, busy, host, lang, notify, refresh, selectedItem, selectedKeys]);

  const handleRenameSubmit = useCallback(
    async (newTitle: string) => {
      if (!selectedItem || busy) return;
      const trimmed = newTitle.trim();
      if (!trimmed || trimmed === selectedItem.title) {
        setOverlay('none');
        return;
      }
      setBusy(true);
      const res = await tryAction(host, 'materials.document.rename', {
        ...(selectedItem.documentId ? { documentId: selectedItem.documentId } : {}),
        sourceId: selectedItem.sourceIds[0],
        title: trimmed,
        expectedTitle: selectedItem.title,
      });
      setBusy(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '重命名失败', 'Rename failed'), 'error');
        return;
      }
      setOverlay('none');
      await refresh();
      notify(t(lang, '已重命名资料', 'Material renamed'), 'success');
    },
    [busy, host, lang, notify, refresh, selectedItem],
  );

  const handleCourseSubmit = useCallback(
    async (rawCourses: string) => {
      if (!selectedItem || busy) return;
      const courses = rawCourses
        .split(/[,，]+/)
        .map((c) => c.trim())
        .filter(Boolean);
      setBusy(true);
      const assignments = selectedItem.sourceIds.map((id) => ({ id, courses }));
      const res = await tryAction(host, 'source.courses.set', { assignments });
      setBusy(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '分配课程失败', 'Assign course failed'), 'error');
        return;
      }
      setOverlay('none');
      await refresh();
      notify(
        courses.length > 0
          ? t(lang, `已归入课程: ${courses.join(', ')}`, `Assigned to: ${courses.join(', ')}`)
          : t(lang, '已清除课程归属', 'Cleared course assignment'),
        'success',
      );
    },
    [busy, host, lang, notify, refresh, selectedItem],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!selectedItem || busy) return;
    setBusy(true);
    let archivedIds: string[] = [];
    try {
      if (!selectedItem.archived) {
        const archRes = await executeBatchSourceArchive(host, selectedItem.sourceIds, true, lang);
        archivedIds = archRes.processedIds;
        if (!archRes.ok) {
          if (archivedIds.length > 0) {
            await executeBatchSourceArchive(host, archivedIds, false, lang);
          }
          notify(archRes.error || t(lang, '归档失败，无法删除', 'Archive failed before delete'), 'error');
          return;
        }
      }
      const delRes = await executeBatchSourceRemove(host, selectedItem.sourceIds, lang);
      if (!delRes.ok) {
        const errMsg =
          delRes.error || t(lang, '删除失败（可能被题组引用）', 'Delete failed (may be referenced by cards)');
        if (archivedIds.length > 0) {
          const rollbackRes = await executeBatchSourceArchive(host, archivedIds, false, lang);
          await refresh();
          if (rollbackRes.ok) {
            notify(
              t(
                lang,
                `删除失败（${errMsg}），已自动恢复未归档状态`,
                `Delete failed (${errMsg}); restored material from archive`,
              ),
              'error',
            );
          } else {
            notify(
              t(
                lang,
                `删除失败（${errMsg}），注意：资料已被归档，可在归档中恢复`,
                `Delete failed (${errMsg}); note: material was archived and can be restored`,
              ),
              'warning',
            );
          }
        } else {
          notify(errMsg, 'error');
        }
      } else {
        notify(t(lang, '已删除资料', 'Material deleted'), 'success');
        await refresh();
      }
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setBusy(false);
      setOverlay('none');
    }
  }, [busy, host, lang, notify, refresh, selectedItem]);

  const handleExportCatalog = useCallback(async () => {
    if (exportBusyRef.current) return;
    const isBatchSelection = selectedKeys.size > 0;
    const targetGroups = isBatchSelection
      ? allGroups.filter((g) => selectedKeys.has(g.key))
      : filteredGroups;
    if (targetGroups.length === 0) {
      notify(t(lang, '当前没有可导出的资料目录', 'No materials to export'), 'info');
      return;
    }
    exportBusyRef.current = true;
    try {
      const courseSlug = !isBatchSelection && courseFilterOn && focusCourse ? focusCourse : '';
      const folderSlug = !isBatchSelection && folderFilter !== null ? folderFilter || 'unfiled' : '';
      const exportLabel =
        [courseSlug, folderSlug].filter(Boolean).join('-') ||
        (isBatchSelection ? `selected-${targetGroups.length}` : undefined);
      const defaultPath = defaultBackupFilePath(host.getLibraryRoot(), 'studyhub-sources', '.md', exportLabel);
      const md = formatSourcesCatalogMarkdown({
        groups: targetGroups,
        course: !isBatchSelection && courseFilterOn && focusCourse ? focusCourse : undefined,
        folderLabel:
          !isBatchSelection && folderFilter !== null
            ? folderFilter || t(lang, '未归类', 'Unfiled')
            : undefined,
        lang,
      });
      const written = await atomicWriteExportText(defaultPath, md);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(
          lang,
          `已导出 ${targetGroups.length} 份资料目录 ${arrow} ${written.path}`,
          `Exported ${targetGroups.length} source(s) ${arrow} ${written.path}`,
        ),
        'success',
      );
    } catch (err) {
      if (mountedRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(t(lang, `导出资料目录失败: ${msg}`, `Export failed: ${msg}`), 'error');
      }
    } finally {
      exportBusyRef.current = false;
    }
  }, [
    allGroups,
    asciiMode,
    courseFilterOn,
    filteredGroups,
    focusCourse,
    folderFilter,
    host,
    lang,
    notify,
    selectedKeys,
  ]);

  const listActive = isActive && !readerTarget && overlay === 'none';

  useClaimKeys(['/', 'c', 'e', 'R', 'g', 'p', 'd', 'i', 'f', 'F', 'm', 'M', 'C', 'G', 'V', 'E', 'O', 'x', ' ', '[', ']'], listActive);
  useClaimKeys(['a'], listActive && (selectedKeys.size > 0 || Boolean(selectedItem)));
  useInputCapture(isActive && !readerTarget && (overlay === 'rename' || overlay === 'course' || overlay === 'search'));

  const hints: KeyHint[] = useMemo(
    () =>
      selectedKeys.size > 0
        ? [
            { key: 'Space', label: t(lang, '取消/勾选', 'Toggle') },
            { key: 'm', label: t(lang, `批量移夹(${selectedKeys.size})`, `Move(${selectedKeys.size})`) },
            { key: 'a', label: t(lang, '批量归档', 'Archive') },
            { key: 'E', label: t(lang, '补全元信息', 'Enrich') },
            { key: 'x', label: t(lang, '导出目录', 'Export MD') },
            { key: 'Esc', label: t(lang, '清空选择', 'Clear sel') },
          ]
        : [
            { key: 'Enter', label: t(lang, '阅读', 'Read') },
            { key: 'Space', label: t(lang, '多选', 'Select') },
            { key: 'i', label: t(lang, '导入', 'Import') },
            { key: 'M', label: 'MinerU' },
            { key: 'g', label: t(lang, '出题', 'Generate') },
            { key: 'G', label: t(lang, '归类', 'Organize') },
            { key: 'V', label: t(lang, '覆盖率', 'Coverage') },
            { key: 'R', label: t(lang, '重读清单', 'Reread') },
            { key: 'E', label: t(lang, '补全元信息', 'Enrich') },
            { key: 'O', label: t(lang, '原文件', 'Original') },
            { key: 'F', label: t(lang, '文件夹', 'Folders') },
            { key: 'm', label: t(lang, '移至夹', 'Move') },
            { key: 'C', label: t(lang, '伴学页', 'Companions') },
            { key: 'e', label: t(lang, '重命名', 'Rename') },
            { key: 'c', label: t(lang, '课程', 'Course') },
            { key: 'p', label: t(lang, '置顶', 'Pin') },
            { key: '[/]', label: t(lang, '置顶排序', 'Reorder pin') },
            { key: 'd', label: t(lang, '删除', 'Delete') },
            { key: '/', label: t(lang, '搜索', 'Filter') },
            { key: 'f', label: t(lang, '筛选课程', 'Course filter') },
            { key: 'x', label: t(lang, '导出目录', 'Export MD') },
          ],
    [lang, selectedKeys.size],
  );
  useFooterHints(hints, isActive && !readerTarget);

  useInput(
    (input, key) => {
      if (!listActive || busyRef.current || busy) return;
      if (key.escape && selectedKeys.size > 0) {
        setSelectedKeys(new Set());
        return true;
      }
      if (input === '[' || input === ']') {
        void handleMovePin(input === '[' ? 'up' : 'down');
      } else if (input === 'i') {
        setOverlay('import');
      } else if (input === 'M') {
        setOverlay('mineru');
      } else if (input === '/') {
        setOverlay('search');
      } else if (input === 'f') {
        setCourseFilterOn((v) => !v);
      } else if (input === 'F') {
        setOverlay('folders-filter');
      } else if (input === 'C') {
        setOverlay('companions');
      } else if (input === 'G') {
        setOverlay('organize');
      } else if (input === 'R') {
        setOverlay('reread');
      } else if (input === 'E') {
        void handleEnrich();
      } else if (input === 'x') {
        void handleExportCatalog();
      } else if (input === 'm' && selectedKeys.size > 0) {
        setOverlay('folders-assign-batch');
      } else if (input === 'a' && selectedKeys.size > 0) {
        const targets = allGroups.filter((g) => selectedKeys.has(g.key));
        if (targets.length > 0) {
          setArchivePendingGroups(targets);
          setOverlay('archive');
        }
      } else if (selectedItem) {
        if (input === ' ') {
          setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(selectedItem.key)) next.delete(selectedItem.key);
            else next.add(selectedItem.key);
            return next;
          });
        } else if (input === 'V') {
          setOverlay('coverage');
        } else if (input === 'O') {
          setOverlay('original');
        } else if (input === 'm') {
          setOverlay('folders-assign');
        } else if (input === 'g') {
          navigate('generate', {
            sourceIds: selectedItem.sourceIds,
            ...(selectedItem.courses[0] ? { course: selectedItem.courses[0] } : focusCourse ? { course: focusCourse } : {}),
          });
        } else if (input === 'e') {
          setRenameValue(selectedItem.title);
          setOverlay('rename');
        } else if (input === 'c') {
          setCourseValue(selectedItem.courses.join(', '));
          setOverlay('course');
        } else if (input === 'p') {
          void handleTogglePin(selectedItem);
        } else if (input === 'a') {
          setArchivePendingGroups([selectedItem]);
          setOverlay('archive');
        } else if (input === 'd') {
          setOverlay('delete');
        }
      }
    },
    { isActive: listActive },
  );

  // If DocumentReader is open, delegate full view area to it.
  if (readerTarget) {
    return (
      <Suspense
        fallback={
          <Box paddingX={1} paddingY={1}>
            <Spinner
              label={t(
                lang,
                asciiMode ? '正在打开阅读器...' : '正在打开阅读器…',
                asciiMode ? 'Opening reader...' : 'Opening reader…',
              )}
              active={isActive}
            />
          </Box>
        }
      >
        <DocumentReader
          host={host}
          sourceId={readerTarget.sourceId}
          documentId={readerTarget.documentId}
          initialPage={readerTarget.pageNumber}
          initialTitle={readerTarget.title}
          initialFormat={readerTarget.format}
          initialCourse={readerTarget.course}
          totalPagesHint={readerTarget.totalPages}
          width={width}
          height={height}
          isActive={isActive}
          onClose={() => setReaderTarget(null)}
        />
      </Suspense>
    );
  }

  const narrowBar = width < 82;
  const topBarH = overlay === 'search' || searchQuery ? 2 : 1;
  const splitH = Math.max(4, height - topBarH);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Top Filter Bar */}
      <Box height={topBarH} width={width} paddingX={1} flexDirection="column">
        <Box flexDirection="row" alignItems="center" width={Math.max(10, width - 2)}>
          <Box flexShrink={0}>
            <Text bold color={theme.primary} wrap={asciiMode ? undefined : 'truncate-end'}>
              {narrowBar ? t(lang, '资料', 'Sources') : t(lang, '学习资料库', 'Study Materials')}
            </Text>
          </Box>
          <Text> </Text>
          <Box flexShrink={0}>
            <Badge label={filteredGroups.length} tone="info" variant="soft" />
          </Box>
          <Text> </Text>
          <Box flexShrink={0}>
            {focusCourse ? (
              <Badge
                label={
                  courseFilterOn
                    ? (narrowBar ? focusCourse : `${t(lang, '当前课程', 'Course')}: ${focusCourse}`)
                    : t(lang, '全部课程', 'All Courses')
                }
                tone={courseFilterOn ? 'accent' : 'muted'}
                variant="outline"
              />
            ) : (
              <Badge label={t(lang, '全部课程', 'All Courses')} tone="muted" variant="outline" />
            )}
          </Box>
          {selectedKeys.size > 0 ? (
            <>
              <Text> </Text>
              <Box flexShrink={0}>
                <Badge
                  label={t(lang, `已选 ${selectedKeys.size} 份`, `${selectedKeys.size} selected`)}
                  tone="success"
                  variant="soft"
                />
              </Box>
            </>
          ) : null}
          <Box flexGrow={1} />
          {!narrowBar ? (
            <Box flexShrink={0}>
              <Text color={theme.dim} wrap={asciiMode ? undefined : 'truncate-end'}>
                {selectedKeys.size > 0
                  ? t(lang, '[m] 移至夹  [a] 归档  [E] 补全元信息  [Esc] 清空', '[m] Move  [a] Archive  [E] Enrich  [Esc] Clear')
                  : t(lang, '[i] 导入  [f] 切换课程过滤  [/] 搜索', '[i] Import  [f] Course Filter  [/] Filter')}
              </Text>
            </Box>
          ) : null}
        </Box>

        {overlay === 'search' ? (
          <Box flexDirection="row" alignItems="center">
            <Text color={theme.primary}>{t(lang, '筛选资料: ', 'Filter: ')}</Text>
            <TextInput
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={() => setOverlay('none')}
              onCancel={() => {
                setSearchQuery('');
                setOverlay('none');
              }}
              placeholder={t(
                lang,
                asciiMode ? '输入标题、格式或课程名...' : '输入标题、格式或课程名…',
                asciiMode ? 'Title, format or course...' : 'Title, format or course…',
              )}
              width={Math.max(20, width - 16)}
              isActive={isActive && overlay === 'search'}
            />
          </Box>
        ) : searchQuery ? (
          <Box flexDirection="row">
            <Text color={theme.muted}>{`${t(lang, '筛选', 'Filter')}: "${searchQuery}"`}</Text>
            <Text color={theme.dim}>{t(lang, '  (/ 修改)', '  (/ edit)')}</Text>
          </Box>
        ) : null}
      </Box>

      {/* Main Master-Detail SplitPane */}
      <Box height={splitH} width={width}>
        <SplitPane
          width={width}
          height={splitH}
          leftWidth={0.46}
          leftLabel={t(lang, '资料列表', 'Materials')}
          rightLabel={t(lang, '详情预览', 'Preview')}
          left={({ width: lw, height: lh }) => (
            <Panel
              title={t(lang, '资料列表', 'Materials')}
              badge={filteredGroups.length}
              width={lw}
              height={lh}
              focused={listActive}
            >
              {filteredGroups.length === 0 ? (
                <EmptyState
                  title={t(lang, '暂无匹配资料', 'No matching materials')}
                  hint={t(lang, '按 [i] 导入 PDF / PPTX / DOCX / Markdown / 文本', 'Press [i] to import files or paste text')}
                  width={Math.max(12, lw - 4)}
                  height={Math.max(4, lh - 2)}
                />
              ) : (
                <VirtualList
                  items={filteredGroups}
                  height={Math.max(1, lh - 2)}
                  width={Math.max(12, lw - 4)}
                  selectedIndex={selectedIndex}
                  onChange={(idx) => setSelectedIndex(idx)}
                  onSelect={(item) => openSelectedReader(item)}
                  isActive={listActive}
                  keyExtractor={(item) => item.key}
                  renderItem={(item, ctx) => {
                    const fmt = formatLabel(item.format);
                    const isChecked = selectedKeys.has(item.key);
                    const checkMark =
                      selectedKeys.size > 0 || isChecked
                        ? isChecked
                          ? asciiMode
                            ? '[x] '
                            : '[✓] '
                          : '[ ] '
                        : '';
                    const pinMark = item.pinned ? (asciiMode ? '* ' : '★ ') : '';
                    const archMark = item.archived ? t(lang, '[归档] ', '[Arch] ') : '';
                    const meta = `${item.pageCount}p ${asciiMode ? '-' : '·'} ${item.cardCount}${t(lang, '题', 'q')}`;
                    const fixedW =
                      2 +
                      displayWidth(checkMark) +
                      displayWidth(pinMark) +
                      displayWidth(fmt) +
                      3 +
                      (item.archived ? displayWidth(archMark) : 0) +
                      displayWidth(meta) +
                      1;
                    const titleMax = Math.max(6, ctx.width - fixedW);
                    return (
                      <Box flexDirection="row" width={ctx.width} overflow="hidden">
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}</Text>
                        {checkMark ? (
                          <Text color={isChecked ? theme.success : theme.muted} bold={isChecked}>
                            {checkMark}
                          </Text>
                        ) : null}
                        {item.pinned ? <Text color={theme.warning}>{pinMark}</Text> : null}
                        <Text color={theme.accent} bold>{`[${fmt}] `}</Text>
                        {item.archived ? <Text color={theme.dim}>{archMark}</Text> : null}
                        <Text color={ctx.selected ? theme.text : theme.text} bold={ctx.selected}>
                          {truncateDisplay(item.title, titleMax, asciiMode ? '...' : '…')}
                        </Text>
                        <Box flexGrow={1} />
                        <Text color={theme.dim}>{meta}</Text>
                      </Box>
                    );
                  }}
                />
              )}
            </Panel>
          )}
          right={({ width: rw, height: rh }) => (
            <Panel
              title={selectedItem ? selectedItem.title : t(lang, '资料详情', 'Details')}
              subtitle={selectedItem ? formatLabel(selectedItem.format) : undefined}
              width={rw}
              height={rh}
            >
              {!selectedItem ? (
                <EmptyState
                  title={t(lang, '选择一份资料查看详情', 'Select a material')}
                  width={Math.max(12, rw - 4)}
                  height={Math.max(4, rh - 2)}
                />
              ) : (
                <Box flexDirection="column" height={Math.max(2, rh - 2)} width={Math.max(12, rw - 4)}>
                  <Box flexDirection="row" flexWrap="wrap" marginBottom={1}>
                    <Badge label={formatLabel(selectedItem.format)} tone={formatTone(selectedItem.format)} />
                    <Text> </Text>
                    <Badge label={`${selectedItem.pageCount} ${t(lang, '页', 'pages')}`} tone="info" variant="soft" />
                    <Text> </Text>
                    <Badge label={`${selectedItem.cardCount} ${t(lang, '关联题', 'cards')}`} tone="success" variant="soft" />
                    {selectedItem.pinned ? (
                      <>
                        <Text> </Text>
                        <Badge label={`${asciiMode ? '*' : '★'} ${t(lang, '已置顶', 'Pinned')}`} tone="warning" variant="soft" />
                      </>
                    ) : null}
                    {selectedItem.archived ? (
                      <>
                        <Text> </Text>
                        <Badge label={t(lang, '已归档', 'Archived')} tone="muted" variant="outline" />
                      </>
                    ) : null}
                  </Box>

                  <Text color={theme.muted}>
                    {t(lang, '所属课程: ', 'Courses: ')}
                    <Text color={theme.text}>
                      {selectedItem.courses.length > 0 ? selectedItem.courses.join(', ') : t(lang, '未分配', 'Unassigned')}
                    </Text>
                  </Text>
                  <Text color={theme.muted}>
                    {t(lang, '字数统计: ', 'Characters: ')}
                    <Text color={theme.text}>{selectedItem.chars.toLocaleString()}</Text>
                  </Text>

                  <Box marginTop={1} marginBottom={0}>
                    <Text color={theme.primary} bold>
                      {t(lang, '内容摘录 (按 Enter 打开全文分页阅读):', 'Excerpt (Press Enter to open Reader):')}
                    </Text>
                  </Box>
                  <ScrollView
                    content={
                      previewSnippet.id === selectedItem.sourceIds[0] && previewSnippet.text
                        ? previewSnippet.text
                        : t(lang, '（暂无文本摘录）', '(No excerpt available)')
                    }
                    width={Math.max(12, rw - 4)}
                    height={Math.max(2, rh - 9)}
                    isActive={false}
                  />
                </Box>
              )}
            </Panel>
          )}
        />
      </Box>

      {/* Modals */}
      <Suspense fallback={null}>
        {overlay === 'import' ? (
          <ImportModal
            host={host}
            defaultCourse={focusCourse}
            isActive={isActive}
            onClose={() => setOverlay('none')}
            onImported={refresh}
          />
        ) : null}

        {overlay === 'mineru' ? (
          <MinerUModal
            host={host}
            defaultCourse={focusCourse}
            isActive={isActive}
            onQueued={refresh}
            onOpenTasks={(jobId) => {
              setOverlay('none');
              navigate('tasks', jobId ? { jobId } : {});
            }}
            onClose={() => setOverlay('none')}
          />
        ) : null}

      {overlay === 'rename' && selectedItem ? (
        <Modal
          title={t(lang, '重命名资料', 'Rename Material')}
          width={62}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>{t(lang, '新标题 (不影响原文与引用):', 'New title (preserves text & citations):')}</Text>
          <Box marginTop={1}>
            <TextInput
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={(val) => void handleRenameSubmit(val)}
              onCancel={() => setOverlay('none')}
              width={modalContentWidth(62) - 4}
              isActive={isActive}
              prompt={asciiMode ? '>' : '›'}
            />
          </Box>
        </Modal>
      ) : null}

      {overlay === 'course' && selectedItem ? (
        <Modal
          title={t(lang, '分配所属课程', 'Assign Course')}
          subtitle={selectedItem.title}
          width={64}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>
            {t(lang, '输入课程名称（多个用逗号分隔，留空则取消归属）:', 'Enter course name(s), comma-separated (blank to unassign):')}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={courseValue}
              onChange={setCourseValue}
              onSubmit={(val) => void handleCourseSubmit(val)}
              onCancel={() => setOverlay('none')}
              placeholder={t(lang, '例如：操作系统, 计算机网络', 'e.g. Operating Systems')}
              width={modalContentWidth(64) - 4}
              isActive={isActive}
              prompt={asciiMode ? '>' : '›'}
            />
          </Box>
        </Modal>
      ) : null}

      {overlay === 'archive' && archivePendingGroups.length > 0 ? (() => {
        const nextArchived = !archivePendingGroups.every((g) => g.archived);
        const count = archivePendingGroups.length;
        const firstTitle = archivePendingGroups[0].title;
        return (
          <ConfirmDialog
            title={
              nextArchived
                ? count > 1
                  ? t(lang, `归档 ${count} 份资料`, `Archive ${count} Materials`)
                  : t(lang, '归档资料', 'Archive Material')
                : count > 1
                  ? t(lang, `恢复 ${count} 份资料`, `Restore ${count} Materials`)
                  : t(lang, '恢复已归档资料', 'Restore Archived Material')
            }
            message={
              nextArchived
                ? count > 1
                  ? t(
                      lang,
                      `确定归档已选的 ${count} 份资料吗？归档将隐藏这些资料，并可能中断关联题组正在进行的练习。`,
                      `Archive ${count} selected materials? Archiving hides them and may interrupt active practice sessions using them.`,
                    )
                  : t(
                      lang,
                      `确定归档「${firstTitle}」吗？归档将隐藏该资料，并可能中断关联题组正在进行的练习。`,
                      `Archive "${firstTitle}"? Archiving hides it and may interrupt active practice sessions using it.`,
                    )
                : count > 1
                  ? t(lang, `确定从归档中恢复已选的 ${count} 份资料吗？`, `Restore ${count} selected materials from archive?`)
                  : t(lang, `确定从归档中恢复「${firstTitle}」吗？`, `Restore "${firstTitle}" from archive?`)
            }
            confirmLabel={nextArchived ? t(lang, '确认归档', 'Archive') : t(lang, '确认恢复', 'Restore')}
            cancelLabel={t(lang, '取消', 'Cancel')}
            danger={nextArchived}
            isActive={isActive}
            onConfirm={() => {
              const groups = archivePendingGroups;
              setOverlay('none');
              setArchivePendingGroups([]);
              void handleToggleArchive(groups);
            }}
            onCancel={() => {
              setOverlay('none');
              setArchivePendingGroups([]);
            }}
          />
        );
      })() : null}

      {overlay === 'delete' && selectedItem ? (
        <ConfirmDialog
          title={t(lang, '永久删除资料', 'Delete Material')}
          message={t(
            lang,
            `确定要删除「${selectedItem.title}」（共 ${selectedItem.pageCount} 页）吗？若被题组引用将拒绝删除。`,
            `Permanently delete "${selectedItem.title}" (${selectedItem.pageCount} pages)? Referenced sources are protected.`,
          )}
          confirmLabel={t(lang, '确认删除', 'Delete')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setOverlay('none')}
        />
      ) : null}

      {overlay === 'folders-filter' || overlay === 'folders-assign' ? (
        <FolderModal
          host={host}
          mode={overlay === 'folders-assign' ? 'assign' : 'filter'}
          folders={materialFolders.folders}
          folderCounts={folderCounts}
          totalCount={courseScopedGroups.length}
          activeFolder={folderFilter}
          selectedItem={selectedItem}
          isActive={isActive}
          onSelectFilter={(nextFolder) => {
            setFolderFilter(nextFolder);
            setSelectedIndex(0);
          }}
          onRefresh={refresh}
          onClose={() => setOverlay('none')}
        />
      ) : null}

      {overlay === 'folders-assign-batch' && selectedKeys.size > 0 ? (
        <BatchFolderModal
          host={host}
          selectedKeys={[...selectedKeys]}
          folders={materialFolders.folders}
          folderCounts={folderCounts}
          isActive={isActive}
          onRefresh={refresh}
          onAssigned={() => setSelectedKeys(new Set())}
          onClose={() => setOverlay('none')}
        />
      ) : null}

      {overlay === 'companions' ? (
        <CompanionsModal
          host={host}
          defaultCourse={focusCourse}
          isActive={isActive}
          onChanged={refresh}
          onClose={() => setOverlay('none')}
        />
      ) : null}

      {overlay === 'organize' ? (
        <OrganizeSourcesModal
          host={host}
          groups={filteredGroups}
          allGroups={allGroups}
          isActive={isActive}
          onSaved={refresh}
          onClose={() => setOverlay('none')}
        />
      ) : null}

        {overlay === 'coverage' && selectedItem ? (
          <SourceCoverageModal
            host={host}
            item={selectedItem}
            defaultCourse={focusCourse}
            isActive={isActive}
            onGenerate={(sourceIds, course) => {
              navigate('generate', {
                sourceIds,
                ...(course ? { course } : {}),
              });
            }}
            onClose={() => setOverlay('none')}
          />
        ) : null}

        {overlay === 'reread' ? (
          <RereadQueueModal
            host={host}
            course={courseFilterOn ? focusCourse : undefined}
            isActive={isActive}
            onOpenSource={handleOpenRereadSource}
            onClose={() => setOverlay('none')}
          />
        ) : null}

        {overlay === 'original' && selectedItem ? (
          <OriginalFileModal
            host={host}
            item={selectedItem}
            isActive={isActive}
            onRefresh={refresh}
            onClose={() => setOverlay('none')}
          />
        ) : null}
      </Suspense>
    </Box>
  );
});
