import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { BoardCardModal } from './BoardCardModal.js';
import {
  adjacentColumn,
  BOARD_COLUMNS,
  cardsInColumn,
  dueStatus,
  emptyBoard,
  loadBoard,
  saveBoard,
  type BoardCard,
  type BoardColumnId,
  type BoardDocument,
} from './board-store.js';

type ActiveModal =
  | null
  | { type: 'add' }
  | { type: 'edit'; card: BoardCard }
  | { type: 'delete'; card: BoardCard };

const CLAIMED_KEYS = ['a'] as const;
const WIDE_BREAKPOINT = 78;

export const BoardView: React.FC<ViewProps> = memo(function BoardView({ host, width, height, isActive }) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);
  const focusCourse = currentCourse(snapshot);
  const libraryRoot = host.getLibraryRoot();

  const [doc, setDoc] = useState<BoardDocument>(() => emptyBoard());
  const [loading, setLoading] = useState(true);
  const [activeCol, setActiveCol] = useState<BoardColumnId>('todo');
  const [cursorByCol, setCursorByCol] = useState<Record<BoardColumnId, number>>({ todo: 0, doing: 0, done: 0 });
  const [modal, setModal] = useState<ActiveModal>(null);

  const mountedRef = useRef(true);
  const loadReqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const reqId = ++loadReqRef.current;
    setLoading(true);
    void loadBoard(libraryRoot).then((loaded) => {
      if (!mountedRef.current || loadReqRef.current !== reqId) return;
      setDoc(loaded);
      setLoading(false);
    });
  }, [libraryRoot]);

  const persist = useCallback(
    async (nextCards: BoardCard[]) => {
      const nextDoc: BoardDocument = {
        version: 1,
        cards: nextCards,
        updatedAt: new Date().toISOString(),
      };
      setDoc(nextDoc);
      try {
        const saved = await saveBoard(libraryRoot, nextDoc);
        if (mountedRef.current) setDoc(saved);
      } catch (err) {
        if (mountedRef.current) {
          notify(err instanceof Error ? err.message : t(lang, '保存看板失败', 'Failed to save board'), 'error');
        }
      }
    },
    [libraryRoot, notify, lang],
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
      const now = new Date().toISOString();
      const updated = doc.cards.map((c) => (c.id === card.id ? { ...c, column: targetCol, updatedAt: now } : c));
      const targetLen = updated.filter((c) => c.column === targetCol).length;
      setActiveCol(targetCol);
      setCursorByCol((prev) => ({
        ...prev,
        [card.column]: Math.max(0, Math.min(prev[card.column], Math.max(0, grouped[card.column].length - 2))),
        [targetCol]: Math.max(0, targetLen - 1),
      }));
      void persist(updated);
    },
    [doc.cards, grouped, persist],
  );

  const noModalActive = isActive && modal === null;
  useClaimKeys(CLAIMED_KEYS, noModalActive);

  useInput(
    (input, key) => {
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
        setModal({ type: 'add' });
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
        setModal({ type: 'edit', card: selectedCard });
        return;
      }
      if (input === 'd') {
        setModal({ type: 'delete', card: selectedCard });
      }
    },
    { isActive: noModalActive },
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'h/l', label: t(lang, '切列', 'Col') },
      { key: 'j/k', label: t(lang, '移动', 'Nav') },
      { key: 'H/L/m', label: t(lang, '移列', 'Move') },
      { key: 'a', label: t(lang, '添加', 'Add') },
      { key: 'e', label: t(lang, '编辑', 'Edit') },
      { key: 'd', label: t(lang, '删除', 'Del') },
    ],
    [lang],
  );
  useFooterHints(hints, isActive);

  const colMeta = useCallback(
    (col: BoardColumnId) => {
      if (col === 'todo') return { title: t(lang, '待办 Todo', 'Todo'), icon: '○', tone: 'info' as const };
      if (col === 'doing') return { title: t(lang, '进行中 Doing', 'Doing'), icon: '◐', tone: 'warning' as const };
      return { title: t(lang, '已完成 Done', 'Done'), icon: '●', tone: 'success' as const };
    },
    [lang],
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
          hint={isFocusedCol ? t(lang, '按 a 添加任务', 'Press a to add') : undefined}
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
          const lead = selected ? '❯ ' : '  ';
          const titleLine = truncateDisplay(card.title, Math.max(6, innerW - displayWidth(lead) - 1));
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
                {card.course ? <Badge label={truncateDisplay(card.course, Math.max(6, Math.floor(innerW * 0.45)))} tone="accent" variant="soft" bold={false} /> : null}
                {card.dueDate ? (
                  <Text color={dueColor}>
                    {status === 'overdue' ? `! ${card.dueDate}` : `◷ ${card.dueDate}`}
                  </Text>
                ) : null}
                {!card.course && !card.dueDate ? <Text color={theme.dim}> </Text> : null}
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
              const nextCards = [...doc.cards, nextCard];
              setActiveCol(data.column);
              setCursorByCol((prev) => ({
                ...prev,
                [data.column]: nextCards.filter((c) => c.column === data.column).length - 1,
              }));
              setModal(null);
              void persist(nextCards);
              notify(t(lang, `已添加「${nextCard.title}」`, `Added "${nextCard.title}"`), 'success');
            } else {
              const target = modal.card;
              const nextCards = doc.cards.map((c) =>
                c.id === target.id
                  ? {
                      id: c.id,
                      title: data.title,
                      column: data.column,
                      ...(data.course ? { course: data.course } : {}),
                      ...(data.dueDate ? { dueDate: data.dueDate } : {}),
                      createdAt: c.createdAt,
                      updatedAt: now,
                    }
                  : c,
              );
              setActiveCol(data.column);
              setModal(null);
              void persist(nextCards);
              notify(t(lang, '任务已更新', 'Card updated'), 'success');
            }
          }}
        />
      ) : null}

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
            const nextCards = doc.cards.filter((c) => c.id !== gone.id);
            setCursorByCol((prev) => ({
              ...prev,
              [gone.column]: Math.max(0, Math.min(prev[gone.column], Math.max(0, grouped[gone.column].length - 2))),
            }));
            void persist(nextCards);
            notify(t(lang, `已删除「${gone.title}」`, `Deleted "${gone.title}"`), 'success');
          }}
          onCancel={() => setModal(null)}
        />
      ) : null}
    </>
  );

  if (narrow) {
    const meta = colMeta(activeCol);
    const bodyH = Math.max(4, height - 2);
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box height={1} width={width} gap={1}>
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
                {` ${active ? '●' : '○'} ${m.title} (${grouped[col].length}) `}
              </Text>
            );
          })}
        </Box>
        <Panel
          title={meta.title}
          icon={meta.icon}
          badge={grouped[activeCol].length}
          badgeTone={meta.tone}
          subtitle={`${doc.cards.length} ${t(lang, '项', 'total')}`}
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

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="row" width={width} height={height} gap={gap}>
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
              height={height}
            >
              {renderColumnBody(col, Math.max(10, w - 4), Math.max(2, height - 3))}
            </Panel>
          );
        })}
      </Box>
      {renderModals()}
    </Box>
  );
});
