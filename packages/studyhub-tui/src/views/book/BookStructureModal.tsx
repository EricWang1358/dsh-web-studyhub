import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import type { FlatTocItem } from './types.js';

export interface UnplacedSectionItem {
  id: string;
  title: string;
  preview?: string;
  chars?: number;
}

export interface LeafPointItem {
  hid: string;
  title: string;
  depth?: number;
  number?: string;
}

export interface BookStructureModalProps {
  host: HostClient;
  course: string | null;
  mode?: 'rename' | 'place';
  selectedItem?: FlatTocItem | null;
  unplacedSections?: readonly UnplacedSectionItem[];
  leafPoints?: readonly LeafPointItem[];
  structureVersion: number;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onRenamed?: (nextVersion?: number, hid?: string) => void;
  onPlaced?: (nextVersion?: number, toHid?: string) => void;
  onConflict?: () => void;
}

interface RenameStructureResponse {
  course?: string | null;
  write?: string;
  hid?: string;
  title?: string;
  structureVersion?: number;
}

interface PlaceStructureResponse {
  course?: string | null;
  write?: string;
  hid?: string;
  section?: string;
  title?: string;
  structureVersion?: number;
}

function isStructureConflict(code: string | undefined, message: string | undefined): boolean {
  if (code === 'course-book-conflict') return true;
  if (!message) return false;
  return /conflict|structure changed|改过/i.test(message);
}

export const BookStructureModal = memo(function BookStructureModal({
  host,
  course,
  mode = 'rename',
  selectedItem,
  unplacedSections = [],
  leafPoints = [],
  structureVersion,
  isActive,
  width,
  height,
  onClose,
  onRenamed,
  onPlaced,
  onConflict,
}: BookStructureModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);

  const [title, setTitle] = useState(() => selectedItem?.title ?? '');
  const [activeList, setActiveList] = useState<'sections' | 'targets'>('sections');
  const [sectionIdx, setSectionIdx] = useState(0);
  const [targetIdx, setTargetIdx] = useState(() => {
    if (selectedItem?.leaf && leafPoints.length > 0) {
      const idx = leafPoints.findIndex((p) => p.hid === selectedItem.hid);
      if (idx >= 0) return idx;
    }
    return 0;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const lastHidRef = useRef<string | null>(selectedItem?.hid ?? null);
  const lastModeRef = useRef<'rename' | 'place'>(mode);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const nextHid = selectedItem?.hid ?? null;
    if (nextHid !== lastHidRef.current) {
      lastHidRef.current = nextHid;
      setTitle(selectedItem?.title ?? '');
      setError(null);
    }
  }, [selectedItem?.hid, selectedItem?.title]);

  useEffect(() => {
    if (lastModeRef.current !== mode) {
      lastModeRef.current = mode;
      setError(null);
      setActiveList('sections');
      setSectionIdx(0);
      if (selectedItem?.leaf && leafPoints.length > 0) {
        const idx = leafPoints.findIndex((p) => p.hid === selectedItem.hid);
        setTargetIdx(idx >= 0 ? idx : 0);
      } else {
        setTargetIdx(0);
      }
    }
  }, [leafPoints, mode, selectedItem?.hid, selectedItem?.leaf]);

  const clampedSectionIdx = Math.max(0, Math.min(sectionIdx, Math.max(0, unplacedSections.length - 1)));
  const clampedTargetIdx = Math.max(0, Math.min(targetIdx, Math.max(0, leafPoints.length - 1)));
  const selectedSection = unplacedSections[clampedSectionIdx];
  const selectedTarget = leafPoints[clampedTargetIdx];

  const handleRenameSubmit = useCallback(
    async (rawTitle: string) => {
      if (busyRef.current || !selectedItem) return;
      const trimmed = rawTitle.replace(/\s+/g, ' ').trim();
      if (!trimmed) {
        setError(t(lang, '节点标题不能为空', 'Node title cannot be empty'));
        return;
      }
      if (trimmed === selectedItem.title) {
        notify(t(lang, '标题未变化', 'Title unchanged'), 'info');
        onClose();
        return;
      }

      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await tryAction<RenameStructureResponse>(host, 'course.book.rename', {
          ...(course ? { course } : {}),
          hid: selectedItem.hid,
          title: trimmed,
          version: structureVersion,
        });
        if (!mountedRef.current) return;

        if (!res.ok || !res.value) {
          const msg = res.error?.message || t(lang, '重命名失败', 'Rename failed');
          if (isStructureConflict(res.error?.code, res.error?.message)) {
            const conflictMsg = t(
              lang,
              '目录版本已变化，已自动刷新版本号；请再按 Enter 保存新标题。',
              'Book structure changed; refreshed version — press Enter again to save.',
            );
            setError(conflictMsg);
            notify(conflictMsg, 'warning');
            onConflict?.();
          } else {
            setError(msg);
            notify(msg, 'error');
          }
          return;
        }

        const nextTitle = res.value.title ?? trimmed;
        notify(t(lang, `已重命名为「${nextTitle}」`, `Renamed to "${nextTitle}"`), 'success');
        onRenamed?.(res.value.structureVersion, selectedItem.hid);
        onClose();
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        notify(msg, 'error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [course, host, lang, notify, onClose, onConflict, onRenamed, selectedItem, structureVersion],
  );

  const handlePlaceSubmit = useCallback(async () => {
    if (busyRef.current || mode !== 'place') return;
    if (!selectedSection || !selectedTarget) return;

    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await tryAction<PlaceStructureResponse>(host, 'course.book.place', {
        ...(course ? { course } : {}),
        section: selectedSection.id,
        toHid: selectedTarget.hid,
        version: structureVersion,
      });
      if (!mountedRef.current) return;

      if (!res.ok || !res.value) {
        const code = res.error?.code;
        const msg = res.error?.message || t(lang, '归位段落失败', 'Failed to place section');
        if (isStructureConflict(code, res.error?.message) || code === 'course-book-section-missing') {
          const conflictMsg =
            code === 'course-book-section-missing'
              ? t(
                  lang,
                  '未归位段落内容已变更，已刷新最新目录；请确认后重试。',
                  'Unplaced section changed; refreshed book — please review and retry.',
                )
              : t(
                  lang,
                  '目录版本已变化，已自动刷新版本号；请再按 Enter 归位。',
                  'Book structure changed; refreshed version — press Enter again to place.',
                );
          setError(conflictMsg);
          notify(conflictMsg, 'warning');
          onConflict?.();
        } else {
          setError(msg);
          notify(msg, 'error');
        }
        return;
      }

      const secLabel = selectedSection.title || t(lang, '未标题段落', 'Untitled section');
      notify(
        t(lang, `已将「${secLabel}」归位至「${selectedTarget.title}」`, `Placed "${secLabel}" into "${selectedTarget.title}"`),
        'success',
      );
      onPlaced?.(res.value.structureVersion, selectedTarget.hid);
      onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [course, host, lang, mode, notify, onClose, onConflict, onPlaced, selectedSection, selectedTarget, structureVersion]);

  useInput(
    (input, key) => {
      if (key.tab || key.leftArrow || key.rightArrow || input === 'h' || input === 'l') {
        if (key.leftArrow || input === 'h') setActiveList('sections');
        else if (key.rightArrow || input === 'l') setActiveList('targets');
        else setActiveList((prev) => (prev === 'sections' ? 'targets' : 'sections'));
      }
    },
    { isActive: isActive && mode === 'place' && !busy && unplacedSections.length > 0 && leafPoints.length > 0 },
  );

  const isPlace = mode === 'place';
  const frameW = isPlace ? Math.min(82, Math.max(44, width - 4)) : Math.min(68, Math.max(36, width - 4));
  const innerW = modalContentWidth(frameW);
  const inputW = Math.max(10, innerW - 4);
  const ell = asciiMode ? '...' : '…';

  const hints = useMemo<KeyHint[]>(() => {
    if (isPlace) {
      if (unplacedSections.length === 0 || leafPoints.length === 0) {
        return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
      }
      return [
        { key: 'Tab', label: t(lang, '切换列表', 'Switch') },
        { key: 'j/k', label: t(lang, '选择', 'Select') },
        { key: 'Enter', label: t(lang, '归位', 'Place') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    return selectedItem
      ? [
          { key: 'Enter', label: t(lang, '保存', 'Save') },
          { key: 'Esc', label: t(lang, '取消', 'Cancel') },
        ]
      : [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
  }, [isPlace, lang, leafPoints.length, selectedItem, unplacedSections.length]);

  const nodeKind = selectedItem
    ? selectedItem.leaf
      ? t(lang, '知识点', 'Point')
      : t(lang, '章节', 'Section')
    : '';

  const availPlaceH = Math.max(8, Math.min(22, height - 9));
  const secListH = Math.max(2, Math.min(Math.max(2, unplacedSections.length), Math.floor((availPlaceH - 5) / 2)));
  const targetListH = Math.max(2, Math.min(Math.max(2, leafPoints.length), availPlaceH - 5 - secListH));

  return (
    <Modal
      title={isPlace ? t(lang, '归位未归位段落', 'Place Unplaced Section') : t(lang, '重命名目录节点', 'Rename Book Node')}
      subtitle={
        isPlace
          ? selectedSection
            ? truncateDisplay(
                selectedSection.title || t(lang, '未标题段落', 'Untitled section'),
                Math.max(10, Math.floor(innerW * 0.4)),
                ell,
              )
            : undefined
          : selectedItem
            ? truncateDisplay(`${selectedItem.number} ${selectedItem.title}`, Math.max(10, Math.floor(innerW * 0.45)), ell)
            : undefined
      }
      icon={isPlace ? (asciiMode ? '+' : '▣') : asciiMode ? '#' : '✎'}
      tone="primary"
      width={frameW}
      onClose={busy ? undefined : onClose}
      isActive={isActive}
      hints={hints}
    >
      {isPlace ? (
        unplacedSections.length === 0 ? (
          <EmptyState
            icon={asciiMode ? 'i' : '▣'}
            title={t(lang, '当前没有未归位段落', 'No unplaced sections to place')}
            hint={t(lang, '删除知识点或重建总纲后保留下来的笔记会出现在这里。', 'Notes kept after deleting points or rebuilding the outline appear here.')}
            actions={[{ key: 'Esc', label: t(lang, '关闭', 'Close') }]}
            width={innerW}
            height={Math.min(10, Math.max(6, height - 10))}
          />
        ) : leafPoints.length === 0 ? (
          <EmptyState
            icon={asciiMode ? '!' : '▣'}
            title={t(lang, '没有可用的目标知识点', 'No target knowledge points')}
            hint={t(lang, '当前复习全书没有可归位的叶子知识点节点。', 'The review book currently has no leaf points to place notes into.')}
            actions={[{ key: 'Esc', label: t(lang, '关闭', 'Close') }]}
            width={innerW}
            height={Math.min(10, Math.max(6, height - 10))}
          />
        ) : (
          <Box flexDirection="column" width={innerW}>
            <Box justifyContent="space-between" width={innerW}>
              <Box gap={1}>
                <Badge label={`v${structureVersion}`} tone="info" variant="soft" />
                <Badge label={t(lang, `未归位 ${unplacedSections.length}`, `Unplaced ${unplacedSections.length}`)} tone="warning" variant="soft" />
                <Badge label={t(lang, `知识点 ${leafPoints.length}`, `Points ${leafPoints.length}`)} tone="primary" variant="soft" />
              </Box>
              {busy ? (
                <Spinner label={t(lang, `归位中${ell}`, `Placing${ell}`)} active={isActive} />
              ) : null}
            </Box>

            <Box marginTop={1} width={innerW} justifyContent="space-between">
              <Text color={activeList === 'sections' ? theme.primary : theme.muted} bold={activeList === 'sections'}>
                {`${activeList === 'sections' ? (asciiMode ? '>' : '▸') : ' '} ${t(lang, '1. 选择未归位段落', '1. Unplaced Section')}`}
              </Text>
              <Text color={theme.dim}>
                {`${clampedSectionIdx + 1}/${unplacedSections.length}`}
              </Text>
            </Box>
            <Box borderStyle={asciiMode ? 'classic' : 'single'} borderColor={activeList === 'sections' ? theme.borderActive : theme.border} width={innerW}>
              <VirtualList
                items={unplacedSections}
                width={Math.max(10, innerW - 2)}
                height={secListH}
                selectedIndex={clampedSectionIdx}
                onChange={(idx) => {
                  setSectionIdx(idx);
                  setError(null);
                }}
                onSelect={() => void handlePlaceSubmit()}
                isActive={isActive && !busy && activeList === 'sections'}
                keyExtractor={(sec) => sec.id}
                renderItem={(sec, ctx) => {
                  const titleText = sec.title || t(lang, '(未标题段落)', '(Untitled section)');
                  const meta = sec.preview
                    ? ` - ${sec.preview}`
                    : typeof sec.chars === 'number'
                      ? ` (${sec.chars}${t(lang, '字', 'c')})`
                      : '';
                  const lead = ctx.selected ? (asciiMode ? '> ' : '› ') : '  ';
                  const rowText = truncateDisplay(`${lead}${titleText}${meta}`, ctx.width, ell);
                  return (
                    <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                      {rowText}
                    </Text>
                  );
                }}
              />
            </Box>

            <Box marginTop={0} width={innerW} justifyContent="space-between">
              <Text color={activeList === 'targets' ? theme.primary : theme.muted} bold={activeList === 'targets'}>
                {`${activeList === 'targets' ? (asciiMode ? '>' : '▸') : ' '} ${t(lang, '2. 选择目标知识点', '2. Target Leaf Point')}`}
              </Text>
              <Text color={theme.dim}>
                {`${clampedTargetIdx + 1}/${leafPoints.length}`}
              </Text>
            </Box>
            <Box borderStyle={asciiMode ? 'classic' : 'single'} borderColor={activeList === 'targets' ? theme.borderActive : theme.border} width={innerW}>
              <VirtualList
                items={leafPoints}
                width={Math.max(10, innerW - 2)}
                height={targetListH}
                selectedIndex={clampedTargetIdx}
                onChange={(idx) => {
                  setTargetIdx(idx);
                  setError(null);
                }}
                onSelect={() => void handlePlaceSubmit()}
                isActive={isActive && !busy && activeList === 'targets'}
                keyExtractor={(pt) => pt.hid}
                renderItem={(pt, ctx) => {
                  const lead = ctx.selected ? (asciiMode ? '> ' : '› ') : '  ';
                  const numPrefix = pt.number ? `${pt.number} ` : '';
                  const hidTag = ` [${pt.hid}]`;
                  const avail = Math.max(8, ctx.width - displayWidth(hidTag));
                  const label = truncateDisplay(`${lead}${numPrefix}${pt.title}`, avail, ell);
                  return (
                    <Box width={ctx.width} justifyContent="space-between">
                      <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                        {label}
                      </Text>
                      <Text color={ctx.selected ? theme.selectionFg : theme.dim}>{hidTag}</Text>
                    </Box>
                  );
                }}
              />
            </Box>

            {selectedSection?.preview ? (
              <Text color={theme.dim}>
                {truncateDisplay(`${t(lang, '摘要: ', 'Preview: ')}${selectedSection.preview}`, innerW, ell)}
              </Text>
            ) : null}

            {error ? (
              <Text color={theme.error}>
                {`${asciiMode ? '!' : '✕'} ${error}`}
              </Text>
            ) : null}
          </Box>
        )
      ) : !selectedItem ? (
        <EmptyState
          icon={asciiMode ? '!' : '▣'}
          title={t(lang, '未选中目录节点', 'No TOC node selected')}
          hint={t(lang, '请先打开复习全书并在左侧目录选择一个章节或知识点。', 'Open a review book and select a chapter or point in the TOC first.')}
          actions={[{ key: 'Esc', label: t(lang, '关闭', 'Close') }]}
          width={innerW}
          height={Math.min(10, Math.max(6, height - 10))}
        />
      ) : (
        <Box flexDirection="column" width={innerW} gap={1} paddingY={1}>
          <Box justifyContent="space-between" width={innerW}>
            <Box gap={1}>
              <Badge label={nodeKind} tone={selectedItem.leaf ? 'primary' : 'accent'} variant="soft" />
              <Badge label={`v${structureVersion}`} tone="info" variant="soft" />
              <Text color={theme.muted}>
                {truncateDisplay(selectedItem.number, Math.max(4, innerW - 24), ell)}
              </Text>
            </Box>
            {busy ? (
              <Spinner label={t(lang, `保存中${ell}`, `Saving${ell}`)} active={isActive} />
            ) : null}
          </Box>

          <Text color={theme.text}>
            {t(lang, '输入新标题 (Enter 保存，Esc 取消):', 'New title (Enter to save, Esc to cancel):')}
          </Text>

          <Box
            borderStyle={asciiMode ? 'classic' : 'single'}
            borderColor={theme.borderActive}
            paddingX={1}
            width={innerW}
          >
            <TextInput
              value={title}
              onChange={setTitle}
              onSubmit={(val) => void handleRenameSubmit(val)}
              onCancel={busy ? undefined : onClose}
              width={inputW}
              prompt={asciiMode ? '>' : '›'}
              maxLength={120}
              placeholder={t(lang, `请输入标题${ell}`, `Enter title${ell}`)}
              isActive={isActive && !busy}
            />
          </Box>

          <Text color={theme.dim}>
            {truncateDisplay(
              t(lang, '仅修改目录显示名称，原讲义正文、笔记与关联练习题均保留。', 'Updates TOC title only; section notes and linked questions stay intact.'),
              innerW,
              ell,
            )}
          </Text>

          {error ? (
            <Text color={theme.error}>
              {`${asciiMode ? '!' : '✕'} ${error}`}
            </Text>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
