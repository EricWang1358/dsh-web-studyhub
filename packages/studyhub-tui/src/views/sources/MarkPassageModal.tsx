import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';

export type MarkStyleValue = 'highlight' | 'underline' | 'bold' | 'queue';

export interface MarkPassageModalProps {
  host: HostClient;
  documentId?: string;
  sourceId?: string;
  revision?: string;
  title?: string;
  currentPage: number;
  pageText: string;
  isActive: boolean;
  onMarked?: () => void;
  onClose: () => void;
}

interface MarkStyleOption {
  value: MarkStyleValue;
  key: '1' | '2' | '3' | '4';
  zhLabel: string;
  enLabel: string;
  tone: 'warning' | 'info' | 'accent' | 'primary';
}

const STYLE_OPTIONS: readonly MarkStyleOption[] = [
  { value: 'highlight', key: '1', zhLabel: '荧光笔', enLabel: 'Highlight', tone: 'warning' },
  { value: 'underline', key: '2', zhLabel: '下划线', enLabel: 'Underline', tone: 'info' },
  { value: 'bold', key: '3', zhLabel: '加粗', enLabel: 'Bold', tone: 'accent' },
  { value: 'queue', key: '4', zhLabel: '待出题', enLabel: 'Queue', tone: 'primary' },
];

interface PassageCandidate {
  index: number;
  quote: string;
  preview: string;
}

interface MarkSaveResponse {
  status?: 'saved' | 'unchanged' | 'full' | 'queue-full' | 'ambiguous' | 'stale' | 'missing' | string;
  saved?: number;
  limit?: number;
  message?: string;
  documentId?: string;
  revision?: string;
}

function styleLabel(opt: MarkStyleOption, lang: UiLanguage): string {
  return lang === 'en' ? opt.enLabel : opt.zhLabel;
}

function extractPassages(pageText: string): PassageCandidate[] {
  const rawLines = String(pageText ?? '').split(/\r?\n/);
  const filtered: string[] = [];
  const fallback: string[] = [];

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const quote = trimmed.slice(0, 3800);
    fallback.push(quote);
    if (/^(?:```|~~~|[-*_]{3,}|\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?)$/.test(quote)) {
      continue;
    }
    filtered.push(quote);
  }

  const chosen = filtered.length > 0 ? filtered : fallback;
  return chosen.map((quote, idx) => ({
    index: idx,
    quote,
    preview: quote.replace(/\s+/g, ' ').trim(),
  }));
}

export const MarkPassageModal = memo(function MarkPassageModal({
  host,
  documentId,
  sourceId,
  revision,
  title,
  currentPage,
  pageText,
  isActive,
  onMarked,
  onClose,
}: MarkPassageModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useWindowSize();

  const passages = useMemo(() => extractPassages(pageText), [pageText]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [styleIndex, setStyleIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
    };
  }, []);

  useEffect(() => {
    setSelectedIndex((prev) => (passages.length === 0 ? 0 : Math.max(0, Math.min(prev, passages.length - 1))));
  }, [passages.length]);

  const activeStyle = STYLE_OPTIONS[styleIndex] ?? STYLE_OPTIONS[0];
  const currentPassage = passages[selectedIndex];

  const handleSaveMark = useCallback(
    async (passage: PassageCandidate) => {
      if (busyRef.current || busy) return;
      if (!sourceId) {
        notify(t(lang, '缺少文本片段标识，无法保存标记', 'Missing source identifier for mark'), 'warning');
        return;
      }

      busyRef.current = true;
      setBusy(true);
      const chosenStyle = activeStyle;
      const chosenLabel = styleLabel(chosenStyle, lang);

      try {
        const res = await tryAction<MarkSaveResponse>(host, 'materials.marks.save', {
          ...(documentId ? { documentId } : {}),
          ...(revision ? { revision } : {}),
          sourceId,
          style: chosenStyle.value,
          selection: {
            ...(documentId ? { documentId } : {}),
            ...(revision ? { revision } : {}),
            sourceId,
            quote: passage.quote,
          },
        });
        if (!mountedRef.current) return;

        if (!res.ok || !res.value) {
          notify(res.error?.message || t(lang, '保存标记失败', 'Failed to save mark'), 'error');
          return;
        }

        const status = res.value.status;
        if (status === 'saved') {
          notify(t(lang, `已添加${chosenLabel}标记`, `Saved ${chosenLabel} mark`), 'success');
          onMarked?.();
          onClose();
        } else if (status === 'unchanged') {
          notify(
            t(lang, `该段落已存在相同样式(${chosenLabel})标记`, `Passage already marked as ${chosenLabel}`),
            'info',
          );
        } else if (status === 'full') {
          const limit = res.value.limit ?? 600;
          notify(
            t(lang, `当前版本标记数已达上限 (${limit})，请先清理部分标记`, `Mark limit reached (${limit}) for this revision`),
            'warning',
          );
        } else if (status === 'queue-full') {
          const limit = res.value.limit ?? 40;
          notify(
            t(
              lang,
              `待出题列表已满 (上限 ${limit})，请先出题或移除部分段落`,
              `Question queue is full (max ${limit}); generate or remove items first`,
            ),
            'warning',
          );
        } else if (status === 'ambiguous') {
          notify(
            t(
              lang,
              '该段落在当前页出现多次，无法唯一锚定；请选择更具体的文本行',
              'Passage appears multiple times; choose a more unique line',
            ),
            'warning',
          );
        } else {
          notify(
            res.value.message || t(lang, '无法锚定所选段落，请刷新后重试', 'Could not anchor selected passage'),
            'warning',
          );
        }
      } catch (err) {
        if (mountedRef.current) notify(errorMessage(err), 'error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [activeStyle, busy, documentId, host, lang, notify, onClose, onMarked, revision, sourceId],
  );

  const claimKeys = useMemo(() => ['1', '2', '3', '4', 'j', 'k'], []);
  useClaimKeys(claimKeys, isActive && !busy);

  useInput(
    (input, key) => {
      if (!isActive || busyRef.current || busy) return;
      if (key.tab) {
        setStyleIndex((prev) => (prev + 1) % STYLE_OPTIONS.length);
        return;
      }
      if (key.ctrl || key.meta) return;
      const matchedStyleIdx = STYLE_OPTIONS.findIndex((opt) => opt.key === input);
      if (matchedStyleIdx >= 0) {
        setStyleIndex(matchedStyleIdx);
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (passages.length === 0) {
      return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    }
    return [
      { key: '1-4/Tab', label: t(lang, '样式', 'Style') },
      { key: 'j/k', label: t(lang, '选择', 'Select') },
      { key: 'Enter', label: t(lang, '标记', 'Mark') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [lang, passages.length]);

  const frameWidth = Math.max(46, Math.min(92, columns - 4));
  const frameHeight = Math.max(14, Math.min(28, termRows - 2));
  const innerWidth = modalContentWidth(frameWidth);
  const innerHeight = Math.max(6, frameHeight - 5);

  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? ' - ' : ' · ';
  const icon = asciiMode ? '*' : '★';

  const showPreview = innerHeight >= 10 && passages.length > 0 && Boolean(currentPassage);
  const previewRows = showPreview ? 3 : 0;
  const statusRows = busy ? 1 : 0;
  const listHeight = Math.max(3, innerHeight - 2 - previewRows - statusRows);

  const subtitle = [title || t(lang, '资料阅读', 'Document'), `P.${currentPage}`].filter(Boolean).join(sep);

  return (
    <Modal
      title={t(lang, '标记当前页段落', 'Mark Passage')}
      subtitle={subtitle}
      icon={icon}
      width={frameWidth}
      height={frameHeight}
      isActive={isActive}
      onClose={onClose}
      hints={hints}
    >
      {passages.length === 0 ? (
        <EmptyState
          title={t(lang, '当前页暂无可标记段落', 'No markable passages on this page')}
          hint={t(lang, '翻到包含正文文本的页面后再试。', 'Turn to a page with extracted text and try again.')}
          width={innerWidth}
          height={innerHeight}
        />
      ) : (
        <Box flexDirection="column" height={innerHeight} width={innerWidth}>
          <Box height={1} width={innerWidth} flexDirection="row" alignItems="center" overflow="hidden">
            {STYLE_OPTIONS.map((opt, idx) => {
              const selected = idx === styleIndex;
              const label = styleLabel(opt, lang);
              return (
                <React.Fragment key={opt.value}>
                  {idx > 0 ? <Text> </Text> : null}
                  <Badge
                    label={`${opt.key}:${label}`}
                    tone={selected ? opt.tone : 'muted'}
                    variant={selected ? 'solid' : 'outline'}
                  />
                </React.Fragment>
              );
            })}
          </Box>

          <Box height={1} width={innerWidth} flexDirection="row" alignItems="center">
            <Text color={theme.dim} wrap="truncate-end">
              {truncateDisplay(
                t(
                  lang,
                  `共 ${passages.length} 个段落 (${selectedIndex + 1}/${passages.length})  当前样式: ${styleLabel(activeStyle, lang)}`,
                  `${passages.length} passages (${selectedIndex + 1}/${passages.length})  Style: ${styleLabel(activeStyle, lang)}`,
                ),
                innerWidth,
                ell,
              )}
            </Text>
          </Box>

          <VirtualList
            items={passages}
            height={listHeight}
            width={innerWidth}
            selectedIndex={selectedIndex}
            onChange={(idx) => setSelectedIndex(idx)}
            onSelect={(item) => void handleSaveMark(item)}
            isActive={isActive && !busy}
            keyExtractor={(item) => `p-${item.index}`}
            renderItem={(item, ctx) => {
              const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
              const numTag = `${String(item.index + 1).padStart(2, ' ')}. `;
              const prefixW = displayWidth(cursor) + displayWidth(numTag);
              const lineText = truncateDisplay(item.preview, Math.max(8, ctx.width - prefixW), ell);
              return (
                <Box flexDirection="row" width={ctx.width}>
                  <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                  <Text color={theme.dim}>{numTag}</Text>
                  <Text color={theme.text} bold={ctx.selected}>
                    {lineText}
                  </Text>
                </Box>
              );
            }}
          />

          {showPreview && currentPassage ? (
            <Box flexDirection="column" height={3} width={innerWidth} overflow="hidden">
              <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerWidth)}</Text>
              <Text color={theme.muted} wrap="truncate-end">
                {truncateDisplay(
                  `${t(lang, '选中段落', 'Selected')}: ${styleLabel(activeStyle, lang)}`,
                  innerWidth,
                  ell,
                )}
              </Text>
              <Text color={theme.text} wrap="truncate-end">
                {truncateDisplay(`"${currentPassage.preview}"`, innerWidth, ell)}
              </Text>
            </Box>
          ) : null}

          {busy ? (
            <Box height={1} width={innerWidth}>
              <Spinner
                label={t(
                  lang,
                  asciiMode ? '正在保存段落标记...' : '正在保存段落标记…',
                  asciiMode ? 'Saving passage mark...' : 'Saving passage mark…',
                )}
                active={isActive}
              />
            </Box>
          ) : null}
        </Box>
      )}
    </Modal>
  );
});
