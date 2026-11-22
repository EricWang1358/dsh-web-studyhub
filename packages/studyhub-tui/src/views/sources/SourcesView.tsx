import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  Modal,
  Panel,
  ScrollView,
  SplitPane,
  TextInput,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useFooterHints,
  useInputCapture,
  useTheme,
} from '../../components/index.js';
import { currentCourse } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { truncateDisplay } from '../../render/index.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import {
  type DocumentGroup,
  formatLabel,
  formatTone,
  groupSourcesFromSnapshot,
  materialFoldersFromSnapshot,
} from './source-helpers.js';
import { ImportModal } from './ImportModal.js';
import { DocumentReader } from './DocumentReader.js';
import { FolderModal } from './FolderModal.js';
import { CompanionsModal } from './CompanionsModal.js';
import { OrganizeSourcesModal } from './OrganizeSourcesModal.js';
import { SourceCoverageModal } from './SourceCoverageModal.js';

type ActiveOverlay =
  | 'none'
  | 'import'
  | 'rename'
  | 'course'
  | 'delete'
  | 'search'
  | 'folders-filter'
  | 'folders-assign'
  | 'companions'
  | 'organize'
  | 'coverage';

export const SourcesView: React.FC<ViewProps> = memo(function SourcesView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
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
    if (selectedIndex >= filteredGroups.length) {
      setSelectedIndex(Math.max(0, filteredGroups.length - 1));
    }
  }, [filteredGroups.length, selectedIndex]);

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

  const handleTogglePin = useCallback(
    async (item: DocumentGroup) => {
      if (busy) return;
      setBusy(true);
      const res = await tryAction(host, 'source.pin', { key: item.key, pinned: !item.pinned });
      setBusy(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '置顶操作失败', 'Pin failed'), 'error');
        return;
      }
      await refresh();
      notify(item.pinned ? t(lang, '已取消置顶', 'Unpinned') : t(lang, '已置顶', 'Pinned'), 'success');
    },
    [busy, host, lang, notify, refresh],
  );

  const handleToggleArchive = useCallback(
    async (item: DocumentGroup) => {
      if (busy) return;
      setBusy(true);
      const res = await tryAction(host, 'source.archive', {
        sourceIds: item.sourceIds,
        archived: !item.archived,
      });
      setBusy(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '归档操作失败', 'Archive failed'), 'error');
        return;
      }
      await refresh();
      notify(item.archived ? t(lang, '已恢复资料', 'Restored') : t(lang, '已归档资料', 'Archived'), 'success');
    },
    [busy, host, lang, notify, refresh],
  );

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
    try {
      if (!selectedItem.archived) {
        const archRes = await tryAction(host, 'source.archive', {
          sourceIds: selectedItem.sourceIds,
          archived: true,
        });
        if (!archRes.ok) {
          notify(archRes.error?.message || t(lang, '归档失败，无法删除', 'Archive failed before delete'), 'error');
          setBusy(false);
          return;
        }
      }
      const delRes = await tryAction(host, 'source.remove', {
        sourceIds: selectedItem.sourceIds,
        confirm: true,
      });
      if (!delRes.ok) {
        notify(delRes.error?.message || t(lang, '删除失败（可能被题组引用）', 'Delete failed (may be referenced by cards)'), 'error');
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

  const listActive = isActive && !readerTarget && overlay === 'none';

  useClaimKeys(['/', 'c', 'r', 'g', 'p', 'd', 'i', 'f', 'a', 'F', 'm', 'C', 'G', 'V'], listActive);
  useInputCapture(isActive && !readerTarget && (overlay === 'rename' || overlay === 'course' || overlay === 'search'));

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'Enter', label: t(lang, '阅读', 'Read') },
      { key: 'i', label: t(lang, '导入', 'Import') },
      { key: 'g', label: t(lang, '出题', 'Generate') },
      { key: 'G', label: t(lang, '归类', 'Organize') },
      { key: 'V', label: t(lang, '覆盖率', 'Coverage') },
      { key: 'F', label: t(lang, '文件夹', 'Folders') },
      { key: 'm', label: t(lang, '移至夹', 'Move') },
      { key: 'C', label: t(lang, '伴学页', 'Companions') },
      { key: 'r', label: t(lang, '重命名', 'Rename') },
      { key: 'c', label: t(lang, '课程', 'Course') },
      { key: 'p', label: t(lang, '置顶', 'Pin') },
      { key: 'd', label: t(lang, '删除', 'Delete') },
      { key: '/', label: t(lang, '搜索', 'Filter') },
      { key: 'f', label: t(lang, '筛选课程', 'Course filter') },
    ],
    [lang],
  );
  useFooterHints(hints, isActive && !readerTarget);

  useInput(
    (input) => {
      if (!listActive) return;
      if (input === 'i') {
        setOverlay('import');
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
      } else if (selectedItem) {
        if (input === 'V') {
          setOverlay('coverage');
        } else if (input === 'm') {
          setOverlay('folders-assign');
        } else if (input === 'g') {
          navigate('generate', {
            sourceIds: selectedItem.sourceIds,
            ...(selectedItem.courses[0] ? { course: selectedItem.courses[0] } : focusCourse ? { course: focusCourse } : {}),
          });
        } else if (input === 'r') {
          setRenameValue(selectedItem.title);
          setOverlay('rename');
        } else if (input === 'c') {
          setCourseValue(selectedItem.courses.join(', '));
          setOverlay('course');
        } else if (input === 'p') {
          void handleTogglePin(selectedItem);
        } else if (input === 'a') {
          void handleToggleArchive(selectedItem);
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
            <Text bold color={theme.primary} wrap="truncate-end">
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
          <Box flexGrow={1} />
          {!narrowBar ? (
            <Box flexShrink={0}>
              <Text color={theme.dim} wrap="truncate-end">
                {t(lang, '[i] 导入  [f] 切换课程过滤  [/] 搜索', '[i] Import  [f] Course Filter  [/] Filter')}
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
              placeholder={t(lang, '输入标题、格式或课程名…', 'Title, format or course…')}
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
                    const pinMark = item.pinned ? '★ ' : '';
                    const archMark = item.archived ? '[归档] ' : '';
                    const meta = `${item.pageCount}p · ${item.cardCount}题`;
                    const titleMax = Math.max(8, ctx.width - fmt.length - meta.length - (item.pinned ? 2 : 0) - (item.archived ? 5 : 0) - 5);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{ctx.selected ? '▸ ' : '  '}</Text>
                        {item.pinned ? <Text color={theme.warning}>{pinMark}</Text> : null}
                        <Text color={theme.accent} bold>{`[${fmt}] `}</Text>
                        {item.archived ? <Text color={theme.dim}>{archMark}</Text> : null}
                        <Text color={ctx.selected ? theme.text : theme.text} bold={ctx.selected}>
                          {truncateDisplay(item.title, titleMax)}
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
                        <Badge label={`★ ${t(lang, '已置顶', 'Pinned')}`} tone="warning" variant="soft" />
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
      {overlay === 'import' ? (
        <ImportModal
          host={host}
          defaultCourse={focusCourse}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          onImported={refresh}
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
              prompt="›"
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
              prompt="›"
            />
          </Box>
        </Modal>
      ) : null}

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
    </Box>
  );
});
