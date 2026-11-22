import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useInput } from 'ink';
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  Panel,
  Spinner,
  useClaimKeys,
  useFooterHints,
  useTheme,
} from '../../components/index.js';
import { displayWidth, truncateDisplay } from '../../render/index.js';
import { currentCourse } from '../../shell/index.js';
import { t, useTuiStore } from '../../state/store.js';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { PomodoroBar, pomodoroBarHeight } from './PomodoroBar.js';
import {
  addCompletedPomodoro,
  adjacentColumn,
  BOARD_COLUMNS,
  boardFilePath,
  cardsInColumn,
  dueStatus,
  emptyBoard,
  loadBoardSafe,
  mergeUpstreamBoard,
  recordDeletedUpstreamIds,
  resolveUpstreamTargetColumn,
  saveBoard,
  type BoardCard,
  type BoardColumnId,
  type BoardDocument,
  type UpstreamBoardSnapshot,
} from './board-store.js';

const BoardCardModal = lazy(() => import('./BoardCardModal.js').then((m) => ({ default: m.BoardCardModal })));

type ActiveModal =
  | null
  | { type: 'add' }
  | { type: 'edit'; card: BoardCard }
  | { type: 'delete'; card: BoardCard };

const CLAIMED_KEYS = ['a', 'S', 'P', 'R', 'M', '+', '-', 'r'] as const;
const WIDE_BREAKPOINT = 78;

export const BoardView: React.FC<ViewProps> = memo(function BoardView({ host, width, height, isActive }) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);
  const focusCourse = currentCourse(snapshot);
  const libraryRoot = host.getLibraryRoot();

  const [doc, setDoc] = useState<BoardDocument>(() => emptyBoard());
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [readOnlyError, setReadOnlyError] = useState<string | null>(null);
  const [readOnlyPath, setReadOnlyPath] = useState<string>('');
  const [activeCol, setActiveCol] = useState<BoardColumnId>('todo');
  const [cursorByCol, setCursorByCol] = useState<Record<BoardColumnId, number>>({ todo: 0, doing: 0, done: 0 });
  const [modal, setModal] = useState<ActiveModal>(null);

  const mountedRef = useRef(true);
  const loadReqRef = useRef(0);
  const syncReqRef = useRef(0);
  const upstreamQueueRef = useRef<Promise<void>>(Promise.resolve());
  const docRef = useRef(doc);
  docRef.current = doc;
  const readOnlyErrorRef = useRef<string | null>(readOnlyError);
  readOnlyErrorRef.current = readOnlyError;

  const enqueueUpstream = useCallback((fn: () => Promise<void>) => {
    const next = upstreamQueueRef.current.then(fn, fn);
    upstreamQueueRef.current = next.catch(() => {});
    return next;
  }, []);

  const notifyReadOnlyError = useCallback(() => {
    notify(
      t(
        lang,
        '看板文件读取失败，已锁定只读防止覆盖原文件',
        'Board file unreadable; read-only lock active to avoid overwriting',
      ),
      'error',
    );
  }, [lang, notify]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persistDoc = useCallback(
    async (updater: (prev: BoardDocument) => BoardDocument) => {
      if (readOnlyErrorRef.current) {
        if (mountedRef.current) notifyReadOnlyError();
        return;
      }
      const nextDoc = updater(docRef.current);
      docRef.current = nextDoc;
      setDoc(nextDoc);
      try {
        const saved = await saveBoard(libraryRoot, nextDoc);
        if (mountedRef.current) {
          docRef.current = saved;
          setDoc(saved);
        }
      } catch (err) {
        if (mountedRef.current) {
          notify(err instanceof Error ? err.message : t(lang, '保存看板失败', 'Failed to save board'), 'error');
        }
      }
    },
    [libraryRoot, notify, lang, notifyReadOnlyError],
  );

  const syncUpstreamBoard = useCallback(
    async ({ notifyResult }: { notifyResult: boolean }) => {
      if (readOnlyErrorRef.current) {
        if (notifyResult && mountedRef.current) notifyReadOnlyError();
        return;
      }
      const reqId = ++syncReqRef.current;
      if (notifyResult) setSyncing(true);
      try {
        await enqueueUpstream(async () => {
          if (readOnlyErrorRef.current) return;
          const res = await host.call<UpstreamBoardSnapshot>('board.get', {});
          if (!mountedRef.current || syncReqRef.current !== reqId) return;
          if (!res.ok || !res.value) {
            if (notifyResult) {
              notify(res.error?.message || t(lang, '同步学习库看板失败', 'Failed to sync StudyHub board'), 'error');
            }
            return;
          }
          if (res.value.readOnly) {
            if (notifyResult) {
              notify(t(lang, '学习库看板当前为只读状态', 'StudyHub board is read-only'), 'warning');
            }
            return;
          }
          const upstreamSnapshot = res.value;
          const preview = mergeUpstreamBoard(
            docRef.current.cards,
            upstreamSnapshot,
            docRef.current.deletedUpstreamIds,
          );
          if (preview.changed) {
            await persistDoc((prev) => {
              const merged = mergeUpstreamBoard(prev.cards, upstreamSnapshot, prev.deletedUpstreamIds);
              if (!merged.changed) return prev;
              return {
                ...prev,
                version: 1,
                cards: merged.cards,
                updatedAt: new Date().toISOString(),
              };
            });
          }
          if (notifyResult && mountedRef.current) {
            notify(
              t(lang, `已同步 ${preview.syncedCount} 条学习库看板任务`, `Synced ${preview.syncedCount} StudyHub board tasks`),
              'success',
            );
          }
        });
      } catch (err) {
        if (notifyResult && mountedRef.current) {
          notify(
            err instanceof Error ? err.message : t(lang, '同步学习库看板失败', 'Failed to sync StudyHub board'),
            'error',
          );
        }
      } finally {
        if (notifyResult && mountedRef.current && syncReqRef.current === reqId) {
          setSyncing(false);
        }
      }
    },
    [host, lang, notify, persistDoc, notifyReadOnlyError, enqueueUpstream],
  );

  const syncUpstreamRef = useRef(syncUpstreamBoard);
  syncUpstreamRef.current = syncUpstreamBoard;

  const reloadBoard = useCallback(
    async ({ notifyOnReload = false }: { notifyOnReload?: boolean } = {}) => {
      const reqId = ++loadReqRef.current;
      setLoading(true);
      const res = await loadBoardSafe(libraryRoot);
      if (!mountedRef.current || loadReqRef.current !== reqId) return;
      setLoading(false);
      if (!res.ok) {
        readOnlyErrorRef.current = res.error;
        setReadOnlyError(res.error);
        setReadOnlyPath(res.path);
        docRef.current = res.doc;
        setDoc(res.doc);
        if (notifyOnReload) notifyReadOnlyError();
        return;
      }
      readOnlyErrorRef.current = null;
      setReadOnlyError(null);
      setReadOnlyPath('');
      docRef.current = res.doc;
      setDoc(res.doc);
      if (notifyOnReload) {
        notify(t(lang, '看板文件已重新加载', 'Board file reloaded'), 'success');
      }
      void syncUpstreamRef.current({ notifyResult: false });
    },
    [libraryRoot, lang, notify, notifyReadOnlyError],
  );

  const reloadBoardRef = useRef(reloadBoard);
  reloadBoardRef.current = reloadBoard;

  useEffect(() => {
    void reloadBoardRef.current({ notifyOnReload: false });
  }, [libraryRoot]);

  const updateUpstreamDirect = useCallback(
    async (upstreamCardId: string, patch: { column?: BoardColumnId; title?: string; due?: string }) => {
      if (readOnlyErrorRef.current) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const boardRes = await host.call<UpstreamBoardSnapshot>('board.get', {});
        if (!boardRes.ok || !boardRes.value || boardRes.value.readOnly) return;
        const upstream = boardRes.value;
        if (!upstream.cards || !Object.hasOwn(upstream.cards, upstreamCardId)) return;

        let revision = upstream.revision ?? 0;
        let retryConflict = false;

        if (patch.title !== undefined || patch.due !== undefined) {
          const editRes = await host.call<{ revision?: number }>('board.card.edit', {
            revision,
            id: upstreamCardId,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.due !== undefined ? { due: patch.due } : {}),
          });
          if (!editRes.ok) {
            if (editRes.error?.message && /revision conflict/i.test(editRes.error.message)) {
              retryConflict = true;
            } else {
              return;
            }
          } else if (typeof editRes.value?.revision === 'number') {
            revision = editRes.value.revision;
          }
        }

        if (!retryConflict && patch.column) {
          const targetUpstreamCol = resolveUpstreamTargetColumn(upstream.columns, patch.column);
          if (!targetUpstreamCol) return;
          const currentCol = upstream.columns?.find(
            (c) => Array.isArray(c.cardIds) && c.cardIds.includes(upstreamCardId),
          );
          if (currentCol?.id === targetUpstreamCol) return;
          const moveRes = await host.call('board.card.move', {
            revision,
            id: upstreamCardId,
            column: targetUpstreamCol,
          });
          if (!moveRes.ok && moveRes.error?.message && /revision conflict/i.test(moveRes.error.message)) {
            retryConflict = true;
          }
        }

        if (!retryConflict) return;
      }
    },
    [host],
  );

  const removeUpstreamDirect = useCallback(
    async (upstreamCardId: string) => {
      if (readOnlyErrorRef.current) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const boardRes = await host.call<UpstreamBoardSnapshot>('board.get', {});
        if (!boardRes.ok || !boardRes.value || boardRes.value.readOnly) return;
        const upstream = boardRes.value;
        const inOpen = Boolean(upstream.cards && Object.hasOwn(upstream.cards, upstreamCardId));
        const inArchived = Array.isArray(upstream.archived)
          ? upstream.archived.some((c) => c && c.id === upstreamCardId)
          : false;
        if (!inOpen && !inArchived) return;

        const rmRes = await host.call('board.card.remove', {
          revision: upstream.revision ?? 0,
          id: upstreamCardId,
        });
        if (rmRes.ok) return;
        if (!rmRes.error?.message || !/revision conflict/i.test(rmRes.error.message)) {
          return;
        }
      }
    },
    [host],
  );

  const addUpstreamDirect = useCallback(
    async (localCardId: string) => {
      if (readOnlyErrorRef.current) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const localNow = docRef.current.cards.find((c) => c.id === localCardId);
        if (!localNow || localNow.upstreamCardId) return;

        const boardRes = await host.call<UpstreamBoardSnapshot>('board.get', {});
        if (!boardRes.ok || !boardRes.value || boardRes.value.readOnly) return;
        const upstream = boardRes.value;
        const beforeIds = new Set(Object.keys(upstream.cards || {}));
        const targetUpstreamCol = resolveUpstreamTargetColumn(upstream.columns, localNow.column);

        const addRes = await host.call<UpstreamBoardSnapshot>('board.card.add', {
          revision: upstream.revision ?? 0,
          ...(targetUpstreamCol ? { column: targetUpstreamCol } : {}),
          title: localNow.title,
          due: localNow.dueDate || '',
          ...(localNow.course ? { labels: [localNow.course.slice(0, 60)] } : {}),
        });

        if (!addRes.ok) {
          if (addRes.error?.message && /revision conflict/i.test(addRes.error.message)) {
            continue;
          }
          return;
        }

        const afterCards = addRes.value?.cards || {};
        const createdId =
          Object.keys(afterCards).find((id) => !beforeIds.has(id)) ||
          (targetUpstreamCol
            ? addRes.value?.columns
                ?.find((c) => c.id === targetUpstreamCol)
                ?.cardIds?.slice()
                .reverse()
                .find((id) => !beforeIds.has(id))
            : undefined);
        if (!createdId) return;

        const latestLocal = docRef.current.cards.find((c) => c.id === localCardId);
        if (!latestLocal) {
          await persistDoc((prev) => ({
            ...prev,
            version: 1,
            deletedUpstreamIds: recordDeletedUpstreamIds(prev.deletedUpstreamIds, createdId),
            updatedAt: new Date().toISOString(),
          }));
          await removeUpstreamDirect(createdId);
          return;
        }

        await persistDoc((prev) => ({
          ...prev,
          version: 1,
          cards: prev.cards.map((c) => (c.id === localCardId ? { ...c, upstreamCardId: createdId } : c)),
          updatedAt: new Date().toISOString(),
        }));

        const colChanged = latestLocal.column !== localNow.column;
        const titleChanged = latestLocal.title !== localNow.title;
        const dueChanged = (latestLocal.dueDate || '') !== (localNow.dueDate || '');
        if (colChanged || titleChanged || dueChanged) {
          await updateUpstreamDirect(createdId, {
            ...(colChanged ? { column: latestLocal.column } : {}),
            ...(titleChanged ? { title: latestLocal.title } : {}),
            ...(dueChanged ? { due: latestLocal.dueDate || '' } : {}),
          });
        }
        return;
      }
    },
    [host, persistDoc, removeUpstreamDirect, updateUpstreamDirect],
  );

  const mirrorUpstreamUpdate = useCallback(
    (upstreamCardId: string, patch: { column?: BoardColumnId; title?: string; due?: string }) =>
      enqueueUpstream(() => updateUpstreamDirect(upstreamCardId, patch)),
    [enqueueUpstream, updateUpstreamDirect],
  );

  const grouped = useMemo(
    () => ({
      todo: cardsInColumn(doc.cards, 'todo'),
      doing: cardsInColumn(doc.cards, 'doing'),
      done: cardsInColumn(doc.cards, 'done'),
    }),
    [doc.cards],
  );

  const activeColCards = grouped[activeCol];
  const activeIdx = activeColCards.length > 0 ? Math.max(0, Math.min(cursorByCol[activeCol], activeColCards.length - 1)) : -1;
  const selectedCard = activeIdx >= 0 ? activeColCards[activeIdx] : null;

  const moveCard = useCallback(
    (card: BoardCard, targetCol: BoardColumnId) => {
      if (readOnlyErrorRef.current) {
        notifyReadOnlyError();
        return;
      }
      const now = new Date().toISOString();
      const targetLen = docRef.current.cards
        .map((c) => (c.id === card.id ? { ...c, column: targetCol } : c))
        .filter((c) => c.column === targetCol).length;
      setActiveCol(targetCol);
      setCursorByCol((prev) => ({
        ...prev,
        [card.column]: Math.max(0, Math.min(prev[card.column], Math.max(0, grouped[card.column].length - 2))),
        [targetCol]: Math.max(0, targetLen - 1),
      }));
      let resolvedUpstreamId = card.upstreamCardId;
      void persistDoc((prev) => {
        const latest = prev.cards.find((c) => c.id === card.id);
        if (!resolvedUpstreamId && latest?.upstreamCardId) resolvedUpstreamId = latest.upstreamCardId;
        return {
          ...prev,
          version: 1,
          cards: prev.cards.map((c) => (c.id === card.id ? { ...c, column: targetCol, updatedAt: now } : c)),
          updatedAt: now,
        };
      });
      if (resolvedUpstreamId && card.column !== targetCol) {
        void mirrorUpstreamUpdate(resolvedUpstreamId, { column: targetCol });
      }
    },
    [grouped, persistDoc, mirrorUpstreamUpdate, notifyReadOnlyError],
  );

  const noModalActive = isActive && modal === null;
  useClaimKeys(CLAIMED_KEYS, noModalActive);

  useInput(
    (input, key) => {
      if (input === 'r') {
        void reloadBoard({ notifyOnReload: true });
        return;
      }
      if (key.leftArrow || input === 'h') {
        const prevCol = adjacentColumn(activeCol, -1, true);
        if (prevCol) setActiveCol(prevCol);
        return;
      }
      if (key.rightArrow || input === 'l') {
        const nextCol = adjacentColumn(activeCol, 1, true);
        if (nextCol) setActiveCol(nextCol);
        return;
      }
      if (key.downArrow || input === 'j') {
        if (activeColCards.length === 0) return;
        setCursorByCol((prev) => ({
          ...prev,
          [activeCol]: Math.min(activeColCards.length - 1, activeIdx + 1),
        }));
        return;
      }
      if (key.upArrow || input === 'k') {
        if (activeColCards.length === 0) return;
        setCursorByCol((prev) => ({
          ...prev,
          [activeCol]: Math.max(0, activeIdx - 1),
        }));
        return;
      }
      if (input === 'a') {
        if (readOnlyErrorRef.current) {
          notifyReadOnlyError();
          return;
        }
        setModal({ type: 'add' });
        return;
      }
      if (input === 'S') {
        void syncUpstreamBoard({ notifyResult: true });
        return;
      }
      if (!selectedCard) return;
      if (input === 'H') {
        const leftCol = adjacentColumn(selectedCard.column, -1, false);
        if (leftCol) moveCard(selectedCard, leftCol);
        return;
      }
      if (input === 'L') {
        const rightCol = adjacentColumn(selectedCard.column, 1, false);
        if (rightCol) moveCard(selectedCard, rightCol);
        return;
      }
      if (input === 'm') {
        const nextCol = adjacentColumn(selectedCard.column, 1, true);
        if (nextCol) moveCard(selectedCard, nextCol);
        return;
      }
      if (input === 'e' || key.return) {
        if (readOnlyErrorRef.current) {
          notifyReadOnlyError();
          return;
        }
        setModal({ type: 'edit', card: selectedCard });
        return;
      }
      if (input === 'd') {
        if (readOnlyErrorRef.current) {
          notifyReadOnlyError();
          return;
        }
        setModal({ type: 'delete', card: selectedCard });
      }
    },
    { isActive: noModalActive },
  );

  const handleFocusComplete = useCallback(
    (minutes: number) => {
      if (readOnlyErrorRef.current) {
        notifyReadOnlyError();
        return;
      }
      void persistDoc((prev) => ({
        ...prev,
        version: 1,
        focusStats: addCompletedPomodoro(prev.focusStats, minutes),
        updatedAt: new Date().toISOString(),
      }));
      const ell = asciiMode ? '...' : '…';
      const cardSuffix = selectedCard ? ` (${truncateDisplay(selectedCard.title, 24, ell)})` : '';
      notify(
        t(lang, `专注完成！已记录 ${minutes} 分钟${cardSuffix}`, `Focus complete! +${minutes}m logged${cardSuffix}`),
        'success',
      );
    },
    [persistDoc, asciiMode, selectedCard, notify, lang, notifyReadOnlyError],
  );

  const hints: KeyHint[] = useMemo(
    () => [
      ...(readOnlyError ? [{ key: 'r', label: t(lang, '重载', 'Reload') }] : []),
      { key: 'h/l', label: t(lang, '切列', 'Col') },
      { key: 'j/k', label: t(lang, '移动', 'Nav') },
      { key: 'H/L/m', label: t(lang, '移列', 'Move') },
      { key: 'a', label: t(lang, '添加', 'Add') },
      { key: 'S', label: t(lang, '同步', 'Sync') },
      { key: 'e', label: t(lang, '编辑', 'Edit') },
      { key: 'd', label: t(lang, '删除', 'Del') },
      { key: 'Space/P', label: t(lang, '专注', 'Timer') },
      { key: 'M', label: t(lang, '模式', 'Mode') },
      { key: '+/-', label: t(lang, '时长', 'Min') },
      { key: 'R', label: t(lang, '重置', 'Reset') },
    ],
    [lang, readOnlyError],
  );
  useFooterHints(hints, isActive);

  const colMeta = useCallback(
    (col: BoardColumnId) => {
      if (col === 'todo') return { title: t(lang, '待办 Todo', 'Todo'), icon: asciiMode ? 'o' : '○', tone: 'info' as const };
      if (col === 'doing') return { title: t(lang, '进行中 Doing', 'Doing'), icon: asciiMode ? '~' : '◐', tone: 'warning' as const };
      return { title: t(lang, '已完成 Done', 'Done'), icon: asciiMode ? '+' : '●', tone: 'success' as const };
    },
    [lang, asciiMode],
  );

  const narrow = width < WIDE_BREAKPOINT;

  const renderColumnBody = (col: BoardColumnId, innerW: number, innerH: number) => {
    const cards = grouped[col];
    const isFocusedCol = activeCol === col;
    const cursor = cards.length > 0 ? Math.max(0, Math.min(cursorByCol[col], cards.length - 1)) : -1;

    if (loading && doc.cards.length === 0) {
      return (
        <Box height={innerH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '载入看板…', 'Loading board…')} active={isActive} />
        </Box>
      );
    }

    if (cards.length === 0) {
      return (
        <EmptyState
          title={t(lang, '空列', 'Empty')}
          hint={isFocusedCol ? t(lang, 'a 添加 / S 同步', 'a: add / S: sync') : undefined}
          icon="·"
          width={innerW}
          height={innerH}
        />
      );
    }

    // Each card takes 2 rows (title + optional meta/divider), or 1 row if height is very tight
    const rowPerCard = innerH >= 8 ? 2 : 1;
    const maxVisible = Math.max(1, Math.floor(innerH / rowPerCard));
    let start = 0;
    if (cards.length > maxVisible && cursor >= 0) {
      start = Math.max(0, Math.min(cards.length - maxVisible, cursor - Math.floor(maxVisible / 2)));
    }
    const visible = cards.slice(start, start + maxVisible);

    return (
      <Box flexDirection="column" width={innerW} height={innerH} overflow="hidden">
        {start > 0 ? <Text color={theme.dim}>{`  ↑ ${start}`}</Text> : null}
        {visible.map((card, i) => {
          const idx = start + i;
          const selected = isFocusedCol && idx === cursor;
          const lead = selected ? (asciiMode ? '> ' : '❯ ') : '  ';
          const isSynced = Boolean(card.upstreamCardId);
          const shPrefix = rowPerCard === 1 && isSynced ? (asciiMode ? '[SH] ' : '◈ ') : '';
          const titleLine = truncateDisplay(
            card.title,
            Math.max(6, innerW - displayWidth(lead) - displayWidth(shPrefix) - 1),
            asciiMode ? '...' : '…',
          );
          const status = dueStatus(card.dueDate, col);
          const dueColor =
            status === 'overdue'
              ? theme.error
              : status === 'today'
                ? theme.warning
                : status === 'done'
                  ? theme.dim
                  : theme.muted;

          if (rowPerCard === 1) {
            return (
              <Box key={card.id} height={1} width={innerW} backgroundColor={selected ? theme.selectionBg : undefined}>
                <Text color={selected ? theme.primary : theme.dim}>{lead}</Text>
                {shPrefix ? (
                  <Text color={selected ? theme.selectionFg : theme.info} bold={selected}>
                    {shPrefix}
                  </Text>
                ) : null}
                <Text color={selected ? theme.selectionFg : col === 'done' ? theme.muted : theme.text} bold={selected}>
                  {titleLine}
                </Text>
              </Box>
            );
          }

          return (
            <Box key={card.id} flexDirection="column" height={2} width={innerW}>
              <Box height={1} width={innerW} backgroundColor={selected ? theme.selectionBg : undefined}>
                <Text color={selected ? theme.primary : theme.dim}>{lead}</Text>
                <Text color={selected ? theme.selectionFg : col === 'done' ? theme.muted : theme.text} bold={selected}>
                  {titleLine}
                </Text>
              </Box>
              <Box height={1} width={innerW} paddingLeft={2} gap={1} overflow="hidden">
                {isSynced ? (
                  <Badge label={asciiMode ? 'SH' : '◈ SH'} tone="info" variant="soft" bold={false} />
                ) : null}
                {card.course ? (
                  <Badge
                    label={truncateDisplay(card.course, Math.max(4, Math.floor(innerW * (isSynced ? 0.35 : 0.45))))}
                    tone="accent"
                    variant="soft"
                    bold={false}
                  />
                ) : null}
                {card.dueDate ? (
                  <Text color={dueColor}>
                    {status === 'overdue' ? `! ${card.dueDate}` : `${asciiMode ? '@' : '◷'} ${card.dueDate}`}
                  </Text>
                ) : null}
                {!isSynced && !card.course && !card.dueDate ? <Text color={theme.dim}> </Text> : null}
              </Box>
            </Box>
          );
        })}
        {start + visible.length < cards.length ? (
          <Text color={theme.dim}>{`  ↓ ${cards.length - start - visible.length}`}</Text>
        ) : null}
      </Box>
    );
  };

  const renderModals = () => (
    <>
      <Suspense fallback={null}>
        {modal?.type === 'add' || modal?.type === 'edit' ? (
          <BoardCardModal
          mode={modal.type}
          lang={lang}
          initialColumn={activeCol}
          initialCourse={focusCourse || ''}
          card={modal.type === 'edit' ? modal.card : null}
          terminalCols={width}
          onClose={() => setModal(null)}
          onSubmit={(data) => {
            const now = new Date().toISOString();
            if (modal.type === 'add') {
              const nextCard: BoardCard = {
                id: randomUUID().slice(0, 12),
                title: data.title,
                column: data.column,
                ...(data.course ? { course: data.course } : {}),
                ...(data.dueDate ? { dueDate: data.dueDate } : {}),
                createdAt: now,
                updatedAt: now,
              };
              const targetCount = docRef.current.cards.filter((c) => c.column === data.column).length;
              setActiveCol(data.column);
              setCursorByCol((prev) => ({
                ...prev,
                [data.column]: targetCount,
              }));
              setModal(null);
              void persistDoc((prev) => ({
                ...prev,
                version: 1,
                cards: [...prev.cards, nextCard],
                updatedAt: now,
              }));
              void enqueueUpstream(() => addUpstreamDirect(nextCard.id));
              notify(t(lang, `已添加「${nextCard.title}」`, `Added "${nextCard.title}"`), 'success');
            } else {
              const target = modal.card;
              let resolvedUpstreamId = target.upstreamCardId;
              setActiveCol(data.column);
              setModal(null);
              void persistDoc((prev) => {
                const latest = prev.cards.find((c) => c.id === target.id);
                if (!resolvedUpstreamId && latest?.upstreamCardId) resolvedUpstreamId = latest.upstreamCardId;
                return {
                  ...prev,
                  version: 1,
                  cards: prev.cards.map((c) =>
                    c.id === target.id
                      ? {
                          id: c.id,
                          title: data.title,
                          column: data.column,
                          ...(data.course ? { course: data.course } : {}),
                          ...(data.dueDate ? { dueDate: data.dueDate } : {}),
                          ...(c.upstreamCardId ? { upstreamCardId: c.upstreamCardId } : {}),
                          createdAt: c.createdAt,
                          updatedAt: now,
                        }
                      : c,
                  ),
                  updatedAt: now,
                };
              });
              if (resolvedUpstreamId) {
                const titleChanged = data.title !== target.title;
                const dueChanged = (data.dueDate || '') !== (target.dueDate || '');
                const colChanged = data.column !== target.column;
                if (titleChanged || dueChanged || colChanged) {
                  void mirrorUpstreamUpdate(resolvedUpstreamId, {
                    ...(colChanged ? { column: data.column } : {}),
                    ...(titleChanged ? { title: data.title } : {}),
                    ...(dueChanged ? { due: data.dueDate || '' } : {}),
                  });
                }
              }
              notify(t(lang, '任务已更新', 'Card updated'), 'success');
            }
          }}
        />
        ) : null}
      </Suspense>

      {modal?.type === 'delete' ? (
        <ConfirmDialog
          title={t(lang, '删除任务', 'Delete Card')}
          message={t(lang, `确定删除任务「${modal.card.title}」吗？`, `Delete card "${modal.card.title}"?`)}
          confirmLabel={t(lang, '删除', 'Delete')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          onConfirm={() => {
            const gone = modal.card;
            setModal(null);
            setCursorByCol((prev) => ({
              ...prev,
              [gone.column]: Math.max(0, Math.min(prev[gone.column], Math.max(0, grouped[gone.column].length - 2))),
            }));
            let resolvedUpstreamId = gone.upstreamCardId;
            void persistDoc((prev) => {
              const latest = prev.cards.find((c) => c.id === gone.id);
              if (!resolvedUpstreamId && latest?.upstreamCardId) resolvedUpstreamId = latest.upstreamCardId;
              return {
                ...prev,
                version: 1,
                cards: prev.cards.filter((c) => c.id !== gone.id),
                ...(resolvedUpstreamId
                  ? { deletedUpstreamIds: recordDeletedUpstreamIds(prev.deletedUpstreamIds, resolvedUpstreamId) }
                  : {}),
                updatedAt: new Date().toISOString(),
              };
            });
            if (resolvedUpstreamId) {
              const targetUpstreamId = resolvedUpstreamId;
              void enqueueUpstream(() => removeUpstreamDirect(targetUpstreamId));
            }
            notify(t(lang, `已删除「${gone.title}」`, `Deleted "${gone.title}"`), 'success');
          }}
          onCancel={() => setModal(null)}
        />
      ) : null}
    </>
  );

  const barH = pomodoroBarHeight(width);
  const bannerH = readOnlyError ? 4 : 0;
  const ell = asciiMode ? '...' : '…';
  const resolvedBoardPath = readOnlyPath || boardFilePath(libraryRoot);
  const innerBannerW = Math.max(10, width - 4);
  const readOnlyBanner = readOnlyError ? (
    <Box
      flexDirection="column"
      width={width}
      height={4}
      borderStyle={asciiMode ? 'classic' : 'single'}
      borderColor={theme.error}
      paddingX={1}
      overflow="hidden"
    >
      <Text color={theme.error} bold wrap="truncate">
        {truncateDisplay(
          `${asciiMode ? '[!]' : '▲'} ${t(
            lang,
            '看板只读锁定: 修复/备份 tui-board.json 后按 [r] 重载',
            'Read-only lock: fix/backup tui-board.json then press [r] to reload',
          )}`,
          innerBannerW,
          ell,
        )}
      </Text>
      <Text color={theme.muted} wrap="truncate">
        {truncateDisplay(`${t(lang, '文件', 'File')}: ${resolvedBoardPath} (${readOnlyError})`, innerBannerW, ell)}
      </Text>
    </Box>
  ) : null;

  const pomodoroNode = (
    <PomodoroBar
      width={width}
      lang={lang}
      asciiMode={asciiMode}
      isActive={noModalActive}
      selectedCardTitle={selectedCard?.title}
      focusStats={doc.focusStats}
      onFocusComplete={handleFocusComplete}
    />
  );

  if (narrow) {
    const meta = colMeta(activeCol);
    const bodyH = Math.max(4, height - barH - bannerH - 1);
    return (
      <Box flexDirection="column" width={width} height={height}>
        {pomodoroNode}
        {readOnlyBanner}
        <Box height={1} width={width} gap={1} overflow="hidden">
          {BOARD_COLUMNS.map((col) => {
            const m = colMeta(col);
            const active = col === activeCol;
            return (
              <Text
                key={col}
                backgroundColor={active ? theme.surface : undefined}
                color={active ? theme.primary : theme.muted}
                bold={active}
              >
                {` ${active ? (asciiMode ? '*' : '●') : (asciiMode ? 'o' : '○')} ${m.title} (${grouped[col].length}) `}
              </Text>
            );
          })}
        </Box>
        <Panel
          title={meta.title}
          icon={meta.icon}
          badge={grouped[activeCol].length}
          badgeTone={meta.tone}
          subtitle={
            syncing
              ? t(lang, asciiMode ? '同步中...' : '同步中…', asciiMode ? 'Syncing...' : 'Syncing…')
              : `${doc.cards.length} ${t(lang, '项', 'total')}`
          }
          focused
          width={width}
          height={bodyH}
        >
          {renderColumnBody(activeCol, Math.max(10, width - 4), Math.max(2, bodyH - 3))}
        </Panel>
        {renderModals()}
      </Box>
    );
  }

  const gap = 1;
  const colW = Math.max(20, Math.floor((width - gap * 2) / 3));
  const lastColW = Math.max(20, width - colW * 2 - gap * 2);
  const colsH = Math.max(4, height - barH - bannerH);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {pomodoroNode}
      {readOnlyBanner}
      <Box flexDirection="row" width={width} height={colsH} gap={gap}>
        {BOARD_COLUMNS.map((col, idx) => {
          const m = colMeta(col);
          const w = idx === 2 ? lastColW : colW;
          return (
            <Panel
              key={col}
              title={m.title}
              icon={m.icon}
              badge={grouped[col].length}
              badgeTone={m.tone}
              focused={activeCol === col}
              width={w}
              height={colsH}
            >
              {renderColumnBody(col, Math.max(10, w - 4), Math.max(2, colsH - 3))}
            </Panel>
          );
        })}
      </Box>
      {renderModals()}
    </Box>
  );
});
