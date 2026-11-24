import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import { atomicWriteExportText, defaultBackupFilePath } from '../../host/atomic-write.js';
import { runAtomicSteps } from '../../host/tx-write.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Panel } from '../../components/Panel.js';
import { TextInput } from '../../components/TextInput.js';
import { parseSgrWheelDelta, useSgrMouseWheel } from '../../components/VirtualList.js';
import { useClaimKeys } from '../../components/focus.js';
import { computeFilterBarLayout } from '../../components/layout-tokens.js';
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
  createBoardSaveCoordinator,
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
  type BoardSaveCoordinator,
  type UpstreamBoardSnapshot,
} from './board-store.js';

const BoardCardModal = lazy(() => import('./BoardCardModal.js').then((m) => ({ default: m.BoardCardModal })));

type ActiveModal =
  | null
  | { type: 'add' }
  | { type: 'edit'; card: BoardCard }
  | { type: 'delete'; card: BoardCard };

type PendingUpstreamOp =
  | { kind: 'add'; localCardId: string }
  | { kind: 'update'; upstreamCardId: string; patch: { column?: BoardColumnId; title?: string; due?: string } }
  | { kind: 'remove'; upstreamCardId: string };

type BoardCardMeta = BoardCard & {
  description?: unknown;
  priority?: unknown;
  tags?: unknown;
  due?: unknown;
};

const CLAIMED_KEYS = ['a', 'S', 'P', 'R', 'M', '+', '-', '/', 'x'] as const;
const WIDE_BREAKPOINT = 78;

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
  const [upstreamReadOnly, setUpstreamReadOnly] = useState(false);
  const [upstreamSyncError, setUpstreamSyncError] = useState<{ count: number; message: string } | null>(null);
  const [activeCol, setActiveCol] = useState<BoardColumnId>('todo');
  const [cursorByCol, setCursorByCol] = useState<Record<BoardColumnId, number>>({ todo: 0, doing: 0, done: 0 });
  const [modal, setModal] = useState<ActiveModal>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);

  const isReadOnly = Boolean(readOnlyError) || upstreamReadOnly;

  const mountedRef = useRef(true);
  const loadReqRef = useRef(0);
  const syncReqRef = useRef(0);
  const exportBusyRef = useRef(false);
  const upstreamQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingUpstreamOpsRef = useRef<Map<string, PendingUpstreamOp>>(new Map());
  const inflightUpstreamIdsRef = useRef<Map<string, number>>(new Map());
  const saveCoordRef = useRef<{ root: string; coord: BoardSaveCoordinator } | null>(null);
  if (!saveCoordRef.current || saveCoordRef.current.root !== libraryRoot) {
    const targetRoot = libraryRoot;
    saveCoordRef.current = {
      root: targetRoot,
      coord: createBoardSaveCoordinator({
        initialDoc: emptyBoard(),
        saveFn: (nextDoc) => saveBoard(targetRoot, nextDoc),
      }),
    };
  }
  const docRef = useRef(doc);
  docRef.current = saveCoordRef.current.coord.getDoc();
  const readOnlyErrorRef = useRef<string | null>(readOnlyError);
  readOnlyErrorRef.current = readOnlyError;
  const upstreamReadOnlyRef = useRef<boolean>(upstreamReadOnly);
  upstreamReadOnlyRef.current = upstreamReadOnly;
  const isReadOnlyRef = useRef<boolean>(isReadOnly);
  isReadOnlyRef.current = isReadOnly;

  const enqueueUpstream = useCallback((fn: () => Promise<unknown>) => {
    const next = upstreamQueueRef.current.then(fn, fn);
    upstreamQueueRef.current = next.then(() => undefined, () => undefined);
    return next;
  }, []);

  const markInflightUpstream = useCallback((upstreamCardId: string) => {
    const prev = inflightUpstreamIdsRef.current.get(upstreamCardId) ?? 0;
    inflightUpstreamIdsRef.current.set(upstreamCardId, prev + 1);
  }, []);

  const unmarkInflightUpstream = useCallback((upstreamCardId: string) => {
    const prev = inflightUpstreamIdsRef.current.get(upstreamCardId) ?? 0;
    if (prev <= 1) inflightUpstreamIdsRef.current.delete(upstreamCardId);
    else inflightUpstreamIdsRef.current.set(upstreamCardId, prev - 1);
  }, []);

  const getProtectedUpstreamIds = useCallback(() => {
    const protectedIds = new Set<string>();
    for (const op of pendingUpstreamOpsRef.current.values()) {
      if (op.kind === 'update' || op.kind === 'remove') {
        protectedIds.add(op.upstreamCardId);
      }
    }
    for (const [id, count] of inflightUpstreamIdsRef.current.entries()) {
      if (count > 0) protectedIds.add(id);
    }
    return protectedIds;
  }, []);

  const recordUpstreamFailure = useCallback(
    (key: string, op: PendingUpstreamOp, message: string, shouldNotify = true) => {
      const existing = pendingUpstreamOpsRef.current.get(key);
      if (existing && existing.kind === 'update' && op.kind === 'update') {
        pendingUpstreamOpsRef.current.set(key, {
          kind: 'update',
          upstreamCardId: op.upstreamCardId,
          patch: { ...existing.patch, ...op.patch },
        });
      } else {
        pendingUpstreamOpsRef.current.set(key, op);
      }
      if (mountedRef.current) {
        setUpstreamSyncError({ count: pendingUpstreamOpsRef.current.size, message });
        if (shouldNotify) {
          notify(
            t(
              lang,
              `同步写回学习库看板失败（${message}），已保留本地改动，按 [S] 重试`,
              `Upstream board writeback failed (${message}); local edits kept — press [S] to retry`,
            ),
            'warning',
          );
        }
      }
    },
    [lang, notify],
  );

  const clearUpstreamFailure = useCallback((key: string) => {
    if (!pendingUpstreamOpsRef.current.delete(key)) return;
    if (!mountedRef.current) return;
    if (pendingUpstreamOpsRef.current.size === 0) {
      setUpstreamSyncError(null);
    } else {
      setUpstreamSyncError((prev) =>
        prev ? { count: pendingUpstreamOpsRef.current.size, message: prev.message } : null,
      );
    }
  }, []);

  const notifyReadOnly = useCallback(() => {
    if (readOnlyErrorRef.current) {
      notify(
        t(
          lang,
          '看板文件读取失败，已锁定只读防止覆盖原文件',
          'Board file unreadable; read-only lock active to avoid overwriting',
        ),
        'error',
      );
      return;
    }
    notify(
      t(
        lang,
        '学习库看板当前为只读状态，已禁止编辑与同步',
        'StudyHub board is read-only; edits and sync are disabled',
      ),
      'warning',
    );
  }, [lang, notify]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());

  const persistDoc = useCallback(
    async (updater: (prev: BoardDocument) => BoardDocument) => {
      if (isReadOnlyRef.current) {
        if (mountedRef.current) notifyReadOnly();
        return;
      }
      const coord = saveCoordRef.current!.coord;
      await coord.persist(
        updater,
        (nextDoc) => {
          docRef.current = nextDoc;
          if (mountedRef.current) setDoc(nextDoc);
        },
        (err) => {
          if (mountedRef.current) {
            notify(err instanceof Error ? err.message : t(lang, '保存看板失败', 'Failed to save board'), 'error');
          }
        },
      );
    },
    [notify, lang, notifyReadOnly],
  );

  const syncUpstreamBoard = useCallback(
    async ({ notifyResult }: { notifyResult: boolean }) => {
      if (isReadOnlyRef.current) {
        if (notifyResult && mountedRef.current) notifyReadOnly();
        return;
      }
      const reqId = ++syncReqRef.current;
      if (notifyResult) setSyncing(true);
      try {
        await enqueueUpstream(async () => {
          if (isReadOnlyRef.current) return;
          const retryStatus =
            pendingUpstreamOpsRef.current.size > 0
              ? await retryPendingUpstreamOpsRef.current()
              : { remaining: 0, lastError: null };
          if (isReadOnlyRef.current) return;
          const res = await host.call<UpstreamBoardSnapshot>('board.get', {});
          if (!mountedRef.current || syncReqRef.current !== reqId) return;
          if (!res.ok || !res.value) {
            if (notifyResult) {
              notify(res.error?.message || t(lang, '同步学习库看板失败', 'Failed to sync StudyHub board'), 'error');
            }
            return;
          }
          if (res.value.readOnly) {
            upstreamReadOnlyRef.current = true;
            isReadOnlyRef.current = true;
            setUpstreamReadOnly(true);
            if (notifyResult) notifyReadOnly();
            return;
          }
          if (upstreamReadOnlyRef.current) {
            upstreamReadOnlyRef.current = false;
            isReadOnlyRef.current = Boolean(readOnlyErrorRef.current);
            setUpstreamReadOnly(false);
          }
          const protectedUpstreamIds = getProtectedUpstreamIds();
          const upstreamSnapshot = res.value;
          const currentLocal = saveCoordRef.current!.coord.getDoc();
          const preview = mergeUpstreamBoard(
            currentLocal.cards,
            upstreamSnapshot,
            currentLocal.deletedUpstreamIds,
            protectedUpstreamIds,
          );
          if (preview.changed) {
            await persistDoc((prev) => {
              const latestProtected = getProtectedUpstreamIds();
              const merged = mergeUpstreamBoard(
                prev.cards,
                upstreamSnapshot,
                prev.deletedUpstreamIds,
                latestProtected,
              );
              if (!merged.changed) return prev;
              return {
                ...prev,
                version: 1,
                cards: merged.cards,
                updatedAt: new Date().toISOString(),
              };
            });
          }
          await saveCoordRef.current?.coord.flush();
          if (notifyResult && mountedRef.current) {
            if (retryStatus.remaining > 0) {
              notify(
                t(
                  lang,
                  `仍有 ${retryStatus.remaining} 条本地改动未能写回学习库看板（${retryStatus.lastError || '写入失败'}），已保留本地版本`,
                  `${retryStatus.remaining} local board edit(s) still failed to write back (${retryStatus.lastError || 'write failed'}); local state preserved`,
                ),
                'warning',
              );
            } else {
              notify(
                t(lang, `已同步 ${preview.syncedCount} 条学习库看板任务`, `Synced ${preview.syncedCount} StudyHub board tasks`),
                'success',
              );
            }
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
    [host, lang, notify, persistDoc, notifyReadOnly, enqueueUpstream, getProtectedUpstreamIds],
  );

  const syncUpstreamRef = useRef(syncUpstreamBoard);
  syncUpstreamRef.current = syncUpstreamBoard;

  const reloadBoard = useCallback(
    async ({ notifyOnReload = false }: { notifyOnReload?: boolean } = {}) => {
      const reqId = ++loadReqRef.current;
      setLoading(true);
      await saveCoordRef.current?.coord.flush();
      const res = await loadBoardSafe(libraryRoot);
      if (!mountedRef.current || loadReqRef.current !== reqId) return;
      setLoading(false);
      upstreamReadOnlyRef.current = false;
      setUpstreamReadOnly(false);
      if (!res.ok) {
        readOnlyErrorRef.current = res.error;
        isReadOnlyRef.current = true;
        setReadOnlyError(res.error);
        setReadOnlyPath(res.path);
        saveCoordRef.current?.coord.replaceDoc(res.doc);
        docRef.current = res.doc;
        setDoc(res.doc);
        if (notifyOnReload) notifyReadOnly();
        return;
      }
      readOnlyErrorRef.current = null;
      isReadOnlyRef.current = false;
      setReadOnlyError(null);
      setReadOnlyPath('');
      saveCoordRef.current?.coord.replaceDoc(res.doc);
      docRef.current = res.doc;
      setDoc(res.doc);
      if (notifyOnReload) {
        notify(t(lang, '看板文件已重新加载', 'Board file reloaded'), 'success');
      }
      void syncUpstreamRef.current({ notifyResult: false });
    },
    [libraryRoot, lang, notify, notifyReadOnly],
  );

  const reloadBoardRef = useRef(reloadBoard);
  reloadBoardRef.current = reloadBoard;

  useEffect(() => {
    void reloadBoardRef.current({ notifyOnReload: false });
  }, [libraryRoot]);

  const updateUpstreamDirect = useCallback(
    async (
      upstreamCardId: string,
      patch: { column?: BoardColumnId; title?: string; due?: string },
      opts: { notifyOnFailure?: boolean } = {},
    ): Promise<{ ok: boolean; error?: string }> => {
      const notifyOnFailure = opts.notifyOnFailure ?? true;
      const opKey = `update:${upstreamCardId}`;
      if (isReadOnlyRef.current) return { ok: false, error: 'readOnly' };
      let lastError = t(lang, '修订冲突，写回未完成', 'Revision conflict; writeback incomplete');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const boardRes = await host.call<UpstreamBoardSnapshot>('board.get', {});
        if (!boardRes.ok || !boardRes.value) {
          lastError = boardRes.error?.message || t(lang, '无法读取学习库看板', 'Failed to read upstream board');
          recordUpstreamFailure(opKey, { kind: 'update', upstreamCardId, patch }, lastError, notifyOnFailure);
          return { ok: false, error: lastError };
        }
        if (boardRes.value.readOnly) {
          upstreamReadOnlyRef.current = true;
          isReadOnlyRef.current = true;
          if (mountedRef.current) setUpstreamReadOnly(true);
          if (notifyOnFailure && mountedRef.current) notifyReadOnly();
          return { ok: false, error: 'readOnly' };
        }
        const upstream = boardRes.value;
        if (!upstream.cards || !Object.hasOwn(upstream.cards, upstreamCardId)) {
          lastError = t(lang, '远端任务不存在或已被移除', 'Upstream card not found');
          recordUpstreamFailure(opKey, { kind: 'update', upstreamCardId, patch }, lastError, notifyOnFailure);
          return { ok: false, error: lastError };
        }

        let revision = upstream.revision ?? 0;
        let retryConflict = false;
        let editApplied = false;
        const prevUpstreamCard = upstream.cards[upstreamCardId] as { title?: string; due?: string } | undefined;

        const steps: Array<{
          name: string;
          run: () => Promise<{ ok: boolean; value?: number; error?: string }>;
          rollback?: (rev: unknown) => Promise<void>;
        }> = [];

        if (patch.title !== undefined || patch.due !== undefined) {
          steps.push({
            name: 'board.card.edit',
            run: async () => {
              const editRes = await host.call<{ revision?: number }>('board.card.edit', {
                revision,
                id: upstreamCardId,
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...(patch.due !== undefined ? { due: patch.due } : {}),
              });
              if (!editRes.ok) {
                return { ok: false, error: editRes.error?.message || t(lang, '更新远端任务失败', 'Failed to edit upstream card') };
              }
              editApplied = true;
              if (typeof editRes.value?.revision === 'number') {
                revision = editRes.value.revision;
              }
              return { ok: true, value: revision };
            },
            rollback: async (revAfterEdit) => {
              if (!prevUpstreamCard) return;
              const rbRes = await host.call('board.card.edit', {
                revision: typeof revAfterEdit === 'number' ? revAfterEdit : revision,
                id: upstreamCardId,
                ...(patch.title !== undefined && prevUpstreamCard.title !== undefined ? { title: prevUpstreamCard.title } : {}),
                ...(patch.due !== undefined ? { due: prevUpstreamCard.due ?? '' } : {}),
              });
              if (!rbRes.ok) {
                throw new Error(rbRes.error?.message || 'rollback edit failed');
              }
              editApplied = false;
            },
          });
        }

        if (patch.column) {
          const targetCol = patch.column;
          steps.push({
            name: 'board.card.move',
            run: async () => {
              const targetUpstreamCol = resolveUpstreamTargetColumn(upstream.columns, targetCol);
              if (!targetUpstreamCol) {
                return { ok: false, error: t(lang, '未找到对应的远端看板列', 'Target upstream column not found') };
              }
              const currentCol = upstream.columns?.find(
                (c) => Array.isArray(c.cardIds) && c.cardIds.includes(upstreamCardId),
              );
              if (currentCol?.id === targetUpstreamCol) return { ok: true, value: revision };
              const moveRes = await host.call('board.card.move', {
                revision,
                id: upstreamCardId,
                column: targetUpstreamCol,
              });
              if (!moveRes.ok) {
                return { ok: false, error: moveRes.error?.message || t(lang, '移动远端任务失败', 'Failed to move upstream card') };
              }
              return { ok: true, value: revision };
            },
          });
        }

        const tx = await runAtomicSteps(steps);
        if (!tx.ok) {
          if (/revision conflict/i.test(tx.error)) {
            lastError = tx.error;
            retryConflict = true;
          } else {
            const remainingPatch = editApplied && patch.column ? { column: patch.column } : patch;
            lastError = editApplied
              ? t(lang, `任务内容已更新，但列移动失败：${tx.error}`, `Card details updated, but column move failed: ${tx.error}`)
              : tx.error;
            recordUpstreamFailure(opKey, { kind: 'update', upstreamCardId, patch: remainingPatch }, lastError, notifyOnFailure);
            return { ok: false, error: lastError };
          }
        }

        if (!retryConflict) {
          clearUpstreamFailure(opKey);
          return { ok: true };
        }
      }
      recordUpstreamFailure(opKey, { kind: 'update', upstreamCardId, patch }, lastError, notifyOnFailure);
      return { ok: false, error: lastError };
    },
    [host, lang, notifyReadOnly, recordUpstreamFailure, clearUpstreamFailure],
  );

  const removeUpstreamDirect = useCallback(
    async (
      upstreamCardId: string,
      opts: { notifyOnFailure?: boolean } = {},
    ): Promise<{ ok: boolean; error?: string }> => {
      const notifyOnFailure = opts.notifyOnFailure ?? true;
      const opKey = `remove:${upstreamCardId}`;
      clearUpstreamFailure(`update:${upstreamCardId}`);
      if (isReadOnlyRef.current) return { ok: false, error: 'readOnly' };
      let lastError = t(lang, '修订冲突，远端删除未完成', 'Revision conflict; upstream delete incomplete');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const boardRes = await host.call<UpstreamBoardSnapshot>('board.get', {});
        if (!boardRes.ok || !boardRes.value) {
          lastError = boardRes.error?.message || t(lang, '无法读取学习库看板', 'Failed to read upstream board');
          recordUpstreamFailure(opKey, { kind: 'remove', upstreamCardId }, lastError, notifyOnFailure);
          return { ok: false, error: lastError };
        }
        if (boardRes.value.readOnly) {
          upstreamReadOnlyRef.current = true;
          isReadOnlyRef.current = true;
          if (mountedRef.current) setUpstreamReadOnly(true);
          if (notifyOnFailure && mountedRef.current) notifyReadOnly();
          return { ok: false, error: 'readOnly' };
        }
        const upstream = boardRes.value;
        const inOpen = Boolean(upstream.cards && Object.hasOwn(upstream.cards, upstreamCardId));
        const inArchived = Array.isArray(upstream.archived)
          ? upstream.archived.some((c) => c && c.id === upstreamCardId)
          : false;
        if (!inOpen && !inArchived) {
          clearUpstreamFailure(opKey);
          return { ok: true };
        }

        const rmRes = await host.call('board.card.remove', {
          revision: upstream.revision ?? 0,
          id: upstreamCardId,
        });
        if (rmRes.ok) {
          clearUpstreamFailure(opKey);
          return { ok: true };
        }
        lastError = rmRes.error?.message || t(lang, '删除远端任务失败', 'Failed to remove upstream card');
        if (!/revision conflict/i.test(lastError)) {
          recordUpstreamFailure(opKey, { kind: 'remove', upstreamCardId }, lastError, notifyOnFailure);
          return { ok: false, error: lastError };
        }
      }
      recordUpstreamFailure(opKey, { kind: 'remove', upstreamCardId }, lastError, notifyOnFailure);
      return { ok: false, error: lastError };
    },
    [host, lang, notifyReadOnly, recordUpstreamFailure, clearUpstreamFailure],
  );

  const addUpstreamDirect = useCallback(
    async (
      localCardId: string,
      opts: { notifyOnFailure?: boolean } = {},
    ): Promise<{ ok: boolean; error?: string }> => {
      const notifyOnFailure = opts.notifyOnFailure ?? true;
      const opKey = `add:${localCardId}`;
      if (isReadOnlyRef.current) return { ok: false, error: 'readOnly' };
      let lastError = t(lang, '修订冲突，远端创建未完成', 'Revision conflict; upstream add incomplete');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const localNow = docRef.current.cards.find((c) => c.id === localCardId);
        if (!localNow || localNow.upstreamCardId) {
          clearUpstreamFailure(opKey);
          return { ok: true };
        }

        const boardRes = await host.call<UpstreamBoardSnapshot>('board.get', {});
        if (!boardRes.ok || !boardRes.value) {
          lastError = boardRes.error?.message || t(lang, '无法读取学习库看板', 'Failed to read upstream board');
          recordUpstreamFailure(opKey, { kind: 'add', localCardId }, lastError, notifyOnFailure);
          return { ok: false, error: lastError };
        }
        if (boardRes.value.readOnly) {
          upstreamReadOnlyRef.current = true;
          isReadOnlyRef.current = true;
          if (mountedRef.current) setUpstreamReadOnly(true);
          if (notifyOnFailure && mountedRef.current) notifyReadOnly();
          return { ok: false, error: 'readOnly' };
        }
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
          lastError = addRes.error?.message || t(lang, '创建远端任务失败', 'Failed to add upstream card');
          if (/revision conflict/i.test(lastError)) {
            continue;
          }
          recordUpstreamFailure(opKey, { kind: 'add', localCardId }, lastError, notifyOnFailure);
          return { ok: false, error: lastError };
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
        if (!createdId) {
          lastError = t(lang, '远端未返回新建任务 ID', 'Upstream did not return created card ID');
          recordUpstreamFailure(opKey, { kind: 'add', localCardId }, lastError, notifyOnFailure);
          return { ok: false, error: lastError };
        }

        clearUpstreamFailure(opKey);
        const latestLocal = docRef.current.cards.find((c) => c.id === localCardId);
        if (!latestLocal) {
          await persistDoc((prev) => ({
            ...prev,
            version: 1,
            deletedUpstreamIds: recordDeletedUpstreamIds(prev.deletedUpstreamIds, createdId),
            updatedAt: new Date().toISOString(),
          }));
          await removeUpstreamDirect(createdId, { notifyOnFailure });
          return { ok: true };
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
          await updateUpstreamDirect(
            createdId,
            {
              ...(colChanged ? { column: latestLocal.column } : {}),
              ...(titleChanged ? { title: latestLocal.title } : {}),
              ...(dueChanged ? { due: latestLocal.dueDate || '' } : {}),
            },
            { notifyOnFailure },
          );
        }
        return { ok: true };
      }
      recordUpstreamFailure(opKey, { kind: 'add', localCardId }, lastError, notifyOnFailure);
      return { ok: false, error: lastError };
    },
    [host, lang, notifyReadOnly, persistDoc, removeUpstreamDirect, updateUpstreamDirect, recordUpstreamFailure, clearUpstreamFailure],
  );

  const retryPendingUpstreamOpsRef = useRef<() => Promise<{ remaining: number; lastError: string | null }>>(async () => ({
    remaining: 0,
    lastError: null,
  }));
  retryPendingUpstreamOpsRef.current = async () => {
    const entries = [...pendingUpstreamOpsRef.current.values()];
    let lastError: string | null = null;
    for (const op of entries) {
      if (isReadOnlyRef.current) break;
      let res: { ok: boolean; error?: string };
      if (op.kind === 'add') {
        res = await addUpstreamDirect(op.localCardId, { notifyOnFailure: false });
      } else if (op.kind === 'update') {
        res = await updateUpstreamDirect(op.upstreamCardId, op.patch, { notifyOnFailure: false });
      } else {
        res = await removeUpstreamDirect(op.upstreamCardId, { notifyOnFailure: false });
      }
      if (!res.ok && res.error) lastError = res.error;
    }
    return { remaining: pendingUpstreamOpsRef.current.size, lastError };
  };

  const mirrorUpstreamUpdate = useCallback(
    (upstreamCardId: string, patch: { column?: BoardColumnId; title?: string; due?: string }) => {
      markInflightUpstream(upstreamCardId);
      return enqueueUpstream(async () => {
        try {
          await saveCoordRef.current?.coord.flush();
          return await updateUpstreamDirect(upstreamCardId, patch);
        } finally {
          unmarkInflightUpstream(upstreamCardId);
        }
      });
    },
    [enqueueUpstream, updateUpstreamDirect, markInflightUpstream, unmarkInflightUpstream],
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
      if (isReadOnlyRef.current) {
        notifyReadOnly();
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
    [grouped, normalizedFilter, persistDoc, mirrorUpstreamUpdate, notifyReadOnly],
  );

  const handleExportMarkdown = useCallback(async () => {
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    try {
      const currentDoc = docRef.current;
      const markdown = formatBoardMarkdown(currentDoc, lang);
      const baseDir = libraryRoot?.trim() ? resolve(libraryRoot.trim()) : process.cwd();
      const exportLabel = focusCourse?.trim() || activeCol;
      const rawTargetPath = defaultBackupFilePath(baseDir, 'studyhub-board', 'md', exportLabel);
      const { path: targetPath } = await atomicWriteExportText(rawTargetPath, markdown);
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
  }, [activeCol, asciiMode, focusCourse, lang, libraryRoot, notify]);

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
      if (key.ctrl && input === 'r') {
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
        if (isReadOnlyRef.current) {
          notifyReadOnly();
          return;
        }
        setModal({ type: 'add' });
        return;
      }
      if (input === 'S') {
        if (isReadOnlyRef.current) {
          notifyReadOnly();
          return;
        }
        void syncUpstreamBoard({ notifyResult: true });
        return;
      }
      if (!selectedCard) return;
      if (input === 'H') {
        if (isReadOnlyRef.current) {
          notifyReadOnly();
          return;
        }
        const leftCol = adjacentColumn(selectedCard.column, -1, false);
        if (leftCol) moveCard(selectedCard, leftCol);
        return;
      }
      if (input === 'L') {
        if (isReadOnlyRef.current) {
          notifyReadOnly();
          return;
        }
        const rightCol = adjacentColumn(selectedCard.column, 1, false);
        if (rightCol) moveCard(selectedCard, rightCol);
        return;
      }
      if (input === 'm') {
        if (isReadOnlyRef.current) {
          notifyReadOnly();
          return;
        }
        const nextCol = adjacentColumn(selectedCard.column, 1, true);
        if (nextCol) moveCard(selectedCard, nextCol);
        return;
      }
      if (input === 'e' || key.return) {
        if (isReadOnlyRef.current) {
          notifyReadOnly();
          return;
        }
        setModal({ type: 'edit', card: selectedCard });
        return;
      }
      if (input === 'd') {
        if (isReadOnlyRef.current) {
          notifyReadOnly();
          return;
        }
        setModal({ type: 'delete', card: selectedCard });
      }
    },
    { isActive: boardNavActive },
  );

  const handleFocusComplete = useCallback(
    (minutes: number) => {
      if (isReadOnlyRef.current) {
        notifyReadOnly();
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
    [persistDoc, asciiMode, selectedCard, notify, lang, notifyReadOnly],
  );

  const hints: KeyHint[] = useMemo(() => {
    if (filterEditing) {
      return [
        { key: 'Enter', label: t(lang, '确认', 'Apply') },
        { key: 'Esc', label: t(lang, '清除', 'Clear') },
      ];
    }
    return [
      ...(isReadOnly ? [{ key: 'Ctrl+R', label: t(lang, '重载', 'Reload') }] : []),
      { key: 'h/l', label: t(lang, '切列', 'Col') },
      { key: 'j/k', label: t(lang, '移动', 'Nav') },
      ...(!isReadOnly
        ? [
            { key: 'H/L/m', label: t(lang, '移列', 'Move') },
            { key: 'a', label: t(lang, '添加', 'Add') },
          ]
        : []),
      { key: '/', label: t(lang, '过滤', 'Filter') },
      ...(filterQuery ? [{ key: 'Esc', label: t(lang, '清过滤', 'Clear') }] : []),
      { key: 'x', label: t(lang, '导出', 'Export') },
      ...(!isReadOnly
        ? [
            { key: 'S', label: t(lang, '同步', 'Sync') },
            { key: 'e', label: t(lang, '编辑', 'Edit') },
            { key: 'd', label: t(lang, '删除', 'Del') },
          ]
        : []),
      { key: 'Space/P', label: t(lang, '专注', 'Timer') },
      { key: 'M', label: t(lang, '模式', 'Mode') },
      { key: '+/-', label: t(lang, '时长', 'Min') },
      { key: 'R', label: t(lang, '重置', 'Reset') },
    ];
  }, [filterEditing, filterQuery, lang, isReadOnly]);
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
                ? isReadOnly
                  ? t(lang, '只读模式 (Ctrl+R 重载)', 'Read-only (Ctrl+R: reload)')
                  : t(lang, 'a 添加 / S 同步', 'a: add / S: sync')
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
              markInflightUpstream(targetUpstreamId);
              void enqueueUpstream(async () => {
                try {
                  await saveCoordRef.current?.coord.flush();
                  return await removeUpstreamDirect(targetUpstreamId);
                } finally {
                  unmarkInflightUpstream(targetUpstreamId);
                }
              });
            }
            notify(t(lang, `已删除「${gone.title}」`, `Deleted "${gone.title}"`), 'success');
          }}
          onCancel={() => setModal(null)}
        />
      ) : null}
    </>
  );

  const barH = pomodoroBarHeight(width);
  const showSyncErrorBanner = !isReadOnly && Boolean(upstreamSyncError);
  const bannerH = isReadOnly ? 4 : showSyncErrorBanner ? 1 : 0;
  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarH = showFilterBar ? 1 : 0;
  const ell = asciiMode ? '...' : '…';
  const resolvedBoardPath = readOnlyPath || boardFilePath(libraryRoot);
  const innerBannerW = Math.max(10, width - 4);
  const readOnlyBanner = isReadOnly ? (
    <Box
      flexDirection="column"
      width={width}
      height={4}
      borderStyle={asciiMode ? 'classic' : 'single'}
      borderColor={readOnlyError ? theme.error : theme.warning}
      paddingX={1}
      overflow="hidden"
    >
      <Text color={readOnlyError ? theme.error : theme.warning} bold wrap="truncate">
        {truncateDisplay(
          `${asciiMode ? '[!]' : '▲'} ${
            readOnlyError
              ? t(
                  lang,
                  '看板只读锁定: 修复/备份 tui-board.json 后按 [Ctrl+R] 重载',
                  'Read-only lock: fix/backup tui-board.json then press [Ctrl+R] to reload',
                )
              : t(
                  lang,
                  '看板只读锁定: 学习库看板为只读状态，已禁用编辑与同步，按 [Ctrl+R] 重载',
                  'Read-only lock: StudyHub board is read-only; edits & sync disabled — press [Ctrl+R] to reload',
                )
          }`,
          innerBannerW,
          ell,
        )}
      </Text>
      <Text color={theme.muted} wrap="truncate">
        {truncateDisplay(
          readOnlyError
            ? `${t(lang, '文件', 'File')}: ${resolvedBoardPath} (${readOnlyError})`
            : t(
                lang,
                '仅允许浏览、过滤 (/) 与导出 (x)；所有写入操作已锁定',
                'Browse, filter (/), and export (x) only; all write actions locked',
              ),
          innerBannerW,
          ell,
        )}
      </Text>
    </Box>
  ) : showSyncErrorBanner && upstreamSyncError ? (
    <Box height={1} width={width} paddingX={1} overflow="hidden">
      <Text color={theme.warning} bold wrap="truncate">
        {truncateDisplay(
          `${asciiMode ? '[!]' : '▲'} ${t(
            lang,
            `看板写回失败 (${upstreamSyncError.count} 条待重试): ${upstreamSyncError.message} · 按 [S] 重试`,
            `Upstream sync failed (${upstreamSyncError.count} pending): ${upstreamSyncError.message} · Press [S] to retry`,
          )}`,
          Math.max(10, width - 2),
          ell,
        )}
      </Text>
    </Box>
  ) : null;

  const filterBadge = `[${filterEditing ? t(lang, '过滤', 'Filter') : t(lang, '已过滤', 'Filtered')} ${filteredCards.length}/${doc.cards.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);
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
