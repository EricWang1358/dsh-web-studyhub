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
import { displayWidth, truncateDisplay, wrapDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import type { BookNode, BookOpenResult, FlatTocItem } from './types.js';

export interface ParsedAiBlock {
  id: string;
  at: string;
  state: 'new' | 'kept';
  mode: string;
  ask: string;
  about: string;
  first: string;
  body: string;
  raw: string;
  start: number;
  end: number;
}

type BookAiBlockActionResponse =
  | (BookOpenResult & { write?: 'kept' | 'deleted' | 'unchanged' | string })
  | {
      done?: {
        status?: 'kept' | 'deleted' | 'unchanged';
      };
      view?: BookOpenResult;
    };

interface AiBlockFileEntry {
  file: string;
  text: string;
  nodeTitle: string;
  blocks: ParsedAiBlock[];
}

export interface BookAiBlocksModalProps {
  host: HostClient;
  course: string | null;
  selectedItem?: FlatTocItem | null;
  bookData?: BookOpenResult | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onUpdated?: (view?: BookOpenResult) => void;
}

const AI_BLOCK_RE =
  /<!-- sh:ai id=(\S+) at=(\S+) state=(new|kept)(?: mode=([a-z]+))?(?: ask=(\S+))? -->\r?\n((?:(?!<!-- sh:ai )[\s\S])*?)\r?\n<!-- \/sh:ai -->/g;

/** Parse `<!-- sh:ai ... --> ... <!-- /sh:ai -->` blocks matching `lib/course-book-ai-text.js`. */
export function parseAiBlocks(text: string): ParsedAiBlock[] {
  const source = String(text ?? '');
  const out: ParsedAiBlock[] = [];
  AI_BLOCK_RE.lastIndex = 0;
  for (const match of source.matchAll(AI_BLOCK_RE)) {
    const inner = match[6] ?? '';
    const [first = '', ...rest] = inner.split(/\r?\n/);
    const about = /^[^：:]*[：:]\s*[「“](.*)[」”]\s*$/.exec(first)?.[1] ?? '';
    let ask = '';
    if (match[5]) {
      try {
        ask = decodeURIComponent(match[5]);
      } catch {
        ask = match[5];
      }
    }
    const index = match.index ?? 0;
    out.push({
      id: match[1],
      at: match[2],
      state: match[3] === 'kept' ? 'kept' : 'new',
      mode: match[4] || 'explain',
      ask,
      about,
      first,
      body: rest.join('\n').trim(),
      raw: match[0],
      start: index,
      end: index + match[0].length,
    });
  }
  return out;
}

function resolveLeafFileNames(
  node: Pick<BookNode, 'key' | 'files'> | null | undefined,
): { mine: string; gen: string } {
  if (!node) return { mine: '', gen: '' };
  const rawId = node.key?.startsWith('bk:') ? node.key.slice(3) : '';
  const mine = node.files?.mine || (rawId ? `${rawId}.mine.md` : '');
  const gen = node.files?.gen || (rawId ? `${rawId}.gen.md` : '');
  return { mine, gen };
}

function collectBookAiFileEntries(nodes: BookNode[] | undefined): AiBlockFileEntry[] {
  const entries: AiBlockFileEntry[] = [];
  const seen = new Set<string>();

  const pushFile = (file: string, text: string | undefined, nodeTitle: string) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    const raw = String(text ?? '');
    entries.push({
      file,
      text: raw,
      nodeTitle,
      blocks: parseAiBlocks(raw),
    });
  };

  const walk = (list: BookNode[] | undefined) => {
    for (const node of list ?? []) {
      if (node.leaf || !node.children?.length) {
        const { mine, gen } = resolveLeafFileNames(node);
        const label = `${node.number} ${node.title}`.trim();
        pushFile(mine, node.mine, label);
        pushFile(gen, node.gen, label);
      }
      if (node.children?.length) walk(node.children);
    }
  };

  walk(nodes);
  return entries;
}

function pickInitialFile(
  entries: AiBlockFileEntry[],
  selectedItem: FlatTocItem | null | undefined,
): string {
  const filesWithBlocks = entries.filter((e) => e.blocks.length > 0);
  if (selectedItem?.leaf) {
    const rawId = selectedItem.key?.startsWith('bk:') ? selectedItem.key.slice(3) : '';
    const mine = selectedItem.node?.files?.mine || (rawId ? `${rawId}.mine.md` : '');
    const gen = selectedItem.node?.files?.gen || (rawId ? `${rawId}.gen.md` : '');
    const mineEntry = entries.find((e) => e.file === mine);
    const genEntry = entries.find((e) => e.file === gen);
    if (mineEntry && mineEntry.blocks.length > 0) return mineEntry.file;
    if (genEntry && genEntry.blocks.length > 0) return genEntry.file;
    if (filesWithBlocks.length > 0 && !mine && !gen) return filesWithBlocks[0].file;
    return mine || gen || filesWithBlocks[0]?.file || '';
  }
  return filesWithBlocks[0]?.file ?? entries[0]?.file ?? '';
}

function firstLinePreview(text: string | undefined, asciiMode: boolean, lang: 'zh' | 'en'): string {
  const cleaned = normalizeAsciiChrome(String(text ?? '').replace(/\s+/g, ' ').trim(), asciiMode);
  return cleaned || t(lang, '(空内容)', '(empty)');
}

function formatModeLabel(mode: string, lang: 'zh' | 'en'): string {
  if (mode === 'here') return t(lang, '补充', 'add');
  if (mode === 'explain') return t(lang, '讲解', 'explain');
  if (mode === 'write') return t(lang, '重写', 'write');
  if (mode === 'follow') return t(lang, '追问', 'follow');
  return mode || t(lang, '补充', 'ai');
}

export const BookAiBlocksModal = memo(function BookAiBlocksModal({
  host,
  course,
  selectedItem,
  bookData,
  isActive,
  width,
  height,
  onClose,
  onUpdated,
}: BookAiBlocksModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const ell = asciiMode ? '...' : '…';

  // Hold input capture across ConfirmDialog transitions so AppShell never steals keys.
  useInputCapture(isActive);

  const hasInitialNodes = Boolean(bookData?.status === 'ok' && bookData.nodes?.length);
  const [localBook, setLocalBook] = useState<BookOpenResult | null>(() => (hasInitialNodes ? bookData ?? null : null));
  const [loading, setLoading] = useState<boolean>(() => !hasInitialNodes);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string>(() => {
    if (!hasInitialNodes) return '';
    return pickInitialFile(collectBookAiFileEntries(bookData?.nodes), selectedItem);
  });
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [previewScrollTop, setPreviewScrollTop] = useState(0);
  const [confirmDeleteBlock, setConfirmDeleteBlock] = useState<ParsedAiBlock | null>(null);
  const [acting, setActing] = useState<'keep' | 'delete' | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (bookData?.status === 'ok' && bookData.nodes?.length) {
      setLocalBook(bookData);
      setLoading(false);
      setErrorText(null);
      setActiveFile((prev) => {
        const entries = collectBookAiFileEntries(bookData.nodes);
        if (prev && entries.some((e) => e.file === prev)) return prev;
        return pickInitialFile(entries, selectedItem);
      });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    void (async () => {
      try {
        const res = await tryAction<BookOpenResult>(host, 'course.book.open', {
          ...(course ? { course } : {}),
          language: lang,
        });
        if (cancelled || !mountedRef.current) return;
        if (!res.ok || !res.value) {
          setErrorText(res.error?.message || t(lang, '读取复习全书失败', 'Failed to load review book'));
          setLoading(false);
          return;
        }
        setLocalBook(res.value);
        setActiveFile(pickInitialFile(collectBookAiFileEntries(res.value.nodes), selectedItem));
        setSelectedIdx(0);
        setPreviewScrollTop(0);
        setLoading(false);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setErrorText(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookData, course, host, lang, selectedItem]);

  const effectiveCourse = localBook?.course ?? bookData?.course ?? course ?? null;
  const allEntries = useMemo(() => collectBookAiFileEntries(localBook?.nodes), [localBook?.nodes]);
  const filesWithBlocks = useMemo(() => allEntries.filter((e) => e.blocks.length > 0), [allEntries]);

  const fileChoices = useMemo(() => {
    const out = filesWithBlocks.map((e) => e.file);
    if (activeFile && !out.includes(activeFile)) out.unshift(activeFile);
    return out;
  }, [activeFile, filesWithBlocks]);

  const resolvedFile = useMemo(() => {
    if (activeFile && allEntries.some((e) => e.file === activeFile)) return activeFile;
    return fileChoices[0] ?? '';
  }, [activeFile, allEntries, fileChoices]);

  const activeEntry = useMemo(
    () => allEntries.find((e) => e.file === resolvedFile) ?? null,
    [allEntries, resolvedFile],
  );
  const blocks = useMemo(() => activeEntry?.blocks ?? [], [activeEntry?.blocks]);
  const clampedIdx = blocks.length > 0 ? Math.max(0, Math.min(selectedIdx, blocks.length - 1)) : 0;
  const selectedBlock = blocks[clampedIdx] ?? null;

  const totalBookBlocks = useMemo(
    () => filesWithBlocks.reduce((sum, entry) => sum + entry.blocks.length, 0),
    [filesWithBlocks],
  );

  const frameW = Math.max(48, Math.min(86, width - 4));
  const frameH = Math.max(14, Math.min(30, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(9, frameH - 5);
  const listH = Math.max(3, Math.min(7, Math.floor((bodyH - 4) * 0.42)));
  const previewH = Math.max(3, bodyH - 4 - listH);

  const previewText = useMemo(() => {
    if (!selectedBlock) return '';
    const segments: string[] = [];
    if (selectedBlock.about) {
      segments.push(`${t(lang, '关于', 'About')}: ${normalizeAsciiChrome(selectedBlock.about, asciiMode)}`);
    } else if (selectedBlock.first) {
      segments.push(normalizeAsciiChrome(selectedBlock.first, asciiMode));
    }
    if (selectedBlock.ask) {
      segments.push(`${t(lang, '要求', 'Prompt')}: ${normalizeAsciiChrome(selectedBlock.ask, asciiMode)}`);
    }
    const bodyClean = normalizeAsciiChrome(selectedBlock.body, asciiMode);
    if (bodyClean) {
      segments.push(bodyClean);
    } else if (!selectedBlock.about && !selectedBlock.first) {
      segments.push(t(lang, '(该补充块暂无正文)', '(This AI block has no body text)'));
    }
    return segments.join('\n\n');
  }, [asciiMode, lang, selectedBlock]);

  const previewLines = useMemo(() => {
    if (!previewText) return [] as string[];
    return wrapDisplay(previewText, Math.max(10, innerW - 1));
  }, [innerW, previewText]);

  const maxPreviewTop = Math.max(0, previewLines.length - previewH);

  const runBlockAction = useCallback(
    async (block: ParsedAiBlock, action: 'keep' | 'delete') => {
      if (busyRef.current || !resolvedFile) return;
      if (action === 'keep' && block.state === 'kept') {
        notify(t(lang, `AI 补充块 (${block.id}) 已处于保留状态`, `AI block (${block.id}) is already kept`), 'info');
        return;
      }
      busyRef.current = true;
      setActing(action);
      setErrorText(null);
      try {
        const res = await tryAction<BookAiBlockActionResponse>(host, 'course.book.block', {
          ...(effectiveCourse ? { course: effectiveCourse } : {}),
          file: resolvedFile,
          id: block.id,
          action,
        });
        if (!mountedRef.current) return;
        if (!res.ok || !res.value) {
          const msg =
            res.error?.message ||
            (action === 'keep'
              ? t(lang, '保留 AI 补充块失败', 'Failed to keep AI block')
              : t(lang, '删除 AI 补充块失败', 'Failed to delete AI block'));
          setErrorText(msg);
          setConfirmDeleteBlock(null);
          notify(msg, 'error');
          return;
        }
        const rawVal = res.value as BookAiBlockActionResponse;
        const nextView: BookOpenResult | undefined =
          'view' in rawVal && rawVal.view
            ? rawVal.view
            : 'status' in rawVal && rawVal.status
              ? (rawVal as BookOpenResult)
              : undefined;
        if (nextView && nextView.status === 'ok') {
          setLocalBook(nextView);
          onUpdated?.(nextView);
        } else {
          onUpdated?.(nextView);
        }
        if (action === 'delete') {
          setConfirmDeleteBlock(null);
          setPreviewScrollTop(0);
          setSelectedIdx((idx) => Math.max(0, idx - (idx >= blocks.length - 1 ? 1 : 0)));
          notify(
            t(lang, `已删除 AI 补充块 (${block.id})`, `Deleted AI block (${block.id})`),
            'success',
          );
        } else {
          notify(
            t(lang, `已保留 AI 补充块 (${block.id})`, `Kept AI block (${block.id})`),
            'success',
          );
        }
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorText(msg);
        setConfirmDeleteBlock(null);
        notify(msg, 'error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setActing(null);
      }
    },
    [blocks.length, effectiveCourse, host, lang, notify, onUpdated, resolvedFile],
  );

  useInput(
    (input, key) => {
      if (confirmDeleteBlock || acting) return;
      if (input === 'q') {
        onClose();
        return;
      }
      if (key.tab && fileChoices.length > 1) {
        const curIdx = fileChoices.indexOf(resolvedFile);
        const nextFile = fileChoices[(curIdx + 1) % fileChoices.length];
        setActiveFile(nextFile);
        setSelectedIdx(0);
        setPreviewScrollTop(0);
        setErrorText(null);
        return;
      }
      if (blocks.length > 0) {
        if (key.downArrow || (!key.ctrl && !key.meta && input === 'j')) {
          setSelectedIdx((i) => Math.min(blocks.length - 1, i + 1));
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
          setSelectedIdx(blocks.length - 1);
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
        if ((input === 'a' || key.return) && selectedBlock) {
          void runBlockAction(selectedBlock, 'keep');
          return;
        }
        if (input === 'd' && selectedBlock) {
          setConfirmDeleteBlock(selectedBlock);
        }
      }
    },
    { isActive: isActive && !confirmDeleteBlock && !acting },
  );

  const visibleWindow = useMemo(() => {
    if (blocks.length <= listH) return { start: 0, items: blocks };
    const half = Math.floor(listH / 2);
    const start = Math.max(0, Math.min(clampedIdx - half, blocks.length - listH));
    return { start, items: blocks.slice(start, start + listH) };
  }, [blocks, clampedIdx, listH]);

  const hints = useMemo<KeyHint[]>(() => {
    if (confirmDeleteBlock || acting) {
      return [{ key: 'Esc', label: t(lang, '取消', 'Cancel') }];
    }
    const list: KeyHint[] = [];
    if (blocks.length > 0) {
      list.push({ key: 'j/k', label: t(lang, '选块', 'Select') });
      if (selectedBlock?.state === 'new') {
        list.push({ key: 'a/Enter', label: t(lang, '保留', 'Keep') });
      }
      list.push({ key: 'd', label: t(lang, '删除', 'Delete') });
    }
    if (fileChoices.length > 1) {
      list.push({ key: 'Tab', label: t(lang, '切文件', 'File') });
    }
    list.push({ key: 'Esc/q', label: t(lang, '关闭', 'Close') });
    return list;
  }, [acting, blocks.length, confirmDeleteBlock, fileChoices.length, lang, selectedBlock?.state]);

  const subtitleText =
    activeEntry?.nodeTitle ||
    (selectedItem ? `${selectedItem.number} ${selectedItem.title}`.trim() : '') ||
    effectiveCourse ||
    t(lang, '复习全书', 'Review Book');

  const sep = asciiMode ? ' | ' : ' · ';
  const pointerChar = asciiMode ? '>' : '▸';
  const newCount = blocks.filter((b) => b.state === 'new').length;

  return (
    <>
      <Modal
        title={t(lang, 'AI 补充块审阅', 'AI Blocks Review')}
        subtitle={truncateDisplay(normalizeAsciiChrome(subtitleText, asciiMode), Math.max(12, Math.floor(innerW * 0.45)), ell)}
        icon={asciiMode ? '#' : '▣'}
        tone="primary"
        width={frameW}
        height={frameH}
        onClose={confirmDeleteBlock || acting ? undefined : onClose}
        isActive={isActive && !confirmDeleteBlock && !acting}
        hints={hints}
      >
        {loading ? (
          <Box height={bodyH} alignItems="center" justifyContent="center">
            <Spinner
              label={t(lang, `正在读取 AI 补充块${ell}`, `Loading AI blocks${ell}`)}
              active={isActive}
            />
          </Box>
        ) : (
          <Box flexDirection="column" width={innerW} height={bodyH} overflow="hidden">
            {/* Header row: active file & block counts */}
            <Box height={1} width={innerW} justifyContent="space-between" alignItems="center" overflow="hidden" flexShrink={0}>
              <Box gap={1} overflow="hidden">
                <Text color={theme.primary} bold>
                  {truncateDisplay(
                    resolvedFile || t(lang, '未选择文件', 'No file selected'),
                    Math.max(12, Math.floor(innerW * 0.42)),
                    ell,
                  )}
                </Text>
                <Badge
                  label={t(lang, `${blocks.length} 块`, `${blocks.length} blocks`)}
                  tone={blocks.length > 0 ? 'accent' : 'neutral'}
                  variant="soft"
                />
                {newCount > 0 ? (
                  <Badge
                    label={t(lang, `${newCount} 待审`, `${newCount} new`)}
                    tone="warning"
                    variant="soft"
                  />
                ) : null}
              </Box>
              <Box flexShrink={0}>
                {acting ? (
                  <Spinner
                    label={
                      acting === 'keep'
                        ? t(lang, `保留中${ell}`, `Keeping${ell}`)
                        : t(lang, `删除中${ell}`, `Deleting${ell}`)
                    }
                    active={isActive}
                  />
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
                  title={t(lang, '操作 AI 补充块失败', 'AI block action error')}
                  hint={normalizeAsciiChrome(errorText, asciiMode)}
                  actions={[{ key: 'Esc/q', label: t(lang, '关闭', 'Close') }]}
                  width={innerW}
                  height={bodyH - 2}
                />
              </Box>
            ) : blocks.length === 0 ? (
              <Box height={bodyH - 2} alignItems="center" justifyContent="center">
                <EmptyState
                  icon={asciiMode ? '-' : '▣'}
                  title={t(lang, '当前章节暂无 AI 补充块', 'No AI blocks in this file yet')}
                  hint={
                    totalBookBlocks > 0 && fileChoices.length > 1
                      ? t(
                          lang,
                          `当前文件暂无 AI 补充块（全书共有 ${totalBookBlocks} 个补充块，按 Tab 切换文件审阅）`,
                          `No AI blocks in this file (${totalBookBlocks} across book — press Tab to switch file)`,
                        )
                      : t(
                          lang,
                          '当前章节暂无 AI 补充块（按 E 生成后可在此审阅保留或删除）',
                          'No AI blocks in this file yet (press E to generate, then keep or delete here)',
                        )
                  }
                  actions={[
                    ...(fileChoices.length > 1 ? [{ key: 'Tab', label: t(lang, '切换文件', 'Switch file') }] : []),
                    { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
                  ]}
                  width={innerW}
                  height={bodyH - 2}
                />
              </Box>
            ) : (
              <>
                {/* AI blocks list */}
                <Box flexDirection="column" width={innerW} height={listH} overflow="hidden" flexShrink={0}>
                  {visibleWindow.items.map((block, offset) => {
                    const idx = visibleWindow.start + offset;
                    const isSel = idx === clampedIdx;
                    const pointer = isSel ? `${pointerChar} ` : '  ';
                    const stateLabel = block.state === 'new' ? t(lang, '待审', 'New') : t(lang, '已保留', 'Kept');
                    const badgeW = displayWidth(stateLabel) + 2;
                    const kindLabel = formatModeLabel(block.mode, lang);
                    const aboutClean = block.about ? normalizeAsciiChrome(block.about, asciiMode) : '';
                    const snippet = firstLinePreview(block.body || block.first, asciiMode, lang);
                    const previewLabel =
                      aboutClean && aboutClean !== snippet ? `${aboutClean}${sep}${snippet}` : aboutClean || snippet;
                    const rowSummary = `${block.id} [${kindLabel}] ${previewLabel}`;
                    const rem = Math.max(4, innerW - 2 - badgeW - 1);
                    const clippedSummary = truncateDisplay(rowSummary, rem, ell);
                    const rowPadWidth = Math.max(0, rem - displayWidth(clippedSummary));
                    const trailingPad = isSel && rowPadWidth > 0 ? ' '.repeat(rowPadWidth) : '';
                    return (
                      <Box key={`${block.id}-${idx}`} height={1} width={innerW} overflow="hidden">
                        <Text
                          color={isSel ? theme.selectionFg : theme.text}
                          backgroundColor={isSel ? theme.selectionBg : undefined}
                          bold={isSel}
                        >
                          {pointer}
                        </Text>
                        <Badge
                          label={stateLabel}
                          tone={block.state === 'new' ? 'warning' : 'success'}
                          variant="soft"
                        />
                        <Text
                          color={isSel ? theme.selectionFg : theme.text}
                          backgroundColor={isSel ? theme.selectionBg : undefined}
                          bold={isSel}
                        >
                          {` ${clippedSummary}${trailingPad}`}
                        </Text>
                      </Box>
                    );
                  })}
                </Box>

                <Divider width={innerW} />

                {/* Selected block metadata row */}
                <Box height={1} width={innerW} justifyContent="space-between" alignItems="center" overflow="hidden" flexShrink={0}>
                  <Box gap={1} overflow="hidden">
                    {selectedBlock ? (
                      <>
                        <Badge
                          label={selectedBlock.state === 'new' ? t(lang, '待审', 'New') : t(lang, '已保留', 'Kept')}
                          tone={selectedBlock.state === 'new' ? 'warning' : 'success'}
                          variant="soft"
                        />
                        <Text color={theme.heading} bold>
                          {truncateDisplay(
                            `${selectedBlock.id}${sep}${formatModeLabel(selectedBlock.mode, lang)}${
                              selectedBlock.about ? `${sep}${normalizeAsciiChrome(selectedBlock.about, asciiMode)}` : ''
                            }`,
                            Math.max(12, innerW - 24),
                            ell,
                          )}
                        </Text>
                      </>
                    ) : null}
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

      {confirmDeleteBlock ? (
        <ConfirmDialog
          title={t(lang, '确认删除该 AI 补充块？', 'Delete this AI block from the book?')}
          message={t(
            lang,
            `文件: ${resolvedFile}\n块 ID: ${confirmDeleteBlock.id}\n${
              confirmDeleteBlock.about ? `主题: ${normalizeAsciiChrome(confirmDeleteBlock.about, asciiMode)}\n` : ''
            }\n删除后将从本节讲义中移除该 AI 补充块。`,
            `File: ${resolvedFile}\nBlock ID: ${confirmDeleteBlock.id}\n${
              confirmDeleteBlock.about ? `Topic: ${normalizeAsciiChrome(confirmDeleteBlock.about, asciiMode)}\n` : ''
            }\nThis removes the AI block from the book file.`,
          )}
          confirmLabel={t(lang, '删除', 'Delete')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && Boolean(confirmDeleteBlock) && !acting}
          width={Math.min(62, Math.max(44, width - 8))}
          onConfirm={() => void runBlockAction(confirmDeleteBlock, 'delete')}
          onCancel={() => setConfirmDeleteBlock(null)}
        />
      ) : null}
    </>
  );
});
