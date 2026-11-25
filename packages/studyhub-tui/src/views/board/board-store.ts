import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicCopyFile, atomicWriteJsonFile, todayLocalYmd } from '../../host/atomic-write.js';
import type { UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';

export { todayLocalYmd };

export type BoardColumnId = 'todo' | 'doing' | 'done';

export const BOARD_COLUMNS: readonly BoardColumnId[] = Object.freeze(['todo', 'doing', 'done']);

export interface BoardCard {
  id: string;
  title: string;
  column: BoardColumnId;
  course?: string;
  dueDate?: string;
  upstreamCardId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpstreamBoardColumn {
  id: string;
  title?: string;
  done?: boolean;
  cardIds?: string[];
}

export interface UpstreamBoardCard {
  id?: string;
  title?: string;
  note?: string;
  due?: string;
  plannedDate?: string;
  labels?: string[];
  kind?: string;
  createdAt?: string;
  updatedAt?: string;
  studyRef?: {
    kind?: string;
    course?: string;
    [k: string]: unknown;
  };
}

export interface UpstreamBoardSnapshot {
  revision?: number;
  columns?: UpstreamBoardColumn[];
  cards?: Record<string, UpstreamBoardCard>;
  archived?: UpstreamBoardCard[];
  readOnly?: boolean;
}

export const MAX_DELETED_UPSTREAM_IDS = 500;

export interface FocusStats {
  date: string;
  completedPomodoros: number;
  focusedMinutes: number;
}

export interface BoardDocument {
  version: 1;
  cards: BoardCard[];
  deletedUpstreamIds?: string[];
  focusStats?: FocusStats;
  updatedAt: string;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
}

function parseTrimmedString(raw: unknown, minLen: number, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) return undefined;
  return trimmed;
}

function parseIntInRange(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    return fallback;
  }
  return raw === 0 ? 0 : raw;
}

function parseBoardColumn(raw: unknown): BoardColumnId {
  return raw === 'todo' || raw === 'doing' || raw === 'done' ? raw : 'todo';
}

function parseBoardCard(raw: unknown): BoardCard | null {
  if (!isPlainObject(raw)) return null;
  const id = parseTrimmedString(raw.id, 1, 120);
  const title = parseTrimmedString(raw.title, 1, 300);
  if (!id || !title) return null;

  const column = parseBoardColumn(raw.column);
  const course = parseTrimmedString(raw.course, 1, 120);
  const dueDate = parseTrimmedString(raw.dueDate, 1, 40);
  const upstreamCardId = parseTrimmedString(raw.upstreamCardId, 1, 120);
  const now = new Date().toISOString();
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : now;

  return {
    id,
    title,
    column,
    ...(course !== undefined ? { course } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(upstreamCardId !== undefined ? { upstreamCardId } : {}),
    createdAt,
    updatedAt,
  };
}

function parseFocusStats(raw: unknown): FocusStats | undefined {
  if (!isPlainObject(raw)) return undefined;
  const rawDate = typeof raw.date === 'string' ? raw.date.trim() : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : todayLocalYmd();
  const completedPomodoros = parseIntInRange(raw.completedPomodoros, 0, 999, 0);
  const focusedMinutes = parseIntInRange(raw.focusedMinutes, 0, 14400, 0);
  return { date, completedPomodoros, focusedMinutes };
}

function parseDeletedUpstreamIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const id = parseTrimmedString(item, 1, 120);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(-MAX_DELETED_UPSTREAM_IDS);
}

export function boardFilePath(libraryRoot: string): string {
  const base = libraryRoot?.trim() ? resolve(libraryRoot.trim()) : process.cwd();
  return join(base, 'tui-board.json');
}

export function emptyBoard(): BoardDocument {
  return { version: 1, cards: [], deletedUpstreamIds: [], updatedAt: new Date().toISOString() };
}

export function recordDeletedUpstreamIds(existing: readonly string[] | undefined, ...ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of existing ?? []) {
    const clean = typeof id === 'string' ? id.trim() : '';
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  for (const id of ids) {
    const clean = typeof id === 'string' ? id.trim() : '';
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out.slice(-MAX_DELETED_UPSTREAM_IDS);
}

/** Parse and sanitize arbitrary JSON input into a valid `BoardDocument` without throwing. */
export function parseBoardDocument(raw: unknown): BoardDocument {
  if (!isPlainObject(raw)) return emptyBoard();

  const cards: BoardCard[] = [];
  if (Array.isArray(raw.cards)) {
    const seen = new Set<string>();
    for (const item of raw.cards) {
      const card = parseBoardCard(item);
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push(card);
    }
  }

  const deletedUpstreamIds = parseDeletedUpstreamIds(raw.deletedUpstreamIds);
  const focusStats = parseFocusStats(raw.focusStats);
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString();

  return {
    version: 1,
    cards,
    deletedUpstreamIds,
    ...(focusStats !== undefined ? { focusStats } : {}),
    updatedAt,
  };
}

export type BoardLoadResult =
  | { ok: true; doc: BoardDocument; existed: boolean }
  | { ok: false; doc: BoardDocument; error: string; path: string };

export async function loadBoardSafe(libraryRoot: string): Promise<BoardLoadResult> {
  const path = boardFilePath(libraryRoot);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { ok: true, doc: emptyBoard(), existed: false };
    }
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, doc: emptyBoard(), error, path };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, doc: emptyBoard(), error, path };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      doc: emptyBoard(),
      error: 'Invalid board JSON: root value must be an object',
      path,
    };
  }

  return { ok: true, doc: parseBoardDocument(raw), existed: true };
}

export async function loadBoard(libraryRoot: string): Promise<BoardDocument> {
  const res = await loadBoardSafe(libraryRoot);
  return res.doc;
}

const writeQueues = new Map<string, Promise<unknown>>();

export async function saveBoard(
  libraryRoot: string,
  doc: BoardDocument,
  opts?: { force?: boolean },
): Promise<BoardDocument> {
  const target = boardFilePath(libraryRoot);
  const prev = writeQueues.get(target) ?? Promise.resolve();
  const run = prev.then(async () => {
    const existing = await loadBoardSafe(libraryRoot);
    if (!existing.ok) {
      if (!opts?.force) {
        throw new Error(
          `Existing tui-board.json could not be read (${existing.error}); refusing to overwrite with defaults`,
        );
      }
      const backupPath = `${target}.corrupt-${Date.now()}.bak`;
      await atomicCopyFile(target, backupPath).catch(() => {});
    }
    const normalized = parseBoardDocument({
      ...doc,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    await atomicWriteJsonFile(target, normalized);
    return normalized;
  });
  const tail = run.catch(() => {});
  writeQueues.set(target, tail);
  void tail.finally(() => {
    if (writeQueues.get(target) === tail) {
      writeQueues.delete(target);
    }
  });
  return run;
}

/**
 * User-facing notice for a failed board save (#1454): the optimistic change is rolled back, so the
 * message must say the edit was NOT saved and the board reverted, and still include the raw error.
 */
export function boardSaveFailureNotice(err: unknown, lang: UiLanguage = 'zh'): string {
  const detail =
    err instanceof Error ? err.message : typeof err === 'string' ? err : err === undefined || err === null ? '' : String(err);
  const base = t(
    lang,
    '修改没有保存，已恢复到上次保存的内容',
    'Changes were not saved - the board was reverted to the last saved content',
  );
  return detail ? `${base}（${detail}）` : base;
}

export interface BoardSaveCoordinator {
  getDoc: () => BoardDocument;
  replaceDoc: (doc: BoardDocument) => void;
  persist: (
    updater: (prev: BoardDocument) => BoardDocument,
    onState: (doc: BoardDocument) => void,
    onError?: (err: unknown) => void,
  ) => Promise<BoardDocument>;
  flush: () => Promise<void>;
}

/**
 * Serializes board persistence and guards against out-of-order stale save completion (#1430):
 * - Optimistically updates `currentDoc` and `onState` synchronously using the latest doc.
 * - Assigns a monotonic sequence number so an earlier slow save can NEVER revert newer memory/UI state.
 * - Serializes disk writes FIFO and skips superseded intermediate writes while always persisting the latest state.
 */
export function createBoardSaveCoordinator(opts: {
  initialDoc?: BoardDocument;
  saveFn: (doc: BoardDocument) => Promise<BoardDocument>;
}): BoardSaveCoordinator {
  let currentDoc = opts.initialDoc ?? emptyBoard();
  let lastPersistedDoc = currentDoc;
  let seq = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    getDoc: () => currentDoc,
    replaceDoc: (next: BoardDocument) => {
      seq += 1;
      currentDoc = next;
      lastPersistedDoc = next;
    },
    persist: (updater, onState, onError) => {
      const prev = currentDoc;
      const nextDoc = updater(prev);
      if (nextDoc === prev) {
        return queue.then(() => currentDoc);
      }
      const mySeq = ++seq;
      currentDoc = nextDoc;
      onState(nextDoc);

      const task = queue.then(async () => {
        if (seq !== mySeq) return currentDoc;
        try {
          const saved = await opts.saveFn(nextDoc);
          lastPersistedDoc = saved;
          if (seq === mySeq) {
            currentDoc = saved;
            onState(saved);
          }
          return saved;
        } catch (err) {
          if (seq === mySeq) {
            currentDoc = lastPersistedDoc;
            onState(lastPersistedDoc);
          }
          onError?.(err);
          return currentDoc;
        }
      });
      queue = task.then(() => undefined, () => undefined);
      return task;
    },
    flush: async () => {
      let pending: Promise<void>;
      do {
        pending = queue;
        await pending;
      } while (queue !== pending);
    },
  };
}

export function adjacentColumn(col: BoardColumnId, dir: -1 | 1, wrap = false): BoardColumnId | null {
  const idx = BOARD_COLUMNS.indexOf(col);
  const next = idx + dir;
  if (next < 0 || next >= BOARD_COLUMNS.length) {
    if (!wrap) return null;
    return BOARD_COLUMNS[(next + BOARD_COLUMNS.length) % BOARD_COLUMNS.length];
  }
  return BOARD_COLUMNS[next];
}

export function cardsInColumn(cards: readonly BoardCard[], col: BoardColumnId): BoardCard[] {
  return cards.filter((c) => c.column === col);
}

export function dueStatus(dueDate: string | undefined, column: BoardColumnId): 'none' | 'done' | 'overdue' | 'today' | 'upcoming' {
  if (!dueDate) return 'none';
  if (column === 'done') return 'done';
  const norm = dueDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) return 'upcoming';
  const today = todayLocalYmd();
  if (norm < today) return 'overdue';
  if (norm === today) return 'today';
  return 'upcoming';
}

export function todayFocusStats(stats?: FocusStats): FocusStats {
  const today = todayLocalYmd();
  if (stats && stats.date === today) {
    return {
      date: today,
      completedPomodoros: Math.max(0, Math.floor(stats.completedPomodoros)),
      focusedMinutes: Math.max(0, Math.floor(stats.focusedMinutes)),
    };
  }
  return { date: today, completedPomodoros: 0, focusedMinutes: 0 };
}

export function addCompletedPomodoro(stats: FocusStats | undefined, minutes: number): FocusStats {
  const base = todayFocusStats(stats);
  const addMin = Math.max(1, Math.round(minutes));
  return {
    date: base.date,
    completedPomodoros: base.completedPomodoros + 1,
    focusedMinutes: base.focusedMinutes + addMin,
  };
}

export function mapUpstreamColumnId(col: UpstreamBoardColumn | undefined): BoardColumnId {
  if (!col) return 'todo';
  if (col.done || col.id === 'done') return 'done';
  if (col.id === 'doing') return 'doing';
  return 'todo';
}

export function resolveUpstreamTargetColumn(
  columns: readonly UpstreamBoardColumn[] | undefined,
  targetCol: BoardColumnId,
): string | null {
  if (!Array.isArray(columns) || columns.length === 0) return targetCol;
  if (targetCol === 'done') {
    return (columns.find((c) => c.id === 'done') || columns.find((c) => c.done))?.id ?? null;
  }
  if (targetCol === 'doing') {
    return (
      columns.find((c) => c.id === 'doing') ||
      columns.find((c) => !c.done && c.id !== 'todo') ||
      columns.find((c) => !c.done)
    )?.id ?? null;
  }
  return (columns.find((c) => c.id === 'todo') || columns.find((c) => !c.done))?.id ?? null;
}

function extractUpstreamMeta(raw: UpstreamBoardCard): { title: string; course?: string; dueDate?: string } {
  const title = String(raw.title || '').trim().slice(0, 300);
  const courseRaw =
    (typeof raw.studyRef?.course === 'string' && raw.studyRef.course.trim()) ||
    (Array.isArray(raw.labels) && typeof raw.labels[0] === 'string' && raw.labels[0].trim()) ||
    '';
  const course = courseRaw ? courseRaw.slice(0, 120) : undefined;
  const dueRaw =
    (typeof raw.due === 'string' && raw.due.trim()) ||
    (typeof raw.plannedDate === 'string' && raw.plannedDate.trim()) ||
    '';
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : undefined;
  return { title, course, dueDate };
}

/** Merge open task cards from StudyHub's global `board.get` snapshot without duplicating local or synced cards or resurrecting tombstoned deletions. */
export function mergeUpstreamBoard(
  prevCards: readonly BoardCard[],
  upstream: UpstreamBoardSnapshot,
  deletedUpstreamIds?: readonly string[],
  protectedUpstreamIds?: ReadonlySet<string>,
): { cards: BoardCard[]; syncedCount: number; changed: boolean } {
  const cardsMap = upstream.cards && typeof upstream.cards === 'object' ? upstream.cards : {};
  const columns = Array.isArray(upstream.columns) ? upstream.columns : [];
  const deletedSet = new Set(
    (deletedUpstreamIds ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
  );

  const entryByUpstreamId = new Map<string, { raw: UpstreamBoardCard; column: BoardColumnId }>();

  for (const col of columns) {
    const mappedCol = mapUpstreamColumnId(col);
    const ids = Array.isArray(col.cardIds) ? col.cardIds : [];
    for (const cardId of ids) {
      if (typeof cardId !== 'string' || !cardId || entryByUpstreamId.has(cardId)) continue;
      const raw = cardsMap[cardId];
      if (!raw || raw.kind === 'memo') continue;
      if (typeof raw.title !== 'string' || !raw.title.trim()) continue;
      entryByUpstreamId.set(cardId, { raw, column: mappedCol });
    }
  }

  for (const [cardId, raw] of Object.entries(cardsMap)) {
    if (!cardId || entryByUpstreamId.has(cardId) || !raw || raw.kind === 'memo') continue;
    if (typeof raw.title !== 'string' || !raw.title.trim()) continue;
    entryByUpstreamId.set(cardId, { raw, column: 'todo' });
  }

  const matchedUpstreamIds = new Set<string>();
  const usedLocalIds = new Set<string>();
  const nextCards: BoardCard[] = [];
  const now = new Date().toISOString();
  let changed = false;

  for (const card of prevCards) {
    if (!card.upstreamCardId) {
      nextCards.push(card);
      usedLocalIds.add(card.id);
      continue;
    }
    if (deletedSet.has(card.upstreamCardId)) {
      changed = true;
      continue;
    }
    if (protectedUpstreamIds?.has(card.upstreamCardId)) {
      matchedUpstreamIds.add(card.upstreamCardId);
      nextCards.push(card);
      usedLocalIds.add(card.id);
      continue;
    }
    const up = entryByUpstreamId.get(card.upstreamCardId);
    if (!up) {
      changed = true;
      continue;
    }
    matchedUpstreamIds.add(card.upstreamCardId);
    const { title, course, dueDate } = extractUpstreamMeta(up.raw);
    const same =
      card.title === title &&
      card.column === up.column &&
      card.course === course &&
      card.dueDate === dueDate;
    if (!same) changed = true;
    const updated: BoardCard = {
      id: card.id,
      title,
      column: up.column,
      ...(course ? { course } : {}),
      ...(dueDate ? { dueDate } : {}),
      upstreamCardId: card.upstreamCardId,
      createdAt: card.createdAt,
      updatedAt: same ? card.updatedAt : up.raw.updatedAt || now,
    };
    nextCards.push(updated);
    usedLocalIds.add(updated.id);
  }

  let activeUpstreamCount = 0;
  for (const [upstreamId, up] of entryByUpstreamId.entries()) {
    if (deletedSet.has(upstreamId)) continue;
    activeUpstreamCount += 1;
    if (matchedUpstreamIds.has(upstreamId)) continue;
    changed = true;
    const { title, course, dueDate } = extractUpstreamMeta(up.raw);
    let localId = `sh-${upstreamId}`.slice(0, 120);
    if (usedLocalIds.has(localId)) {
      localId = `sh-${randomUUID().slice(0, 8)}`;
    }
    usedLocalIds.add(localId);
    nextCards.push({
      id: localId,
      title,
      column: up.column,
      ...(course ? { course } : {}),
      ...(dueDate ? { dueDate } : {}),
      upstreamCardId: upstreamId,
      createdAt: up.raw.createdAt || now,
      updatedAt: up.raw.updatedAt || now,
    });
  }

  return {
    cards: changed ? nextCards : [...prevCards],
    syncedCount: activeUpstreamCount,
    changed,
  };
}
