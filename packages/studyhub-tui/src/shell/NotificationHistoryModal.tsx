import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../components/resize.js';
import { KEY_LAYER_MODAL, useKeyScope } from '../components/key-dispatcher.js';
import { isPlainKey } from '../input/global-router.js';
import type { ToastItem } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { toneColor, useTheme } from '../theme/tokens.js';
import { padDisplay, truncateDisplay, wrapDisplay } from '../render/cjk.js';
import { Modal, modalContentWidth } from '../components/Modal.js';
import { VirtualList, pageStep } from '../components/VirtualList.js';
import { copyTextWithFallback } from '../render/clipboard.js';
import { hairline } from '../render/glyphs.js';

export interface NotificationHistoryModalProps {
  isActive: boolean;
  onClose: () => void;
}

const LEVEL_LABEL: Record<ToastItem['tone'], string> = {
  info: 'info',
  success: 'success',
  warning: 'warn',
  error: 'error',
};

function formatClock(createdAt: number): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return `${hh}:${mm}:${ss}`;
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

function firstLineOf(text: string): string {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.replace(/\s+/g, ' ').trim();
}

/** Logical line count (explicit newlines), matching what users call a multi-line notice. */
function logicalLineCount(text: string): number {
  return Math.max(1, (text ?? '').split('\n').length);
}

/**
 * Standalone notification history panel (#1354 P2-b).
 *
 * Recall the most recent `MAX_TOAST_HISTORY` notices even after their auto-dismiss toast is gone:
 * - `j`/`k` / `↑`/`↓` selects an entry (list shows first line + total line count, never truncates the message itself)
 * - `c` / `y` / `Enter` copies the selected entry in full via the shared OSC 52 clipboard helper
 * - `C` clears the history, `Ctrl+D` / `Ctrl+U` scroll the full multi-line detail pane
 * - `Esc` closes only this panel; the surrounding `<KeyScopeProvider opaque>` masks lower pages (#1429).
 */
export const NotificationHistoryModal = memo(function NotificationHistoryModal({
  isActive,
  onClose,
}: NotificationHistoryModalProps) {
  const theme = useTheme();
  const { columns, rows } = useStableWindowSize();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const history = useTuiStore((s) => s.toastHistory);
  const clearToastHistory = useTuiStore((s) => s.clearToastHistory);
  const bindingRoot = useTuiStore((s) => s.binding?.root);
  const snapshotRoot = useTuiStore((s) => s.snapshot?.root);
  const mountedRef = useRef(true);
  const [cursor, setCursor] = useState(0);
  const [detailTop, setDetailTop] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Newest first, matching the toast stack's visual order.
  const entries = useMemo(() => [...history].reverse(), [history]);
  const selectedIndex = Math.min(cursor, Math.max(0, entries.length - 1));
  const selected = entries[selectedIndex];

  useEffect(() => {
    if (cursor !== selectedIndex) setCursor(selectedIndex);
  }, [cursor, selectedIndex]);

  useEffect(() => {
    setDetailTop(0);
    setStatus('');
  }, [selected?.id]);

  const width = Math.min(92, Math.max(46, columns - 4));
  const height = Math.min(30, Math.max(14, rows - 4));
  const innerW = modalContentWidth(width);
  const bodyH = Math.max(4, height - 6);
  const sideBySide = innerW >= 76;
  const listW = sideBySide ? Math.max(24, Math.floor(innerW * 0.46)) : innerW;
  const detailW = sideBySide ? Math.max(16, innerW - listW - 1) : innerW;
  const detailH = sideBySide ? bodyH : Math.max(2, Math.floor((bodyH - 1) * 0.5));
  const ell = asciiMode ? '...' : '…';

  const detailLines = useMemo(() => {
    if (!selected) return [] as string[];
    const lines: string[] = [];
    const meta = `${formatClock(selected.createdAt)}  [${LEVEL_LABEL[selected.tone]}]${
      selected.source ? `  ${selected.source}` : ''
    }  ${logicalLineCount(selected.text)} ${t(lang, '行', 'lines')}`;
    lines.push(...wrapDisplay(meta, detailW));
    lines.push('');
    lines.push(...wrapDisplay(selected.text, detailW));
    return lines;
  }, [selected, lang, detailW]);

  const maxDetailTop = Math.max(0, detailLines.length - detailH);
  const detailTopClamped = Math.max(0, Math.min(detailTop, maxDetailTop));
  const detailView = detailLines.slice(detailTopClamped, detailTopClamped + detailH);

  const copySelected = useCallback(async () => {
    if (!selected) {
      setStatus(t(lang, '暂无可复制的通知', 'No notification to copy'));
      return;
    }
    const payload = `[${formatClock(selected.createdAt)}] [${LEVEL_LABEL[selected.tone]}]${
      selected.source ? ` [${selected.source}]` : ''
    }\n${selected.text}`;
    const res = await copyTextWithFallback(payload, {
      libraryRoot: bindingRoot || snapshotRoot || null,
    });
    if (!mountedRef.current) return;
    if (!res.ok) {
      setStatus(res.error || t(lang, '复制失败', 'Copy failed'));
    } else if (res.method === 'osc52') {
      setStatus(t(lang, `已复制（${res.chars} 字）`, `Copied (${res.chars} chars)`));
    } else {
      setStatus(
        t(lang, `已保存至 ${res.filePath}`, `Saved to ${res.filePath}`),
      );
    }
  }, [selected, lang, bindingRoot, snapshotRoot]);

  useKeyScope({
    id: 'NotificationHistoryModal:keys',
    active: isActive,
    layer: KEY_LAYER_MODAL,
    onKey: (input, key) => {
      if (key.ctrl && !key.meta && input === 'd') {
        setDetailTop((top) => Math.min(maxDetailTop, Math.max(0, top) + pageStep(detailH, 'half')));
        return true;
      }
      if (key.ctrl && !key.meta && input === 'u') {
        setDetailTop((top) => Math.max(0, Math.max(0, top) - pageStep(detailH, 'half')));
        return true;
      }
      if (key.pageDown) {
        setDetailTop((top) => Math.min(maxDetailTop, Math.max(0, top) + pageStep(detailH, 'full')));
        return true;
      }
      if (key.pageUp) {
        setDetailTop((top) => Math.max(0, Math.max(0, top) - pageStep(detailH, 'full')));
        return true;
      }
      if ((!key.ctrl && !key.meta && key.return) || (isPlainKey(input, key) && (input === 'c' || input === 'y'))) {
        void copySelected();
        return true;
      }
      if (isPlainKey(input, key) && input === 'C') {
        clearToastHistory();
        setCursor(0);
        setDetailTop(0);
        setStatus(t(lang, '已清空通知历史', 'History cleared'));
        return true;
      }
      // Esc falls through to <Modal>, which owns the single close action.
      return false;
    },
  });

  const hints = [
    { key: asciiMode ? 'Up/Dn' : '↑↓', label: t(lang, '选择', 'Select') },
    { key: 'c', label: t(lang, '复制', 'Copy') },
    { key: 'C', label: t(lang, '清空', 'Clear') },
    { key: 'Ctrl+D/U', label: t(lang, '滚动', 'Scroll') },
    { key: 'Esc', label: t(lang, '关闭', 'Close') },
  ];

  return (
    <Modal
      title={t(lang, '通知历史', 'Notification History')}
      icon={asciiMode ? 'N' : '🔔'}
      subtitle={t(
        lang,
        `最近 ${entries.length} 条`,
        `${entries.length} recent`,
      )}
      width={width}
      height={height}
      onClose={onClose}
      isActive={isActive}
      hints={hints}
    >
      <Box flexDirection="column" width={innerW} height={bodyH} overflow="hidden">
        <Box flexDirection={sideBySide ? 'row' : 'column'} width={innerW} height={bodyH} overflow="hidden">
          <Box width={listW} height={sideBySide ? bodyH : Math.max(2, bodyH - detailH - 1)} overflow="hidden" flexShrink={0}>
            <VirtualList
              items={entries}
              width={listW}
              height={sideBySide ? bodyH : Math.max(2, bodyH - detailH - 1)}
              selectedIndex={selectedIndex}
              onChange={(idx) => setCursor(idx)}
              onSelect={() => {
                void copySelected();
              }}
              isActive={isActive}
              keyExtractor={(item) => item.id}
              emptyText={t(lang, '暂无通知记录', 'No notifications yet')}
              emptyHint={t(
                lang,
                '提示消息会自动留存在这里，最多保留最近 50 条',
                'Recent toasts are kept here (last 50)',
              )}
              renderItem={(item, ctx) => {
                const level = LEVEL_LABEL[item.tone];
                const color = toneColor(theme, item.tone);
                const total = logicalLineCount(item.text);
                const countLabel = total > 1 ? `+${total - 1}` : '';
                const right = `${countLabel ? `${countLabel} ` : ''}${formatClock(item.createdAt)}`;
                const fixedW = 2 + level.length + 2 + right.length;
                const titleAvail = Math.max(6, ctx.width - fixedW);
                const rawTitle = firstLineOf(item.text) || t(lang, '(空消息)', '(empty)');
                const title = padDisplay(truncateDisplay(rawTitle, titleAvail, ell), titleAvail);
                return (
                  <Box width={ctx.width} height={1} overflow="hidden">
                    <Text color={color} bold={ctx.selected}>
                      {`[${level}]`}
                    </Text>
                    <Text> </Text>
                    <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                      {title}
                    </Text>
                    <Text color={theme.dim}>{right}</Text>
                  </Box>
                );
              }}
            />
          </Box>
          {!sideBySide ? (
            <Box height={1} width={innerW} overflow="hidden">
              <Text color={theme.border}>{hairline(innerW, asciiMode)}</Text>
            </Box>
          ) : null}
          <Box
            flexDirection="column"
            width={detailW}
            height={detailH}
            overflow="hidden"
            paddingLeft={sideBySide ? 1 : 0}
          >
            {detailView.length > 0 ? (
              detailView.map((line, idx) => (
                <Box key={`${selected?.id ?? 'none'}:${idx}`} height={1} overflow="hidden">
                  <Text color={idx === 0 ? theme.muted : theme.text}>{line || ' '}</Text>
                </Box>
              ))
            ) : (
              <Text color={theme.dim}>{t(lang, '选一条通知查看全文', 'Select a notification to read it')}</Text>
            )}
            {maxDetailTop > 0 ? (
              <Text color={theme.dim}>
                {t(
                  lang,
                  `  ${detailTopClamped + 1}-${Math.min(detailLines.length, detailTopClamped + detailH)}/${detailLines.length} 行`,
                  `  ${detailTopClamped + 1}-${Math.min(detailLines.length, detailTopClamped + detailH)}/${detailLines.length} lines`,
                )}
              </Text>
            ) : null}
          </Box>
        </Box>
        <Box height={1} width={innerW} overflow="hidden">
          <Text color={status ? theme.accent : theme.dim}>
            {status || t(lang, '提示消息按时间倒序排列，打开面板不会清空历史', 'Newest first; opening this panel never clears history')}
          </Text>
        </Box>
      </Box>
    </Modal>
  );
});
