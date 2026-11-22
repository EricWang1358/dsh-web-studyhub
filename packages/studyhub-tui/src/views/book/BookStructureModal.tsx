import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  EmptyState,
  Modal,
  Spinner,
  TextInput,
  modalContentWidth,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/index.js';
import type { FlatTocItem } from './types.js';

export interface BookStructureModalProps {
  host: HostClient;
  course: string | null;
  selectedItem?: FlatTocItem | null;
  structureVersion: number;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onRenamed?: (nextVersion?: number, hid?: string) => void;
  onConflict?: () => void;
}

interface RenameStructureResponse {
  course?: string | null;
  write?: string;
  hid?: string;
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
  selectedItem,
  structureVersion,
  isActive,
  width,
  height,
  onClose,
  onRenamed,
  onConflict,
}: BookStructureModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);

  const [title, setTitle] = useState(() => selectedItem?.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const lastHidRef = useRef<string | null>(selectedItem?.hid ?? null);

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

  const handleSubmit = useCallback(
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

  const frameW = Math.min(68, Math.max(36, width - 4));
  const innerW = modalContentWidth(frameW);
  const inputW = Math.max(10, innerW - 4);
  const ell = asciiMode ? '...' : '…';

  const hints = useMemo<KeyHint[]>(
    () =>
      selectedItem
        ? [
            { key: 'Enter', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]
        : [{ key: 'Esc', label: t(lang, '关闭', 'Close') }],
    [lang, selectedItem],
  );

  const nodeKind = selectedItem
    ? selectedItem.leaf
      ? t(lang, '知识点', 'Point')
      : t(lang, '章节', 'Section')
    : '';

  return (
    <Modal
      title={t(lang, '重命名目录节点', 'Rename Book Node')}
      subtitle={selectedItem ? truncateDisplay(`${selectedItem.number} ${selectedItem.title}`, Math.max(10, Math.floor(innerW * 0.45)), ell) : undefined}
      icon={asciiMode ? '#' : '✎'}
      tone="primary"
      width={frameW}
      onClose={busy ? undefined : onClose}
      isActive={isActive}
      hints={hints}
    >
      {!selectedItem ? (
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
              onSubmit={(val) => void handleSubmit(val)}
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
              {`${asciiMode ? '!' : '✕'} ${truncateDisplay(error, Math.max(8, innerW - 3), ell)}`}
            </Text>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
