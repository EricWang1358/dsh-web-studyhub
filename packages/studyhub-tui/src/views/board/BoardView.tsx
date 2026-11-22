import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Box, Text, useInput } from 'ink';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { parseSgrWheelDelta, useSgrMouseWheel } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { useFooterHints } from '../../components/hooks.js';
import { useTheme } from '../../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { currentCourse } from '../../shell/data.js';
import { t, useTuiStore } from '../../state/store.js';
import type { KeyHint, UiLanguage, ViewProps } from '../../types/contracts.js';
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
  todayLocalYmd,
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

type BoardCardMeta = BoardCard & {
  description?: unknown;
  priority?: unknown;
  tags?: unknown;
  due?: unknown;
};

const CLAIMED_KEYS = ['a', 'S', 'P', 'R', 'M', '+', '-', 'r', '/', 'x'] as const;
const WIDE_BREAKPOINT = 78;
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function cleanSingleLine(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\r?\n+/g, ' ').trim() : '';
}

function extractCardTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => cleanSingleLine(item)).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function cardMatchesFilter(card: BoardCard, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const meta = card as BoardCardMeta;
  if (card.title.toLowerCase().includes(normalizedQuery)) return true;
  if (card.course && card.course.toLowerCase().includes(normalizedQuery)) return true;
  const desc = cleanSingleLine(meta.description);
  if (desc && desc.toLowerCase().includes(normalizedQuery)) return true;
  const tags = extractCardTags(meta.tags);
  return tags.some((tag) => tag.toLowerCase().includes(normalizedQuery));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || '';
      if (!RETRY_CODES.has(code) || attempt >= 5) throw error;
      await new Promise((done) => setTimeout(done, 40 * (attempt + 1)));
    }
  }
}

async function atomicWriteTextFile(targetPath: string, text: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temp, text, 'utf8');
  try {
    await renameWithRetry(temp, targetPath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Pure helper generating GFM Markdown for a Kanban board snapshot (0 LLM tokens). */
export function formatBoardMarkdown(doc: BoardDocument, lang: UiLanguage = 'en'): string {
  const cards = Array.isArray(doc?.cards) ? doc.cards : [];
  const grouped: Record<BoardColumnId, BoardCard[]> = {
    todo: cardsInColumn(cards, 'todo'),
    doing: cardsInColumn(cards, 'doing'),
    done: cardsInColumn(cards, 'done'),
  };

  const pomodoros = Math.max(0, Math.floor(doc?.focusStats?.completedPomodoros ?? 0));
  const minutes = Math.max(0, Math.floor(doc?.focusStats?.focusedMinutes ?? 0));
  const exportDate = todayLocalYmd();

  const lines: string[] = ['# StudyHub Kanban Board', ''];
  if (lang === 'zh') {
    lines.push(
      `> 导出日期: ${exportDate} | 任务总计: ${cards.length} (待办: ${grouped.todo.length}, 进行中: ${grouped.doing.length}, 已完成: ${grouped.done.length}) | 番茄专注: ${pomodoros} 次 (${minutes} 分钟)`,
    );
  } else {
    lines.push(
      `> Exported: ${exportDate} | Cards: ${cards.length} (Todo: ${grouped.todo.length}, Doing: ${grouped.doing.length}, Done: ${grouped.done.length}) | Pomodoro: ${pomodoros} (${minutes}m)`,
    );
  }

  const sectionHeading = (col: BoardColumnId): string => {
    if (col === 'todo') return t(lang, '## 待办 Todo', '## Todo');
    if (col === 'doing') return t(lang, '## 进行中 Doing', '## Doing');
    return t(lang, '## 已完成 Done', '## Done');
  };

  for (const col of BOARD_COLUMNS) {
    lines.push('', sectionHeading(col), '');
    const colCards = grouped[col];
    if (colCards.length === 0) {
      lines.push(t(lang, '_（暂无）_', '_(none)_'));
      continue;
    }
    const checkbox = col === 'done' ? '[x]' : '[ ]';
    for (const card of colCards) {
      const meta = card as BoardCardMeta;
      const title = cleanSingleLine(card.title) || card.id;
      const priority = cleanSingleLine(meta.priority);
      const course = cleanSingleLine(card.course);
      const dueDate = cleanSingleLine(card.dueDate) || cleanSingleLine(meta.due);
      const tags = extractCardTags(meta.tags);
      const rawDesc = cleanSingleLine(meta.description);
      const desc = rawDesc.length > 240 ? `${rawDesc.slice(0, 237)}...` : rawDesc;

      const metaParts: string[] = [];
      if (priority) metaParts.push(lang === 'zh' ? `优先级:${priority}` : `priority:${priority}`);
      if (course) metaParts.push(lang === 'zh' ? `课程:${course}` : `course:${course}`);
      if (dueDate) metaParts.push(lang === 'zh' ? `截止:${dueDate}` : `due:${dueDate}`);
      if (tags.length > 0) metaParts.push(`tags:${tags.map((tag) => `#${tag}`).join(' ')}`);

      const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(' | ')})` : '';
      lines.push(`- ${checkbox} ${title}${metaSuffix}`);
      if (desc) {
        lines.push(`  > ${desc}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

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
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);

  const mountedRef = useRef(true);
  const loadReqRef = useRef(0);
  const syncReqRef = useRef(0);
  const exportBusyRef = useRef(false);
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

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const filteredCards = useMemo(
    () => (normalizedFilter ? doc.cards.filter((c) => cardMatchesFilter(c, normalizedFilter)) : doc.cards),
    [doc.cards, normalizedFilter],
  );

  const grouped = useMemo(
    () => ({
      todo: cardsInColumn(filteredCards, 'todo'),
      doing: cardsInColumn(filteredCards, 'doing'),
      done: cardsInColumn(filteredCards, 'done'),
    }),
    [filteredCards],
  );

  useEffect(() => {
    setCursorByCol((prev) => {
      const nextTodo = grouped.todo.length > 0 ? Math.max(0, Math.min(prev.todo, grouped.todo.length - 1)) : 0;
      const nextDoing = grouped.doing.length > 0 ? Math.max(0, Math.min(prev.doing, grouped.doing.length - 1)) : 0;
      const nextDone = grouped.done.length > 0 ? Math.max(0, Math.min(prev.done, grouped.done.length - 1)) : 0;
      if (nextTodo === prev.todo && nextDoing === prev.doing && nextDone === prev.done) return prev;
      return { todo: nextTodo, doing: nextDoing, done: nextDone };
    });
  }, [grouped.todo.length, grouped.doing.length, grouped.done.length]);

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
      const nextPreview = docRef.current.cards.map((c) => (c.id === card.id ? { ...c, column: targetCol } : c));
      const visibleTargetCards = (
        normalizedFilter ? nextPreview.filter((c) => cardMatchesFilter(c, normalizedFilter)) : nextPreview
      ).filter((c) => c.column === targetCol);
      const targetIdx = visibleTargetCards.findIndex((c) => c.id === card.id);
      setActiveCol(targetCol);
      setCursorByCol((prev) => ({
        ...prev,
        [card.column]: Math.max(0, Math.min(prev[card.column], Math.max(0, grouped[card.column].length - 2))),
        [targetCol]: targetIdx >= 0 ? targetIdx : Math.max(0, visibleTargetCards.length - 1),
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
    [grouped, normalizedFilter, persistDoc, mirrorUpstreamUpdate, notifyReadOnlyError],
  );

  const handleExportMarkdown = useCallback(async () => {
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    try {
      const currentDoc = docRef.current;
      const markdown = formatBoardMarkdown(currentDoc, lang);
      const baseDir = libraryRoot?.trim() ? resolve(libraryRoot.trim()) : process.cwd();
      const targetPath = join(baseDir, 'backups', `studyhub-board-${todayLocalYmd()}.md`);
      await atomicWriteTextFile(targetPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(
          lang,
          `已导出 ${currentDoc.cards.length} 张卡片 ${arrow} ${targetPath}`,
          `Exported ${currentDoc.cards.length} cards ${arrow} ${targetPath}`,
        ),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      notify(t(lang, `导出看板失败: ${msg}`, `Failed to export board: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [asciiMode, lang, libraryRoot, notify]);

  const moveCursorByWheel = useCallback(
    (delta: number) => {
      if (delta === 0) return;
      const step = delta > 0 ? Math.max(1, Math.round(delta / 3)) : Math.min(-1, Math.round(delta / 3));
      setCursorByCol((prev) => {
        const len = grouped[activeCol].length;
        if (len === 0) return prev;
        const cur = Math.max(0, Math.min(prev[activeCol], len - 1));
        const next = Math.max(0, Math.min(len - 1, cur + step));
        if (next === prev[activeCol]) return prev;
        return { ...prev, [activeCol]: next };
      });
    },
    [activeCol, grouped],
  );

  const noModalActive = isActive && modal === null;
  const boardNavActive = noModalActive && !filterEditing;
  useClaimKeys(CLAIMED_KEYS, noModalActive);
  useSgrMouseWheel(boardNavActive, moveCursorByWheel);

  useInput(
    (input, key) => {
      const wheelDelta = parseSgrWheelDelta(input);
      if (wheelDelta !== 0) {
        moveCursorByWheel(wheelDelta);
        return;
      }
      if (key.escape && filterQuery) {
        setFilterQuery('');
        return;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        setFilterEditing(true);
        return;
      }
      if (input === 'x' && !key.ctrl && !key.meta) {
        void handleExportMarkdown();
        return;
      }
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
    { isActive: boardNavActive },
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

  const hints: KeyHint[] = useMemo(() => {
    if (filterEditing) {
      return [
        { key: 'Enter', label: t(lang, '确认', 'Apply') },
        { key: 'Esc', label: t(lang, '清除', 'Clear') },
      ];
    }
    return [
      ...(readOnlyError ? [{ key: 'r', label: t(lang, '重载', 'Reload') }] : []),
      { key: 'h/l', label: t(lang, '切列', 'Col') },
      { key: 'j/k', label: t(lang, '移动', 'Nav') },
      { key: 'H/L/m', label: t(lang, '移列', 'Move') },
      { key: 'a', label: t(lang, '添加', 'Add') },
      { key: '/', label: t(lang, '过滤', 'Filter') },
      ...(filterQuery ? [{ key: 'Esc', label: t(lang, '清过滤', 'Clear') }] : []),
      { key: 'x', label: t(lang, '导出', 'Export') },
      { key: 'S', label: t(lang, '同步', 'Sync') },
      { key: 'e', label: t(lang, '编辑', 'Edit') },
      { key: 'd', label: t(lang, '删除', 'Del') },
      { key: 'Space/P', label: t(lang, '专注', 'Timer') },
      { key: 'M', label: t(lang, '模式', 'Mode') },
      { key: '+/-', label: t(lang, '时长', 'Min') },
      { key: 'R', label: t(lang, '重置', 'Reset') },
    ];
  }, [filterEditing, filterQuery, lang, readOnlyError]);
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
          <Spinner
            label={asciiMode ? t(lang, '载入看板...', 'Loading board...') : t(lang, '载入看板…', 'Loading board…')}
            active={isActive}
          />
        </Box>
      );
    }

    if (cards.length === 0) {
      return (
        <EmptyState
          title={normalizedFilter ? t(lang, '无匹配任务', 'No matches') : t(lang, '空列', 'Empty')}
          hint={
            normalizedFilter
              ? isFocusedCol
                ? t(lang, 'Esc 清除过滤', 'Esc: clear filter')
                : undefined
              : isFocusedCol
                ? t(lang, 'a 添加 / S 同步', 'a: add / S: sync')
                : undefined
          }
          icon={asciiMode ? '.' : '·'}
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
        {start > 0 ? <Text color={theme.dim}>{`  ${asciiMode ? '^' : '↑'} ${start}`}</Text> : null}
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
                    label={truncateDisplay(
                      card.course,
                      Math.max(4, Math.floor(innerW * (isSynced ? 0.35 : 0.45))),
                      asciiMode ? '...' : '…',
                    )}
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
          <Text color={theme.dim}>{`  ${asciiMode ? 'v' : '↓'} ${cards.length - start - visible.length}`}</Text>
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
  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarH = showFilterBar ? 1 : 0;
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

  const filterBadge = `[${filterEditing ? t(lang, '过滤', 'Filter') : t(lang, '已过滤', 'Filtered')} ${filteredCards.length}/${doc.cards.length}] `;
  const filterRightHint =
    width >= 66
      ? ` ${filterEditing ? t(lang, 'Enter 确认 | Esc 清除', 'Enter apply | Esc clear') : t(lang, '/ 编辑 | Esc 清除', '/ edit | Esc clear')}`
      : width >= 46
        ? ' Esc'
        : '';
  const filterInputW = Math.max(8, width - 2 - displayWidth(filterBadge) - displayWidth(filterRightHint) - 3);
  const filterBarNode = showFilterBar ? (
    <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
      <Text color={filterEditing ? theme.primary : theme.accent} bold>
        {filterBadge}
      </Text>
      <Box flexGrow={1} overflow="hidden">
        <TextInput
          value={filterQuery}
          onChange={(val) => setFilterQuery(val)}
          onSubmit={(val) => {
            if (!val.trim()) setFilterQuery('');
            setFilterEditing(false);
          }}
          onCancel={() => {
            setFilterQuery('');
            setFilterEditing(false);
          }}
          isActive={noModalActive && filterEditing}
          width={filterInputW}
          prompt="/"
          placeholder={t(lang, `关键词${ell}`, `keyword${ell}`)}
          maxLength={120}
        />
      </Box>
      {filterRightHint ? (
        <Text color={theme.dim} wrap="truncate">
          {filterRightHint}
        </Text>
      ) : null}
    </Box>
  ) : null;

  const pomodoroNode = (
    <PomodoroBar
      width={width}
      lang={lang}
      asciiMode={asciiMode}
      isActive={boardNavActive}
      selectedCardTitle={selectedCard?.title}
      focusStats={doc.focusStats}
      onFocusComplete={handleFocusComplete}
    />
  );

  if (narrow) {
    const meta = colMeta(activeCol);
    const bodyH = Math.max(4, height - barH - bannerH - filterBarH - 1);
    return (
      <Box flexDirection="column" width={width} height={height}>
        {pomodoroNode}
        {readOnlyBanner}
        {filterBarNode}
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
              : normalizedFilter
                ? `${filteredCards.length}/${doc.cards.length} ${t(lang, '匹配', 'match')}`
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
  const colsH = Math.max(4, height - barH - bannerH - filterBarH);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {pomodoroNode}
      {readOnlyBanner}
      {filterBarNode}
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
