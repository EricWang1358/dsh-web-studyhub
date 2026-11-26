import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../components/resize.js';
import { useKeyScope } from '../components/key-dispatcher.js';
import { isPlainKey } from '../input/global-router.js';
import type { HostClient, NavigationContext, PageId, UiLanguage } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { toneColor, useTheme, type Tone } from '../theme/tokens.js';
import { displayWidth, padDisplay, truncateDisplay, wrapDisplay } from '../render/cjk.js';
import { Modal, modalContentWidth } from '../components/Modal.js';
import { Spinner } from '../components/Badge.js';
import { TextInput } from '../components/TextInput.js';
import { VirtualList } from '../components/VirtualList.js';
import { atomicWriteExportJson, defaultBackupFilePath } from '../host/atomic-write.js';
import { tryAction } from '../host/sample-actions.js';
import { extractInboxData, type InboxEntry } from './data.js';
import { useShellActions } from './actions.js';
import { toastFirstLine, toastHistoryCopy, toastToneInboxKind, toastToneLabel } from './toast-copy.js';

export interface InboxModalProps {
  host: HostClient;
  isActive: boolean;
  onClose: () => void;
}

type InboxFilter = 'all' | 'unread' | 'read' | 'toasts';

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function inboxItemTone(kind: string): Tone {
  if (kind.endsWith('-failed')) return 'error';
  if (kind.includes('warning') || kind === 'pdf-held') return 'warning';
  if (
    kind === 'link' ||
    kind === 'variant' ||
    kind === 'grade' ||
    kind === 'passage-added' ||
    kind.endsWith('-result') ||
    kind.endsWith('-transcribe') ||
    kind.endsWith('-proofread') ||
    kind.endsWith('-translate')
  ) {
    return 'success';
  }
  if (kind === 'improve' || kind === 'rewrite' || kind === 'coach' || kind === 'followup' || kind === 'note') {
    return 'info';
  }
  return 'accent';
}

function formatRelativeTime(at: string | undefined, lang: UiLanguage): string {
  if (!at) return '';
  const ts = Date.parse(at);
  if (!Number.isFinite(ts)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return t(lang, '刚刚', 'now');
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  const days = Math.floor(sec / 86400);
  if (days < 30) return `${days}d`;
  return at.slice(0, 10);
}

/** Resolve navigation destination from `inbox.open` response and/or item metadata. */
export function resolveInboxTarget(
  item: InboxEntry,
  openResult?: unknown,
): { page: PageId; context: NavigationContext } | null {
  if (openResult && typeof openResult === 'object') {
    const r = openResult as Record<string, unknown>;
    const rKind = str(r.kind);
    const rSourceIds = Array.isArray(r.sourceIds) ? r.sourceIds.map((x) => str(x)).filter(Boolean) : [];
    if (rKind === 'note' || r.noteId) {
      return { page: 'notes', context: { noteId: str(r.noteId) || item.noteId } };
    }
    if (rKind === 'draft' || r.draftId) {
      return { page: 'generate', context: { draftId: str(r.draftId) || item.draftId } };
    }
    if (rKind === 'book') {
      const course = str(r.course) || item.course;
      return { page: 'book', context: course ? { course } : {} };
    }
    if (rKind === 'audio') {
      if (rSourceIds.length > 0) return { page: 'sources', context: { sourceId: rSourceIds[0] } };
      if (item.kind === 'audio-failed' && (r.jobId || item.jobId)) {
        return { page: 'tasks', context: { jobId: str(r.jobId) || item.jobId } };
      }
      return { page: 'audio', context: {} };
    }
    if (rKind === 'pdf') {
      if (rSourceIds.length > 0) return { page: 'sources', context: { sourceId: rSourceIds[0] } };
      if (r.jobId || item.jobId) return { page: 'tasks', context: { jobId: str(r.jobId) || item.jobId } };
      return { page: 'sources', context: {} };
    }
    if (typeof r.id === 'string' && r.id && (Array.isArray(r.entries) || r.card || r.mode)) {
      return { page: 'review', context: { runId: r.id } };
    }
  }

  if (item.kind === 'draft' || item.draftId) {
    return { page: 'generate', context: item.draftId ? { draftId: item.draftId } : {} };
  }
  if (item.kind === 'note' || item.noteId) {
    return { page: 'notes', context: item.noteId ? { noteId: item.noteId } : {} };
  }
  if (item.kind === 'book' || item.book) {
    return { page: 'book', context: item.course ? { course: item.course } : {} };
  }
  if (item.runId) {
    return { page: 'review', context: { runId: item.runId } };
  }
  if (item.sourceId || (item.sourceIds && item.sourceIds.length > 0)) {
    return { page: 'sources', context: { sourceId: item.sourceId || item.sourceIds![0] } };
  }
  if (item.jobId) {
    return { page: 'tasks', context: { jobId: item.jobId } };
  }
  if (item.deckId) {
    return { page: 'library', context: { deckId: item.deckId, ...(item.course ? { course: item.course } : {}) } };
  }
  return null;
}

export const InboxModal = memo(function InboxModal({ host, isActive, onClose }: InboxModalProps) {
  const theme = useTheme();
  const { columns, rows } = useStableWindowSize();
  const actions = useShellActions();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshotInbox = useTuiStore((s) => s.snapshot?.inbox);
  const toastHistory = useTuiStore((s) => s.toastHistory);
  const clearToastHistory = useTuiStore((s) => s.clearToastHistory);
  const bindingRoot = useTuiStore((s) => s.binding?.root);
  const snapshotRoot = useTuiStore((s) => s.snapshot?.root);

  const initialData = useMemo(() => extractInboxData(snapshotInbox as unknown), [snapshotInbox]);
  const [items, setItems] = useState<InboxEntry[]>(initialData.items);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [toastStatus, setToastStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isActive && searchFocused) setSearchFocused(false);
  }, [isActive, searchFocused]);

  // Keep synced with snapshot fallback if live fetch hasn't populated items yet.
  useEffect(() => {
    if (items.length === 0 && initialData.items.length > 0) {
      setItems(initialData.items);
    }
  }, [initialData.items, items.length]);

  const loadInbox = useCallback(
    async (explicit: boolean) => {
      setLoading(true);
      try {
        const res = await host.call('inbox', {});
        if (!mountedRef.current) return;
        if (res.ok && res.value) {
          setItems(extractInboxData(res.value).items);
        } else if (explicit) {
          useTuiStore
            .getState()
            .notify(res.error?.message || t(lang, '刷新收件箱失败', 'Failed to refresh inbox'), 'error');
        }
      } catch (err) {
        if (!mountedRef.current) return;
        if (explicit) {
          useTuiStore.getState().notify(err instanceof Error ? err.message : String(err), 'error');
        }
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [host, lang],
  );

  useEffect(() => {
    if (isActive) void loadInbox(false);
  }, [isActive, loadInbox]);

  const unreadCount = useMemo(() => items.filter((m) => !m.read).length, [items]);
  const readCount = items.length - unreadCount;
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const toastCopy = useMemo(() => toastHistoryCopy(lang), [lang]);

  const toastHistoryEntries = useMemo<InboxEntry[]>(() => {
    return [...toastHistory].reverse().map((item) => ({
      id: item.id,
      kind: toastToneInboxKind(item.tone),
      label: toastToneLabel(item.tone, lang),
      prompt: toastFirstLine(item.text) || toastCopy.emptyMessageFallback,
      promptFull: item.text,
      detail: '',
      detailFull: '',
      at: Number.isFinite(item.createdAt) ? new Date(item.createdAt).toISOString() : '',
      read: true,
      count: 1,
      missing: false,
      canRevert: false,
    }));
  }, [toastHistory, lang, toastCopy.emptyMessageFallback]);

  useEffect(() => {
    if (toastStatus && (filter !== 'toasts' || toastHistory.length > 0)) {
      setToastStatus('');
    }
  }, [toastStatus, filter, toastHistory.length]);

  const activeSource = useMemo(() => {
    if (filter === 'toasts') return toastHistoryEntries;
    if (filter === 'unread') return items.filter((m) => !m.read);
    if (filter === 'read') return items.filter((m) => m.read);
    return items;
  }, [items, toastHistoryEntries, filter]);

  const activeSourceLength = activeSource.length;

  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return activeSource;
    return activeSource.filter((m) =>
      [m.prompt, m.promptFull, m.deckTitle, m.filename, m.label, m.detail, m.detailFull, m.kind, m.course].some(
        (field) => typeof field === 'string' && field.toLowerCase().includes(normalizedQuery),
      ),
    );
  }, [activeSource, normalizedQuery]);

  const selectedIndex = Math.min(cursor, Math.max(0, filteredItems.length - 1));
  const selected = filteredItems[selectedIndex];

  useEffect(() => {
    if (cursor !== selectedIndex) setCursor(selectedIndex);
  }, [cursor, selectedIndex]);

  const handleToggleRead = useCallback(
    async (item: InboxEntry) => {
      if (busyRef.current || busy) return;
      busyRef.current = true;
      setBusy(true);
      const nextRead = !item.read;
      const action = nextRead ? 'inbox.read' : 'inbox.unread';
      try {
        const res = await host.call(action, { ids: [item.id] });
        if (!mountedRef.current) return;
        if (res.ok) {
          const parsed = res.value ? extractInboxData(res.value) : null;
          if (parsed && parsed.items.length > 0) {
            setItems(parsed.items);
          } else {
            setItems((prev) => prev.map((m) => (m.id === item.id ? { ...m, read: nextRead } : m)));
          }
          void actions.refresh();
        } else {
          useTuiStore
            .getState()
            .notify(res.error?.message || t(lang, '更新已读状态失败', 'Failed to update read state'), 'error');
        }
      } catch (err) {
        if (mountedRef.current) {
          useTuiStore.getState().notify(err instanceof Error ? err.message : String(err), 'error');
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, actions, lang],
  );

  const handleMarkAllRead = useCallback(async () => {
    if (busyRef.current || busy) return;
    if (unreadCount === 0) {
      useTuiStore.getState().notify(t(lang, '没有未读消息', 'No unread notifications'), 'info');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      let res = await host.call('inbox.mark', { all: true });
      if (!res.ok) {
        res = await host.call('inbox.read', { all: true });
      }
      if (!mountedRef.current) return;
      if (res.ok) {
        setItems((prev) => prev.map((m) => ({ ...m, read: true })));
        useTuiStore.getState().notify(t(lang, '已全部标为已读', 'Marked all as read'), 'success');
        void loadInbox(false);
        void actions.refresh();
      } else {
        useTuiStore
          .getState()
          .notify(res.error?.message || t(lang, '全部标为已读失败', 'Failed to mark all read'), 'error');
      }
    } catch (err) {
      if (mountedRef.current) {
        useTuiStore.getState().notify(err instanceof Error ? err.message : String(err), 'error');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, unreadCount, host, lang, loadInbox, actions]);

  const handleExportRaw = useCallback(async () => {
    if (busyRef.current || busy) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await tryAction<unknown>(host, 'inbox.raw', {});
      if (!mountedRef.current) return;
      if (!res.ok) {
        useTuiStore
          .getState()
          .notify(res.error?.message || t(lang, '导出收件箱失败', 'Failed to export inbox'), 'error');
        return;
      }
      const rawArray = Array.isArray(res.value)
        ? res.value
        : res.value && typeof res.value === 'object' && Array.isArray((res.value as { items?: unknown[] }).items)
          ? (res.value as { items: unknown[] }).items
          : [];
      const rawRoot =
        bindingRoot?.trim() ||
        host.getLibraryRoot?.()?.trim() ||
        host.getConfig?.()?.libraryRoot?.trim() ||
        snapshotRoot?.trim() ||
        '';
      const baseDir = rawRoot ? resolve(rawRoot) : process.cwd();
      const defaultPath = defaultBackupFilePath(
        baseDir,
        'studyhub-inbox',
        'json',
        filter !== 'all' ? filter : undefined,
      );
      const written = await atomicWriteExportJson(defaultPath, rawArray);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      useTuiStore
        .getState()
        .notify(
          t(
            lang,
            `已导出 ${rawArray.length} 条通知 ${arrow} ${written.path}`,
            `Exported ${rawArray.length} inbox item(s) ${arrow} ${written.path}`,
          ),
          'success',
        );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      useTuiStore.getState().notify(t(lang, `导出收件箱失败：${msg}`, `Failed to export inbox: ${msg}`), 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [asciiMode, bindingRoot, busy, filter, host, lang, snapshotRoot]);

  const handleOpen = useCallback(
    async (item: InboxEntry) => {
      if (busyRef.current || busy) return;
      if (item.missing) {
        if (!item.read) {
          void host.call('inbox.read', { ids: [item.id] }).then((res) => {
            if (mountedRef.current && res.ok) {
              setItems((prev) => prev.map((m) => (m.id === item.id ? { ...m, read: true } : m)));
              void actions.refresh();
            }
          });
        }
        useTuiStore
          .getState()
          .notify(t(lang, '该条通知关联的内容已不存在', 'Referenced item is no longer available'), 'warning');
        return;
      }

      busyRef.current = true;
      setBusy(true);
      try {
        const res = await host.call('inbox.open', { id: item.id });
        if (!mountedRef.current) return;
        if (!res.ok && !item.read) {
          await host.call('inbox.read', { ids: [item.id] }).catch(() => undefined);
        }
        const target = resolveInboxTarget(item, res.ok ? res.value : undefined);
        if (target) {
          setItems((prev) => prev.map((m) => (m.id === item.id ? { ...m, read: true } : m)));
          useTuiStore.getState().navigate(target.page, target.context);
          onClose();
          void actions.refresh();
          return;
        }
        if (!res.ok) {
          useTuiStore
            .getState()
            .notify(res.error?.message || t(lang, '无法打开该条通知', 'Cannot open notification'), 'error');
        } else {
          setItems((prev) => prev.map((m) => (m.id === item.id ? { ...m, read: true } : m)));
          void actions.refresh();
        }
      } catch (err) {
        if (mountedRef.current) {
          useTuiStore.getState().notify(err instanceof Error ? err.message : String(err), 'error');
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, host, actions, lang, onClose],
  );

  useKeyScope({
    id: 'InboxModal',
    active: isActive && !searchFocused,
    onKey: (input, key) => {
      if (busyRef.current || busy) return false;
      if (key.tab) {
        setFilter((prev) => (prev === 'all' ? 'unread' : prev === 'unread' ? 'read' : 'all'));
        setCursor(0);
        return true;
      }
      if (key.ctrl && !key.meta && input === 'r') {
        // The system layer already refreshes the snapshot on Ctrl+R (consume:false); reload only the inbox here.
        void loadInbox(true);
        return true;
      }
      if (!isPlainKey(input, key)) return false;
      if (input === 'h') {
        setFilter((prev) => (prev === 'toasts' ? 'all' : 'toasts'));
        setToastStatus('');
        setCursor(0);
        return true;
      }
      if (input === 'C' && filter === 'toasts') {
        if (toastHistoryEntries.length > 0) {
          clearToastHistory();
          setToastStatus(toastCopy.clearedStatus);
          setCursor(0);
        }
        return true;
      }
      if (input === '/') {
        setSearchFocused(true);
        return true;
      }
      if (input === 'c' && searchQuery) {
        setSearchQuery('');
        setCursor(0);
        return true;
      }
      if (input === 'e' && filter !== 'toasts') {
        void handleExportRaw();
        return true;
      }
      if (input === 'r') {
        void loadInbox(true);
        void actions.refresh();
        return true;
      }
      if (input === 'm' && filter !== 'toasts' && selected) {
        void handleToggleRead(selected);
        return true;
      }
      if (input === 'M' && filter !== 'toasts') {
        void handleMarkAllRead();
        return true;
      }
      return false;
    },
  });

  const width = Math.min(96, Math.max(46, columns - 4));
  const height = Math.min(30, Math.max(15, rows - 4));
  const innerW = modalContentWidth(width);
  const innerH = Math.max(8, Math.min(height, rows - 2) - 5);
  const ell = asciiMode ? '...' : '…';
  const sideBySide = innerW >= 72;
  const listW = sideBySide ? Math.floor(innerW * 0.52) : innerW;
  const previewW = sideBySide ? Math.max(16, innerW - listW - 1) : innerW;
  const bodyH = Math.max(4, innerH - 3);
  const listH = sideBySide ? bodyH : Math.max(3, Math.floor((bodyH - 1) * 0.56));
  const previewH = sideBySide ? bodyH : Math.max(2, bodyH - listH - 1);

  const tabs: ReadonlyArray<{ id: InboxFilter; label: string; count: number }> = [
    { id: 'all', label: t(lang, '全部', 'All'), count: items.length },
    { id: 'unread', label: t(lang, '未读', 'Unread'), count: unreadCount },
    { id: 'read', label: t(lang, '已读', 'Read'), count: readCount },
    { id: 'toasts', label: toastCopy.tabLabel, count: toastHistoryEntries.length },
  ];

  const previewLines = useMemo(() => {
    if (!selected) return [];
    const lines: string[] = [];
    const headerTitle = selected.promptFull || selected.prompt || selected.filename || selected.label;
    if (headerTitle) {
      lines.push(...wrapDisplay(headerTitle, Math.max(8, previewW)));
    }
    const body = selected.missing
      ? t(lang, '这道题或笔记已不在题库中。', 'This card or note is no longer in the library.')
      : selected.detailFull || selected.detail;
    if (body && body !== headerTitle) {
      if (lines.length > 0) lines.push('');
      lines.push(...wrapDisplay(body, Math.max(8, previewW)));
    }
    return lines;
  }, [selected, previewW, lang]);

  return (
    <Modal
      title={t(lang, '收件箱与通知', 'Notification Inbox')}
      icon={asciiMode ? 'M' : '✉'}
      subtitle={
        unreadCount > 0
          ? t(lang, `${unreadCount} 条未读`, `${unreadCount} unread`)
          : t(lang, '全部已读', 'All caught up')
      }
      width={width}
      height={height}
      onClose={onClose}
      isActive={isActive && !searchFocused}
      hints={
        searchFocused
          ? [
              { key: 'Enter', label: t(lang, '应用', 'Apply') },
              { key: 'Esc', label: t(lang, '清除', 'Clear') },
            ]
          : filter === 'toasts'
            ? [
                { key: '/', label: t(lang, '搜索', 'Search') },
                ...(searchQuery ? [{ key: 'c', label: t(lang, '重置', 'Clear') }] : []),
                ...(toastHistoryEntries.length > 0 ? [{ key: 'C', label: t(lang, '清空', 'Clear') }] : []),
                { key: 'h', label: t(lang, '收件箱', 'Inbox') },
                ...(sideBySide
                  ? [
                      { key: 'Tab', label: t(lang, '筛选', 'Filter') },
                      { key: 'r', label: t(lang, '刷新', 'Refresh') },
                    ]
                  : []),
                { key: 'Esc', label: t(lang, '关闭', 'Close') },
              ]
            : sideBySide
              ? [
                  { key: 'Enter', label: t(lang, '打开', 'Open') },
                  { key: '/', label: t(lang, '搜索', 'Search') },
                  ...(searchQuery ? [{ key: 'c', label: t(lang, '重置', 'Clear') }] : []),
                  { key: 'e', label: t(lang, '导出', 'Export') },
                  { key: 'm', label: t(lang, '已读', 'Read') },
                  { key: 'M', label: t(lang, '全读', 'All') },
                  { key: 'h', label: toastCopy.tabLabel },
                  { key: 'Tab', label: t(lang, '筛选', 'Filter') },
                  { key: 'r', label: t(lang, '刷新', 'Refresh') },
                  { key: 'Esc', label: t(lang, '关闭', 'Close') },
                ]
              : [
                  { key: 'Enter', label: t(lang, '打开', 'Open') },
                  { key: '/', label: t(lang, '搜索', 'Search') },
                  ...(searchQuery ? [{ key: 'c', label: t(lang, '重置', 'Clear') }] : []),
                  { key: 'h', label: toastCopy.tabLabel },
                  { key: 'e', label: t(lang, '导出', 'Export') },
                  { key: 'm', label: t(lang, '已读', 'Read') },
                  { key: 'Esc', label: t(lang, '关闭', 'Close') },
                ]
      }
    >
      <Box height={1} width={innerW} overflow="hidden">
        <Box flexGrow={1} overflow="hidden">
          {tabs.map((tab) => {
            const active = filter === tab.id;
            return (
              <Text key={tab.id}>
                <Text
                  backgroundColor={active ? theme.primary : theme.bg}
                  color={active ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
                  bold={active}
                >
                  {` ${tab.label} (${tab.count}) `}
                </Text>
                <Text> </Text>
              </Text>
            );
          })}
        </Box>
        {loading || busy ? (
          <Spinner tone="ai" label={t(lang, '同步', 'Sync')} />
        ) : filter === 'toasts' && toastStatus ? (
          <Text color={theme.accent}>{toastStatus}</Text>
        ) : null}
      </Box>

      <Box height={1} width={innerW} overflow="hidden" marginBottom={1}>
        <Text color={searchFocused ? theme.primary : theme.accent} bold={searchFocused}>
          {t(lang, '搜索 ', 'Search ')}
        </Text>
        <TextInput
          value={searchQuery}
          onChange={(val) => {
            setSearchQuery(val);
            setCursor(0);
          }}
          onSubmit={() => {
            setSearchFocused(false);
            setCursor(0);
          }}
          onCancel={() => {
            setSearchQuery('');
            setSearchFocused(false);
            setCursor(0);
          }}
          isActive={isActive && searchFocused && !busy}
          width={Math.max(12, innerW - 14)}
          placeholder={t(lang, `按 / 搜索关键词${ell}`, `Press / to filter${ell}`)}
        />
        {normalizedQuery ? <Text color={theme.dim}>{` ${filteredItems.length}/${activeSourceLength}`}</Text> : null}
      </Box>

      <Box flexDirection={sideBySide ? 'row' : 'column'} width={innerW} height={bodyH} overflow="hidden">
        <Box width={listW} height={listH} overflow="hidden" flexShrink={0}>
          <VirtualList
            items={filteredItems}
            width={listW}
            height={listH}
            selectedIndex={selectedIndex}
            onChange={(idx) => setCursor(idx)}
            onSelect={(item) => {
              if (filter === 'toasts') return;
              void handleOpen(item);
            }}
            isActive={isActive && !busy && !searchFocused}
            keyExtractor={(item) => item.id}
            emptyText={
              normalizedQuery
                ? t(lang, '没有匹配的通知', 'No matching notifications')
                : filter === 'toasts'
                  ? toastCopy.emptyTitle
                  : filter === 'unread'
                    ? t(lang, '没有未读通知', 'No unread notifications')
                    : filter === 'read'
                      ? t(lang, '暂无已读通知', 'No read notifications')
                      : t(lang, '信箱是空的', 'Inbox is empty')
            }
            emptyHint={
              normalizedQuery
                ? t(lang, '按 [c] 清除搜索或按 [/] 修改关键词', 'Press [c] to clear filter or [/] to edit query')
                : filter === 'toasts'
                  ? toastCopy.emptyHint
                  : t(lang, '后台任务或陪学回复完成后会投递到这里', 'Background jobs & coach replies appear here')
            }
            renderItem={(item, ctx) => {
              const dot = item.read ? '  ' : asciiMode ? '* ' : '● ';
              const dotColor = item.read ? theme.dim : theme.primary;
              const tone = toneColor(theme, inboxItemTone(item.kind));
              const badgeRaw = truncateDisplay(item.label, 10, ell);
              const badgeText = `[${badgeRaw}]`;
              const ago = formatRelativeTime(item.at, lang);
              const countStr = item.count > 1 ? ` x${item.count}` : '';
              const rightStr = `${countStr}${ago ? ` ${ago}` : ''}`;
              const fixedW = 2 + displayWidth(badgeText) + 1 + displayWidth(rightStr) + 1;
              const titleAvail = Math.max(4, ctx.width - fixedW);
              const rawTitle = item.missing
                ? t(lang, '(已删除)', '(deleted)')
                : item.prompt || item.deckTitle || item.detail || item.id;
              const title = padDisplay(truncateDisplay(rawTitle.replace(/\s+/g, ' '), titleAvail, ell), titleAvail);
              return (
                <Box width={ctx.width} height={1} overflow="hidden">
                  <Text color={dotColor} bold={!item.read}>
                    {dot}
                  </Text>
                  <Text color={tone} bold={!item.read}>
                    {badgeText}
                  </Text>
                  <Text> </Text>
                  <Text color={ctx.selected ? theme.selectionFg : item.read ? theme.muted : theme.text} bold={ctx.selected || !item.read}>
                    {title}
                  </Text>
                  <Text color={theme.dim}>{rightStr}</Text>
                </Box>
              );
            }}
          />
        </Box>

        {sideBySide ? (
          <Box width={1} height={bodyH} flexDirection="column" flexShrink={0}>
            {Array.from({ length: bodyH }, (_, i) => (
              <Text key={i} color={theme.border}>
                {asciiMode ? '|' : '│'}
              </Text>
            ))}
          </Box>
        ) : (
          <Box height={1} width={innerW} overflow="hidden" flexShrink={0}>
            <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(innerW)}</Text>
          </Box>
        )}

        <Box width={previewW} height={previewH} flexDirection="column" overflow="hidden" flexShrink={0}>
          {selected ? (
            <>
              <Box height={1} width={previewW} overflow="hidden" flexShrink={0}>
                <Text color={toneColor(theme, inboxItemTone(selected.kind))} bold>
                  {`[${truncateDisplay(selected.label, 14, ell)}]`}
                </Text>
                {filter !== 'toasts' ? (
                  <Text color={selected.read ? theme.dim : theme.warning}>
                    {selected.read ? t(lang, ' 已读', ' Read') : t(lang, ' 未读', ' Unread')}
                  </Text>
                ) : null}
                {selected.deckTitle ? (
                  <Text color={theme.muted}>
                    {truncateDisplay(` ${asciiMode ? '-' : '·'} ${selected.deckTitle}`, Math.max(0, previewW - 24), ell)}
                  </Text>
                ) : null}
              </Box>
              {selected.at ? (
                <Box height={1} width={previewW} overflow="hidden" flexShrink={0}>
                  <Text color={theme.dim}>
                    {truncateDisplay(
                      `${formatRelativeTime(selected.at, lang)}  ${selected.at.slice(0, 16).replace('T', ' ')}`,
                      previewW,
                      ell,
                    )}
                  </Text>
                </Box>
              ) : null}
              <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={previewH >= 5 ? 1 : 0}>
                {previewLines.slice(0, Math.max(1, previewH - (selected.at ? 2 : 1) - (previewH >= 5 ? 1 : 0))).map((line, idx) => (
                  <Box key={idx} height={1} overflow="hidden">
                    <Text color={selected.missing ? theme.warning : theme.text}>{truncateDisplay(line, previewW, ell)}</Text>
                  </Box>
                ))}
              </Box>
            </>
          ) : (
            <Box flexGrow={1} alignItems="center" justifyContent="center">
              <Text color={theme.dim}>
                {filter === 'toasts'
                  ? toastCopy.selectToRead
                  : t(lang, '选择一条通知查看详情', 'Select a notification to preview')}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    </Modal>
  );
});
