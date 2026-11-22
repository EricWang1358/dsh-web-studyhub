import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export type BoardColumnId = 'todo' | 'doing' | 'done';

export const BOARD_COLUMNS: readonly BoardColumnId[] = Object.freeze(['todo', 'doing', 'done']);

export interface BoardCard {
  id: string;
  title: string;
  column: BoardColumnId;
  course?: string;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FocusStats {
  date: string;
  completedPomodoros: number;
  focusedMinutes: number;
}

export interface BoardDocument {
  version: 1;
  cards: BoardCard[];
  focusStats?: FocusStats;
  updatedAt: string;
}

const BoardCardSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(300),
  column: z.enum(['todo', 'doing', 'done']).catch('todo'),
  course: z.string().trim().max(120).optional().catch(undefined),
  dueDate: z.string().trim().max(40).optional().catch(undefined),
  createdAt: z.string().catch(() => new Date().toISOString()),
  updatedAt: z.string().catch(() => new Date().toISOString()),
});

const FocusStatsSchema = z.object({
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .catch(() => todayLocalYmd()),
  completedPomodoros: z.number().int().min(0).max(999).catch(0),
  focusedMinutes: z.number().int().min(0).max(14400).catch(0),
});

const BoardDocumentSchema = z.object({
  version: z.literal(1).catch(1),
  cards: z
    .array(z.unknown())
    .transform((items) => {
      const seen = new Set<string>();
      const out: BoardCard[] = [];
      for (const raw of items) {
        const parsed = BoardCardSchema.safeParse(raw);
        if (!parsed.success) continue;
        if (seen.has(parsed.data.id)) continue;
        seen.add(parsed.data.id);
        out.push({
          ...parsed.data,
          ...(parsed.data.course ? { course: parsed.data.course } : {}),
          ...(parsed.data.dueDate ? { dueDate: parsed.data.dueDate } : {}),
        });
      }
      return out;
    })
    .catch([]),
  focusStats: FocusStatsSchema.optional().catch(undefined),
  updatedAt: z.string().catch(() => new Date().toISOString()),
});

export function boardFilePath(libraryRoot: string): string {
  const base = libraryRoot?.trim() ? resolve(libraryRoot.trim()) : process.cwd();
  return join(base, 'tui-board.json');
}

export function emptyBoard(): BoardDocument {
  return { version: 1, cards: [], updatedAt: new Date().toISOString() };
}

export function parseBoardDocument(raw: unknown): BoardDocument {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const parsed = BoardDocumentSchema.safeParse(source);
  if (!parsed.success) return emptyBoard();
  return parsed.data;
}

export async function loadBoard(libraryRoot: string): Promise<BoardDocument> {
  try {
    const text = await readFile(boardFilePath(libraryRoot), 'utf8');
    return parseBoardDocument(JSON.parse(text));
  } catch {
    return emptyBoard();
  }
}

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

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

let writeQueue: Promise<unknown> = Promise.resolve();

export async function saveBoard(libraryRoot: string, doc: BoardDocument): Promise<BoardDocument> {
  const target = boardFilePath(libraryRoot);
  const run = writeQueue.then(async () => {
    const normalized = parseBoardDocument({
      ...doc,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    try {
      await renameWithRetry(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return normalized;
  });
  writeQueue = run.catch(() => {});
  return run;
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

export function todayLocalYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
