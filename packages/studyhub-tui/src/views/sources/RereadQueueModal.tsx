import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList } from '../../components/VirtualList.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';

export interface RereadQueueModalProps {
  host: HostClient;
  course?: string | null;
  isActive: boolean;
  onOpenSource: (sourceKey: string, page?: number) => void;
  onClose: () => void;
}

interface RereadMarkSelection {
  documentId?: string;
  revision?: string;
  sourceId?: string;
  start?: number;
  end?: number;
  quote?: string;
  page?: number;
}

interface RereadMarkItem {
  id: string;
  documentId?: string;
  revision?: string;
  style?: string;
  title?: string;
  section?: string;
  page?: number;
  selection?: RereadMarkSelection;
  risk?: { due?: number; weak?: number };
  seenAt?: string;
}

interface RereadQueueResponse {
  status?: string;
  items?: RereadMarkItem[];
  count?: number;
  total?: number;
}

function formatMarkStyle(
  style: string | undefined,
  lang: UiLanguage,
): { short: string; label: string; tone: 'warning' | 'accent' | 'info' | 'muted' } {
  switch (style) {
    case 'highlight':
      return { short: t(lang, '荧光', 'HL'), label: t(lang, '荧光笔', 'Highlight'), tone: 'warning' };
    case 'bold':
      return { short: t(lang, '加粗', 'Bold'), label: t(lang, '加粗', 'Bold'), tone: 'accent' };
    case 'underline':
      return { short: t(lang, '下划', 'UL'), label: t(lang, '下划线', 'Underline'), tone: 'info' };
    case 'queue':
      return { short: t(lang, '待题', 'Q'), label: t(lang, '待出题', 'Queue'), tone: 'info' };
    default:
      return { short: t(lang, '标记', 'Mk'), label: style || t(lang, '标记', 'Mark'), tone: 'muted' };
  }
}

function compactQuote(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

export const RereadQueueModal = memo(function RereadQueueModal({
  host,
  course,
  isActive,
  onOpenSource,
  onClose,
}: RereadQueueModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useStableWindowSize();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<RereadMarkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadQueue = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    const args: Record<string, unknown> = {};
    if (course && course.trim()) {
      args.course = course.trim();
    }
    try {
      const res = await tryAction<RereadQueueResponse>(host, 'materials.marks.reread', args);
      if (!mountedRef.current || seq !== reqSeqRef.current) return;
      setLoading(false);
      if (!res.ok || !res.value) {
        setItems([]);
        setTotal(0);
        setError(res.error?.message || t(lang, '加载重读清单失败', 'Failed to load reread queue'));
        return;
      }
      if (res.value.status === 'unavailable') {
        setItems([]);
        setTotal(0);
        setError(t(lang, '当前环境暂不支持重读清单', 'Reread queue is unavailable in this workspace'));
        return;
      }
      const nextItems = Array.isArray(res.value.items) ? res.value.items : [];
      setItems(nextItems);
      setTotal(typeof res.value.total === 'number' ? res.value.total : nextItems.length);
      setSelectedIndex((prev) => Math.max(0, Math.min(prev, Math.max(0, nextItems.length - 1))));
    } catch (err) {
      if (!mountedRef.current || seq !== reqSeqRef.current) return;
      setLoading(false);
      setItems([]);
      setTotal(0);
      setError(errorMessage(err));
    }
  }, [host, course, lang]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (selectedIndex >= items.length) {
      setSelectedIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, selectedIndex]);

  const currentItem = items[selectedIndex];

  const handleOpen = useCallback(
    (item: RereadMarkItem) => {
      if (busyRef.current || busy) return;
      const sourceKey = item.selection?.sourceId || item.documentId || '';
      const page = item.page ?? item.selection?.page;
      onClose();
      if (sourceKey) {
        onOpenSource(sourceKey, page);
      }
    },
    [busy, onClose, onOpenSource],
  );

  const handleMarkSeen = useCallback(
    async (target: RereadMarkItem) => {
      if (busyRef.current || busy) return;
      const sourceId = target.selection?.sourceId;
      if (!target.id || (!sourceId && !target.documentId)) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await tryAction<Record<string, unknown>>(host, 'materials.marks.seen', {
          ...(sourceId ? { sourceId } : target.documentId ? { documentId: target.documentId } : {}),
          ...(target.revision ? { revision: target.revision } : {}),
          id: target.id,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '标记重读失败', 'Failed to mark as reread'), 'error');
          return;
        }
        if (res.value?.status === 'missing') {
          notify(t(lang, '当前版本未找到该标记，已刷新清单', 'Mark not found in current revision; queue refreshed'), 'info');
        } else {
          notify(t(lang, '已标记为重读', 'Marked as reread'), 'success');
        }
        await loadQueue();
      } catch (err) {
        if (mountedRef.current) notify(errorMessage(err), 'error');
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, lang, loadQueue, notify],
  );

  useInput(
    (input) => {
      if (!isActive || loading || busyRef.current || busy) return;
      if (input === 'r') {
        if (error || !currentItem) {
          void loadQueue();
        } else {
          void handleMarkSeen(currentItem);
        }
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    if (loading) {
      return [{ key: 'Esc', label: t(lang, '关闭', 'Close') }];
    }
    if (error || items.length === 0) {
      return [
        { key: 'r', label: t(lang, '刷新', 'Refresh') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ];
    }
    return [
      { key: 'Enter', label: t(lang, '打开原文', 'Open') },
      { key: 'r', label: t(lang, '已重读', 'Mark Seen') },
      { key: 'j/k', label: t(lang, '选择', 'Select') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [error, items.length, lang, loading]);

  const frameWidth = Math.max(48, Math.min(92, columns - 4));
  const frameHeight = Math.max(14, Math.min(28, termRows - 2));
  const innerWidth = modalContentWidth(frameWidth);
  const innerHeight = Math.max(8, frameHeight - 5);

  const ell = asciiMode ? '...' : '…';
  const errMark = asciiMode ? 'x' : '✕';
  const sep = asciiMode ? ' - ' : ' · ';
  const icon = asciiMode ? '*' : '★';

  const showDetail = innerHeight >= 10 && items.length > 0 && Boolean(currentItem);
  const statusRows = busy ? 1 : 0;
  const listHeight = Math.max(3, innerHeight - 2 - (showDetail ? 2 : 0) - statusRows);

  const subtitle = course && course.trim()
    ? `${t(lang, '课程', 'Course')}: ${course.trim()}`
    : t(lang, '全部课程', 'All courses');

  return (
    <Modal
      title={t(lang, '今日重读清单', 'Reread Marks Queue')}
      subtitle={subtitle}
      icon={icon}
      width={frameWidth}
      height={frameHeight}
      isActive={isActive}
      onClose={onClose}
      hints={hints}
    >
      {loading ? (
        <Box height={innerHeight} width={innerWidth} alignItems="center" justifyContent="center">
          <Spinner
            label={t(
              lang,
              asciiMode ? '正在加载待重读重点...' : '正在加载待重读重点…',
              asciiMode ? 'Loading reread marks queue...' : 'Loading reread marks queue…',
            )}
            active={isActive}
          />
        </Box>
      ) : error ? (
        <Box height={innerHeight} width={innerWidth} flexDirection="column" justifyContent="center" alignItems="center">
          <Text color={theme.error} bold>
            {`${errMark} ${error}`}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.muted}>
              {t(lang, '按 [r] 重试或 [Esc] 关闭。', 'Press [r] to retry or [Esc] to close.')}
            </Text>
          </Box>
        </Box>
      ) : items.length === 0 ? (
        <EmptyState
          title={t(lang, '今日暂无待重读标记', 'No marks due for reread today')}
          hint={t(
            lang,
            '在阅读器中用荧光笔或加粗标记重点，3 天后若所在章节有到期或薄弱题将出现在此。',
            'Highlight or bold passages in the reader; due/weak sections revisit after 3 days.',
          )}
          width={innerWidth}
          height={innerHeight}
        />
      ) : (
        <Box flexDirection="column" height={innerHeight} width={innerWidth}>
          <Box height={1} flexDirection="row" alignItems="center" width={innerWidth} marginBottom={1}>
            <Badge label={`${t(lang, '今日推荐', 'Due')} ${items.length}`} tone="accent" variant="soft" />
            {total > items.length ? (
              <>
                <Text> </Text>
                <Badge label={`${t(lang, '总候选', 'Total')} ${total}`} tone="muted" variant="outline" />
              </>
            ) : null}
            <Box flexGrow={1} />
            <Text color={theme.dim} wrap="truncate-end">
              {t(lang, 'Enter 打开阅读  r 标为已重读', 'Enter open reader  r mark seen')}
            </Text>
          </Box>

          <VirtualList
            items={items}
            height={listHeight}
            width={innerWidth}
            selectedIndex={selectedIndex}
            onChange={(idx) => setSelectedIndex(idx)}
            onSelect={(item) => handleOpen(item)}
            isActive={isActive && !busy}
            keyExtractor={(item) => `${item.id}:${item.selection?.sourceId ?? ''}`}
            renderItem={(item, ctx) => {
              const cursor = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
              const styleInfo = formatMarkStyle(item.style, lang);
              const styleTag = `[${styleInfo.short}] `;
              const pageLabel = item.page ?? item.selection?.page;
              const locParts: string[] = [];
              if (item.title) locParts.push(item.title);
              if (pageLabel) locParts.push(t(lang, `p.${pageLabel}`, `p.${pageLabel}`));
              if (item.section) locParts.push(item.section);
              const rawMeta = locParts.join(sep);

              const prefixW = displayWidth(cursor) + displayWidth(styleTag);
              const avail = Math.max(10, ctx.width - prefixW);
              const metaMax = Math.max(8, Math.min(Math.floor(avail * 0.45), displayWidth(rawMeta)));
              const metaStr = rawMeta ? truncateDisplay(rawMeta, metaMax, ell) : '';
              const quoteMax = Math.max(6, avail - (metaStr ? displayWidth(metaStr) + 2 : 0));
              const quote = compactQuote(item.selection?.quote) || t(lang, '(无摘录文本)', '(no quote)');
              const quoteStr = truncateDisplay(quote, quoteMax, ell);

              return (
                <Box flexDirection="row" width={ctx.width}>
                  <Text color={ctx.selected ? theme.primary : theme.muted}>{cursor}</Text>
                  <Text color={styleInfo.tone === 'warning' ? theme.warning : theme.accent} bold>
                    {styleTag}
                  </Text>
                  <Text color={theme.text} bold={ctx.selected}>
                    {quoteStr}
                  </Text>
                  <Box flexGrow={1} />
                  {metaStr ? <Text color={theme.dim}>{metaStr}</Text> : null}
                </Box>
              );
            }}
          />

          {showDetail && currentItem ? (
            <Box flexDirection="column" height={2} width={innerWidth}>
              <Text color={theme.muted} wrap="truncate-end">
                {truncateDisplay(
                  [
                    formatMarkStyle(currentItem.style, lang).label,
                    currentItem.title || t(lang, '未命名资料', 'Untitled'),
                    (currentItem.page ?? currentItem.selection?.page)
                      ? t(lang, `第 ${currentItem.page ?? currentItem.selection?.page} 页`, `Page ${currentItem.page ?? currentItem.selection?.page}`)
                      : '',
                    currentItem.section || '',
                    currentItem.risk
                      ? t(
                          lang,
                          `到期 ${currentItem.risk.due ?? 0} / 薄弱 ${currentItem.risk.weak ?? 0}`,
                          `due ${currentItem.risk.due ?? 0} / weak ${currentItem.risk.weak ?? 0}`,
                        )
                      : '',
                  ]
                    .filter(Boolean)
                    .join(sep),
                  Math.max(12, innerWidth),
                  ell,
                )}
              </Text>
              <Text color={theme.text} wrap="truncate-end">
                {truncateDisplay(
                  `"${compactQuote(currentItem.selection?.quote) || t(lang, '无摘录', 'No quote')}"`,
                  Math.max(12, innerWidth),
                  ell,
                )}
              </Text>
            </Box>
          ) : null}

          {busy ? (
            <Box height={1} width={innerWidth}>
              <Spinner
                label={t(
                  lang,
                  asciiMode ? '正在记录重读状态...' : '正在记录重读状态…',
                  asciiMode ? 'Recording reread status...' : 'Recording reread status…',
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
