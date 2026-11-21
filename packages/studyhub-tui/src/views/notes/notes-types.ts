import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { UiLanguage } from '../../types/contracts.js';

export interface NoteCardRef {
  deckId: string;
  cardId: string;
  prompt?: string;
  deckTitle?: string;
  course?: string;
  missing?: boolean;
}

export interface NoteDailyMeta {
  day?: string;
  courseId?: string;
  course?: string;
  timeZone?: string;
  answeredCount?: number;
  wrongCount?: number;
  unassessedCount?: number;
  tone?: string;
  manualEditedAt?: string;
  final?: boolean;
}

export interface NoteGenerationState {
  id?: string;
  status?: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'superseded' | string;
  message?: string;
  progress?: {
    phase?: string;
    completed?: number;
    total?: number;
  };
}

export interface NoteItem {
  id: string;
  title: string;
  markdown?: string;
  status: 'draft' | 'published' | string;
  kind?: string;
  origin?: string;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  cards?: NoteCardRef[];
  cardCount?: number;
  courses?: string[];
  daily?: NoteDailyMeta;
  generation?: NoteGenerationState;
  publishedUrl?: string;
}

export interface DailyRecapGroup {
  day: string;
  courseId: string;
  course: string;
  timeZone: string;
  answeredCount: number;
  wrongCount: number;
  unassessedCount: number;
  eligible: boolean;
  noteId: string | null;
  hasContent: boolean;
  protected: boolean;
  generation?: NoteGenerationState;
  tone?: string;
  preview?: string;
  stale?: boolean;
}

export interface DailyRecapStatus {
  day: string;
  timeZone: string;
  tone?: string;
  modelReady?: boolean;
  groups: DailyRecapGroup[];
}

export interface CardSearchOption {
  deckId: string;
  cardId: string;
  deckTitle: string;
  course: string;
  prompt: string;
  topic?: string;
}

export function isDailyNote(note: Pick<NoteItem, 'kind'> | null | undefined): boolean {
  return typeof note?.kind === 'string' && note.kind.startsWith('daily-recap');
}

export function isNoteWritable(note: Pick<NoteItem, 'status' | 'kind'> | null | undefined): boolean {
  if (!note) return false;
  return note.status === 'draft' || isDailyNote(note);
}

export function resolveRecapTimeZone(settings?: Record<string, unknown> | null): string {
  const dailyRecap = settings?.dailyRecap as { timeZone?: unknown } | undefined;
  if (typeof dailyRecap?.timeZone === 'string' && dailyRecap.timeZone.trim()) {
    return dailyRecap.timeZone.trim();
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export function todayInTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function sanitizeNoteFilename(title: string): string {
  const cleaned = String(title || 'study-note')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return cleaned || 'study-note';
}

export function defaultExportPath(libraryRoot: string, noteTitle: string): string {
  const baseDir = libraryRoot?.trim() ? join(resolve(libraryRoot.trim()), 'exports') : join(homedir(), 'StudyHub-Exports');
  return join(baseDir, `${sanitizeNoteFilename(noteTitle)}.md`);
}

export function expandUserPath(rawPath: string, libraryRoot: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) return resolve(trimmed);
  const base = libraryRoot?.trim() ? resolve(libraryRoot.trim()) : process.cwd();
  return resolve(base, trimmed);
}

export function formatShortDate(iso: string | undefined, lang: UiLanguage): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso.slice(0, 10);
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return lang === 'en' ? `Today ${hh}:${mm}` : `今天 ${hh}:${mm}`;
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}
