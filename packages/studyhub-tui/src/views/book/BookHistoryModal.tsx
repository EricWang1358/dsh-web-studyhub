import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, Spinner, normalizeAsciiChrome } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { ScrollView } from '../../components/ScrollView.js';
import { useInputCapture } from '../../components/focus.js';
import { displayWidth, padDisplay, truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import type { BookOpenResult, FlatTocItem } from './types.js';

export interface BookHistoryVersionEntry {
  version: number;
  at: string | null;
  chars: number;
  by?: string;
  redo?: boolean;
  text: string;
}

export interface BookHistoryStructureEntry {
  version: number;
  at: string | null;
  kind: string;
  hid: string;
  title: string;
  fromTitle?: string;
  parentTitle?: string;
  targetTitle?: string;
  removedPoints?: number;
  active?: boolean;
  undoable?: boolean;
}

export interface BookRevisionHistoryResult {
  course: string | null;
  revision: number | null;
  files?: Record<string, number>;
  versions?: BookHistoryVersionEntry[];
  structure?: BookHistoryStructureEntry[];
}

interface BookOpenWithFiles extends BookOpenResult {
  files?: Record<string, { version?: number; forked?: boolean }>;
}

export interface BookHistoryModalProps {
  host: HostClient;
  course: string | null;
  selectedItem?: FlatTocItem | null;
  bookData?: BookOpenResult | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onReverted?: () => void;
}

function formatTimestamp(at: string | null | undefined, compact = false): string {
  if (!at) return '-';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) {
    return compact ? at.slice(5, 16).replace('T', ' ') : at.slice(0, 19).replace('T', ' ');
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  if (compact) return `${mm}-${dd} ${hh}:${min}`;
  const yyyy = d.getFullYear();
  const ss = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function formatByLabel(by: string | undefined, lang: 'zh' | 'en'): string {
  if (by === 'program') return t(lang, '系统生成', 'program');
  if (by === 'learner') return t(lang, '手动编辑', 'learner');
  return by && by.trim() ? by.trim() : t(lang, '未知', 'unknown');
}

function firstLinePreview(text: string | undefined, asciiMode: boolean, lang: 'zh' | 'en'): string {
  const cleaned = normalizeAsciiChrome(String(text ?? '').replace(/\s+/g, ' ').trim(), asciiMode);
  return cleaned || t(lang, '(空内容)', '(empty)');
}

function resolveInitialLeafFiles(selectedItem: FlatTocItem | null | undefined): {
  gen: string;
  mine: string;
  qa: string;
  primary: string;
} {
  if (!selectedItem || !selectedItem.leaf) {
    return { gen: '', mine: '', qa: '', primary: '' };
  }
  const rawId = selectedItem.key?.startsWith('bk:') ? selectedItem.key.slice(3) : '';
  const gen = selectedItem.node?.files?.gen || (rawId ? `${rawId}.gen.md` : '');
  const mine = selectedItem.node?.files?.mine || (rawId ? `${rawId}.mine.md` : '');
  const qa = selectedItem.node?.files?.qa || (rawId ? `${rawId}.qa.md` : '');
  return { gen, mine, qa, primary: gen || mine || qa || '' };
}

export const BookHistoryModal = memo(function BookHistoryModal({
  host,
  course,
  selectedItem,
  bookData,
  isActive,
  width,
  height,
  onClose,
  onReverted,
}: BookHistoryModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const ell = asciiMode ? '...' : '…';

  // Hold input capture across ConfirmDialog transitions so AppShell never steals keys.
  useInputCapture(isActive);

  const leafFiles = useMemo(() => resolveInitialLeafFiles(selectedItem), [selectedItem]);
  const [activeFile, setActiveFile] = useState<string>(() => leafFiles.primary);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<BookRevisionHistoryResult | null>(null);
  const [fileMetaMap, setFileMetaMap] = useState<Record<string, { version?: number; forked?: boolean }>>(
    () => (bookData as BookOpenWithFiles | null | undefined)?.files ?? {},
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [previewScrollTop, setPreviewScrollTop] = useState(0);
  const [confirmEntry, setConfirmEntry] = useState<BookHistoryVersionEntry | null>(null);
  const [reverting, setReverting] = useState(false);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const incoming = (bookData as BookOpenWithFiles | null | undefined)?.files;
    if (incoming) setFileMetaMap(incoming);
  }, [bookData]);

  const effectiveCourse = historyData?.course ?? bookData?.course ?? course ?? null;

  const loadHistory = useCallback(
    async (targetFile: string, allowAutoPick: boolean) => {
      const seq = ++reqSeqRef.current;
      setLoading(true);
      setErrorText(null);
      try {
        const res = await tryAction<BookRevisionHistoryResult>(host, 'course.book.revision', {
          ...(course ? { course } : {}),
          history: true,
          ...(targetFile ? { file: targetFile } : {}),
        });
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        if (!res.ok || !res.value) {
          setErrorText(res.error?.message || t(lang, '读取版本历史失败', 'Failed to load version history'));
          setLoading(false);
          return;
        }
        const val = res.value;
        const filesCounts = val.files ?? {};
        const versions = val.versions ?? [];

        if (allowAutoPick && versions.length === 0) {
          let fallbackFile = '';
          if (leafFiles.mine && targetFile !== leafFiles.mine && (filesCounts[leafFiles.mine] ?? 0) > 0) {
            fallbackFile = leafFiles.mine;
          } else if (!targetFile) {
            fallbackFile = Object.keys(filesCounts).find((k) => (filesCounts[k] ?? 0) > 0) ?? '';
          }
          if (fallbackFile) {
            setActiveFile(fallbackFile);
            const fallbackRes = await tryAction<BookRevisionHistoryResult>(host, 'course.book.revision', {
              ...(course ? { course } : {}),
              history: true,
              file: fallbackFile,
            });
            if (!mountedRef.current || reqSeqRef.current !== seq) return;
            if (fallbackRes.ok && fallbackRes.value) {
              setHistoryData(fallbackRes.value);
              setSelectedIdx(0);
              setPreviewScrollTop(0);
              setLoading(false);
              return;
            }
          }
        }

        setHistoryData(val);
        setSelectedIdx(0);
        setPreviewScrollTop(0);
        setLoading(false);
      } catch (err) {
        if (!mountedRef.current || reqSeqRef.current !== seq) return;
        setErrorText(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    },
    [course, host, lang, leafFiles.mine],
  );

  useEffect(() => {
    setActiveFile(leafFiles.primary);
    void loadHistory(leafFiles.primary, true);
  }, [leafFiles.primary, loadHistory]);

  const versions = useMemo(() => historyData?.versions ?? [], [historyData?.versions]);
  const clampedIdx = versions.length > 0 ? Math.max(0, Math.min(selectedIdx, versions.length - 1)) : 0;
  const selectedEntry = versions[clampedIdx] ?? null;

  const fileChoices = useMemo(() => {
    const out: string[] = [];
    const pushUnique = (name: string) => {
      if (name && !out.includes(name)) out.push(name);
    };
    pushUnique(leafFiles.gen);
    pushUnique(leafFiles.mine);
    pushUnique(leafFiles.qa);
    for (const [name, count] of Object.entries(historyData?.files ?? {})) {
      if ((count ?? 0) > 0) pushUnique(name);
    }
    if (activeFile) pushUnique(activeFile);
    return out;
  }, [activeFile, historyData?.files, leafFiles.gen, leafFiles.mine, leafFiles.qa]);

  const frameW = Math.max(48, Math.min(86, width - 4));
  const frameH = Math.max(14, Math.min(30, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(9, frameH - 5);
  const listH = Math.max(3, Math.min(7, Math.floor((bodyH - 4) * 0.42)));
  const previewH = Math.max(3, bodyH - 4 - listH);

  const previewText = useMemo(() => {
    if (!selectedEntry) return '';
    const raw = normalizeAsciiChrome(selectedEntry.text ?? '', asciiMode);
    return raw.trim() ? raw : t(lang, '(该历史版本为空内容)', '(This historical version is empty)');
  }, [asciiMode, lang, selectedEntry]);

  const previewLines = useMemo(() => {
    if (!previewText) return [] as string[];
    return wrapDisplay(previewText, Math.max(10, innerW - 1));
  }, [innerW, previewText]);

  const maxPreviewTop = Math.max(0, previewLines.length - previewH);

  const executeRevert = useCallback(
    async (entry: BookHistoryVersionEntry) => {
      if (busyRef.current || !activeFile) return;
      busyRef.current = true;
      setReverting(true);
      setErrorText(null);
      try {
        const payload: Record<string, unknown> = {
          ...(effectiveCourse ? { course: effectiveCourse } : {}),
          file: activeFile,
          ...(typeof entry.at === 'string' && Number.isInteger(entry.version)
            ? { at: entry.at, entryVersion: entry.version }
            : {}),
          redo: Boolean(entry.redo),
        };
        const res = await tryAction<BookOpenWithFiles>(host, 'course.book.revert', payload);
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          const msg = res.error?.message || t(lang, '恢复历史版本失败', 'Failed to restore historical version');
          setErrorText(msg);
          setConfirmEntry(null);
          notify(msg, 'error');
          return;
        }
        if (res.value.files) setFileMetaMap(res.value.files);
        const nextVer = res.value.files?.[activeFile]?.version;
        const verSuffix = typeof nextVer === 'number' ? ` (v${nextVer})` : '';
        notify(
          t(
            lang,
            `已恢复 ${activeFile} 至历史版本 v${entry.version}${verSuffix}`,
            `Restored ${activeFile} to v${entry.version}${verSuffix}`,
          ),
          'success',
        );
        setConfirmEntry(null);
        onReverted?.();
        onClose();
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorText(msg);
        setConfirmEntry(null);
        notify(msg, 'error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setReverting(false);
      }
    },
    [activeFile, effectiveCourse, host, lang, notify, onClose, onReverted],
  );

  useInput(
    (input, key) => {
      if (confirmEntry || reverting) return;
      if (input === 'q') {
        onClose();
        return;
      }
      if (input === 'r') {
        void loadHistory(activeFile, false);
        return;
      }
      if (key.tab && fileChoices.length > 1) {
        const curIdx = fileChoices.indexOf(activeFile);
        const nextFile = fileChoices[(curIdx + 1) % fileChoices.length];
        setActiveFile(nextFile);
        void loadHistory(nextFile, false);
        return;
      }
      if (versions.length > 0) {
        if (key.downArrow || (!key.ctrl && !key.meta && input === 'j')) {
          setSelectedIdx((i) => Math.min(versions.length - 1, i + 1));
          setPreviewScrollTop(0);
          return;
        }
        if (key.upArrow || (!key.ctrl && !key.meta && input === 'k')) {
          setSelectedIdx((i) => Math.max(0, i - 1));
          setPreviewScrollTop(0);
          return;
        }
        if (key.home || (!key.ctrl && !key.meta && input === 'g')) {
          setSelectedIdx(0);
          setPreviewScrollTop(0);
          return;
        }
        if (key.end || (!key.ctrl && !key.meta && input === 'G')) {
          setSelectedIdx(versions.length - 1);
          setPreviewScrollTop(0);
          return;
        }
        if (key.pageDown || (key.ctrl && input === 'd') || input === 'J') {
          const step = Math.max(1, Math.floor(previewH / 2));
          setPreviewScrollTop((tPos) => Math.min(maxPreviewTop, tPos + step));
          return;
        }
        if (key.pageUp || (key.ctrl && input === 'u') || input === 'K') {
          const step = Math.max(1, Math.floor(previewH / 2));
          setPreviewScrollTop((tPos) => Math.max(0, tPos - step));
          return;
        }
        if ((key.return || input === 'R') && selectedEntry) {
          setConfirmEntry(selectedEntry);
        }
      }
    },
    { isActive: isActive && !confirmEntry && !reverting },
  );

  const currentFileVer = activeFile ? fileMetaMap[activeFile]?.version : undefined;
  const totalBookHistoryCount = useMemo(
    () => Object.values(historyData?.files ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0),
    [historyData?.files],
  );

  const visibleWindow = useMemo(() => {
    if (versions.length <= listH) return { start: 0, items: versions };
    const half = Math.floor(listH / 2);
    const start = Math.max(0, Math.min(clampedIdx - half, versions.length - listH));
    return { start, items: versions.slice(start, start + listH) };
  }, [clampedIdx, listH, versions]);

  const hints = useMemo<KeyHint[]>(() => {
    if (confirmEntry || reverting) {
      return [{ key: 'Esc', label: t(lang, '取消', 'Cancel') }];
    }
    const list: KeyHint[] = [];
    if (versions.length > 0) {
      list.push(
        { key: 'j/k', label: t(lang, '选版本', 'Select') },
        { key: 'Enter/R', label: t(lang, '恢复版本', 'Restore') },
      );
    }
    if (fileChoices.length > 1) {
      list.push({ key: 'Tab', label: t(lang, '切文件', 'File') });
    }
    list.push(
      { key: 'r', label: t(lang, '刷新', 'Refresh') },
      { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
    );
    return list;
  }, [confirmEntry, fileChoices.length, lang, reverting, versions.length]);

  const sectionTitle = selectedItem
    ? `${selectedItem.number} ${selectedItem.title}`.trim()
    : effectiveCourse ?? t(lang, '复习全书', 'Review Book');

  const sep = asciiMode ? ' | ' : ' · ';
  const pointerChar = asciiMode ? '>' : '▸';

  return (
    <>
      <Modal
        title={t(lang, '版本历史与回退', 'Revision History & Revert')}
        subtitle={truncateDisplay(sectionTitle, Math.max(12, Math.floor(innerW * 0.45)), ell)}
        icon={asciiMode ? '#' : '▣'}
        tone="primary"
        width={frameW}
        height={frameH}
        onClose={confirmEntry || reverting ? undefined : onClose}
        isActive={isActive && !confirmEntry && !reverting}
        hints={hints}
      >
        {loading ? (
          <Box height={bodyH} alignItems="center" justifyContent="center">
            <Spinner
              label={t(lang, `正在读取版本历史${ell}`, `Loading revision history${ell}`)}
              active={isActive}
            />
          </Box>
        ) : (
          <Box flexDirection="column" width={innerW} height={bodyH} overflow="hidden">
            {/* Header row: active file, current version & counts */}
            <Box height={1} width={innerW} justifyContent="space-between" alignItems="center" overflow="hidden" flexShrink={0}>
              <Box gap={1} overflow="hidden">
                <Text color={theme.primary} bold>
                  {truncateDisplay(
                    activeFile || t(lang, '未选择文件', 'No file selected'),
                    Math.max(12, Math.floor(innerW * 0.45)),
                    ell,
                  )}
                </Text>
                {typeof currentFileVer === 'number' ? (
                  <Badge label={`${t(lang, '当前', 'Now')} v${currentFileVer}`} tone="info" variant="soft" />
                ) : historyData?.revision != null ? (
                  <Badge label={`rev ${historyData.revision}`} tone="info" variant="soft" />
                ) : null}
                <Badge
                  label={t(lang, `${versions.length} 条历史`, `${versions.length} hist`)}
                  tone={versions.length > 0 ? 'accent' : 'neutral'}
                  variant="soft"
                />
              </Box>
              <Box flexShrink={0}>
                {reverting ? (
                  <Spinner label={t(lang, `恢复中${ell}`, `Restoring${ell}`)} active={isActive} />
                ) : fileChoices.length > 1 ? (
                  <Text color={theme.muted}>
                    {t(lang, `Tab 切文件 (${fileChoices.length})`, `Tab file (${fileChoices.length})`)}
                  </Text>
                ) : null}
              </Box>
            </Box>

            <Divider width={innerW} />

            {errorText ? (
              <Box height={bodyH - 2} alignItems="center" justifyContent="center">
                <EmptyState
                  icon={asciiMode ? '!' : '✕'}
                  title={t(lang, '加载或恢复失败', 'History error')}
                  hint={errorText}
                  actions={[
                    { key: 'r', label: t(lang, '重试', 'Retry') },
                    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
                  ]}
                  width={innerW}
                  height={bodyH - 2}
                />
              </Box>
            ) : versions.length === 0 ? (
              <Box height={bodyH - 2} alignItems="center" justifyContent="center">
                <EmptyState
                  icon={asciiMode ? '-' : '▣'}
                  title={t(lang, '当前文件暂无编辑历史', 'No edit history yet')}
                  hint={
                    totalBookHistoryCount > 0 && fileChoices.length > 1
                      ? t(
                          lang,
                          `本文件尚无历史记录（全书共有 ${totalBookHistoryCount} 条历史，按 Tab 切换文件查看）`,
                          `No versions for this file (${totalBookHistoryCount} across book — press Tab to switch file)`,
                        )
                      : t(
                          lang,
                          '编辑并保存本节讲义或笔记后，历史版本会自动保存在这里（不消耗 AI 额度）',
                          'Saved edits to this section will appear here automatically (0 AI tokens)',
                        )
                  }
                  actions={[
                    ...(fileChoices.length > 1 ? [{ key: 'Tab', label: t(lang, '切换文件', 'Switch file') }] : []),
                    { key: 'r', label: t(lang, '刷新', 'Refresh') },
                    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
                  ]}
                  width={innerW}
                  height={bodyH - 2}
                />
              </Box>
            ) : (
              <>
                {/* Historical versions list */}
                <Box flexDirection="column" width={innerW} height={listH} overflow="hidden" flexShrink={0}>
                  {visibleWindow.items.map((entry, offset) => {
                    const idx = visibleWindow.start + offset;
                    const isSel = idx === clampedIdx;
                    const pointer = isSel ? `${pointerChar} ` : '  ';
                    const timeStr = formatTimestamp(entry.at, true);
                    const byStr = formatByLabel(entry.by, lang);
                    const redoTag = entry.redo ? ' [redo]' : '';
                    const prefix = `${pointer}v${entry.version} ${timeStr} [${byStr}]${redoTag} `;
                    const rem = Math.max(6, innerW - displayWidth(prefix));
                    const snippet = truncateDisplay(firstLinePreview(entry.text, asciiMode, lang), rem, ell);
                    const fullLine = truncateDisplay(`${prefix}${snippet}`, innerW, ell);
                    return (
                      <Box key={`${entry.version}-${entry.at ?? idx}-${entry.redo ? 'r' : 'h'}`} height={1} width={innerW} overflow="hidden">
                        <Text
                          color={isSel ? theme.selectionFg : theme.text}
                          backgroundColor={isSel ? theme.selectionBg : undefined}
                          bold={isSel}
                        >
                          {isSel ? padDisplay(fullLine, innerW) : fullLine}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>

                <Divider width={innerW} />

                {/* Selected entry metadata row */}
                <Box height={1} width={innerW} justifyContent="space-between" alignItems="center" overflow="hidden" flexShrink={0}>
                  <Box gap={1} overflow="hidden">
                    <Text color={theme.heading} bold>
                      {selectedEntry
                        ? truncateDisplay(
                            `v${selectedEntry.version}${sep}${formatTimestamp(selectedEntry.at)}${sep}${formatByLabel(selectedEntry.by, lang)}${sep}${selectedEntry.chars} ${t(lang, '字', 'chars')}`,
                            Math.max(14, innerW - (selectedEntry.redo ? 9 : 1)),
                            ell,
                          )
                        : ''}
                    </Text>
                    {selectedEntry?.redo ? <Badge label="redo" tone="warning" variant="outline" /> : null}
                  </Box>
                  <Box flexShrink={0}>
                    {previewLines.length > previewH ? (
                      <Text color={theme.dim}>{t(lang, 'PgUp/PgDn 滚动', 'PgUp/PgDn scroll')}</Text>
                    ) : null}
                  </Box>
                </Box>

                {/* Scrollable pure-text preview */}
                <Box width={innerW} height={previewH} overflow="hidden" flexShrink={0}>
                  <ScrollView
                    lines={previewLines}
                    width={innerW}
                    height={previewH}
                    isActive={false}
                    scrollTop={previewScrollTop}
                    ascii={asciiMode}
                  />
                </Box>
              </>
            )}
          </Box>
        )}
      </Modal>

      {confirmEntry ? (
        <ConfirmDialog
          title={t(lang, '确认恢复到此历史版本？', 'Restore this historical version?')}
          message={t(
            lang,
            `文件: ${activeFile}\n目标版本: v${confirmEntry.version} (${formatTimestamp(confirmEntry.at)})${confirmEntry.redo ? ' [redo]' : ''}\n\n当前正文仍会保留在版本历史中，不会丢失。`,
            `File: ${activeFile}\nTarget version: v${confirmEntry.version} (${formatTimestamp(confirmEntry.at)})${confirmEntry.redo ? ' [redo]' : ''}\n\nYour current content stays in version history.`,
          )}
          confirmLabel={t(lang, '恢复此版本', 'Restore')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive && Boolean(confirmEntry) && !reverting}
          width={Math.min(62, Math.max(44, width - 8))}
          onConfirm={() => void executeRevert(confirmEntry)}
          onCancel={() => setConfirmEntry(null)}
        />
      ) : null}
    </>
  );
});
