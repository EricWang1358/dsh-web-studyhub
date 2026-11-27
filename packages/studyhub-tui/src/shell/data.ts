import type { BindingSnapshot, DesktopConfigSnapshot, PageId, StudySnapshot } from '../types/contracts.js';
import type { ContextualTip, ContextualTipInput } from './contextual-tips.js';
import {
  courseEntryKey,
  isActiveStudyDeck as selectorIsActiveStudyDeck,
  selectCourseMetrics,
  selectDeckDueCount,
  selectStudySummary,
} from '../selectors/study-metrics.js';

export type SelectContextualTipFn = (input: ContextualTipInput) => ContextualTip | null;
let cachedTipSelector: SelectContextualTipFn | null = null;

export function getCachedContextualTipSelector(): SelectContextualTipFn | null {
  return cachedTipSelector;
}

export async function loadContextualTipSelector(): Promise<SelectContextualTipFn | null> {
  if (cachedTipSelector) return cachedTipSelector;
  try {
    const m = await import('./contextual-tips.js');
    cachedTipSelector = m.selectContextualTip;
    return cachedTipSelector;
  } catch {
    return null;
  }
}

/** Pure selectors over the loose StudySnapshot shape (shared by shell widgets). */

const ASCII_PAGE_ICONS: Record<PageId, string> = {
  library: '*',
  sources: '#',
  generate: '+',
  wrongbook: '!',
  exam: '@',
  dashboard: '%',
  book: '=',
  skeleton: '&',
  examcoach: 'o',
  examprep: '^',
  notes: '-',
  board: ':',
  tasks: '~',
  audio: '>',
  settings: '$',
  review: '>',
};

export function pageIcon(pageId: PageId, asciiMode: boolean, fallback = '*'): string {
  if (!asciiMode) return fallback;
  return ASCII_PAGE_ICONS[pageId] ?? '*';
}

export interface InboxEntry {
  id: string;
  kind: string;
  label: string;
  deckId?: string;
  deckTitle?: string;
  cardId?: string;
  noteId?: string;
  jobId?: string;
  draftId?: string;
  runId?: string;
  sourceId?: string;
  sourceIds?: string[];
  course?: string;
  book?: boolean;
  filename?: string;
  prompt: string;
  promptFull: string;
  detail: string;
  detailFull: string;
  at?: string;
  read: boolean;
  count: number;
  missing: boolean;
  canRevert: boolean;
}

export interface InboxSnapshotData {
  unread: number;
  items: InboxEntry[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function normalizeInboxItem(raw: unknown, idx: number): InboxEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = str(r.kind) || str(r.type) || 'info';
  const id = str(r.id) || str(r.cardId) || str(r.noteId) || str(r.jobId) || `inbox-${idx}`;
  const promptFull = str(r.promptFull) || str(r.prompt) || str(r.title) || str(r.filename);
  const detailFull = str(r.detailFull) || str(r.detail) || str(r.summary) || str(r.message);
  const prompt = str(r.prompt) || str(r.title) || str(r.filename) || promptFull;
  const detail = str(r.detail) || str(r.summary) || str(r.message) || detailFull;
  const sourceIds = Array.isArray(r.sourceIds) ? r.sourceIds.map((x) => str(x)).filter(Boolean) : undefined;
  return {
    id,
    kind,
    label: str(r.label) || kind,
    deckId: str(r.deckId) || undefined,
    deckTitle: str(r.deckTitle) || undefined,
    cardId: str(r.cardId) || undefined,
    noteId: str(r.noteId) || undefined,
    jobId: str(r.jobId) || undefined,
    draftId: str(r.draftId) || undefined,
    runId: str(r.runId) || undefined,
    sourceId: str(r.sourceId) || undefined,
    sourceIds: sourceIds && sourceIds.length > 0 ? sourceIds : undefined,
    course: str(r.course) || undefined,
    book: r.book === true ? true : undefined,
    filename: str(r.filename) || undefined,
    prompt,
    promptFull,
    detail,
    detailFull,
    at: str(r.at) || str(r.createdAt) || str(r.updatedAt) || undefined,
    read: Boolean(r.read),
    count: typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 1 ? r.count : 1,
    missing: Boolean(r.missing),
    canRevert: Boolean(r.canRevert),
  };
}

/** Normalize either `{ unread, items }` (runtime inboxView) or loose `InboxItem[]` into `{ unread, items }`. */
export function extractInboxData(raw: unknown): InboxSnapshotData {
  if (!raw) return { unread: 0, items: [] };
  if (Array.isArray(raw)) {
    const items = raw.map((item, idx) => normalizeInboxItem(item, idx)).filter((x): x is InboxEntry => x !== null);
    return { unread: items.filter((m) => !m.read).length, items };
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const rawItems = Array.isArray(obj.items) ? obj.items : [];
    const items = rawItems.map((item, idx) => normalizeInboxItem(item, idx)).filter((x): x is InboxEntry => x !== null);
    const unread =
      typeof obj.unread === 'number' && Number.isFinite(obj.unread) && obj.unread >= 0
        ? obj.unread
        : items.filter((m) => !m.read).length;
    return { unread, items };
  }
  return { unread: 0, items: [] };
}

export function unreadInboxCount(snapshot: StudySnapshot | null | undefined): number {
  return extractInboxData(snapshot?.inbox as unknown).unread;
}

export interface CourseEntry {
  key: string;
  label: string;
  dueCount: number;
  deckCount: number;
}

export function courseKey(c: { name?: string; id?: string; title?: string }): string {
  return courseEntryKey(c);
}

export function listCourses(snapshot: StudySnapshot | null | undefined): CourseEntry[] {
  return selectCourseMetrics(snapshot).map((c) => ({
    key: c.key,
    label: c.label,
    dueCount: c.dueCount,
    deckCount: c.deckCount,
  }));
}

export function currentCourse(snapshot: StudySnapshot | null | undefined): string | null {
  const c = snapshot?.focus?.course;
  return typeof c === 'string' && c.trim() ? c.trim() : null;
}

export function isActiveStudyDeck(
  deck: { archived?: unknown; systemKind?: unknown; course?: unknown } | null | undefined,
  course?: string | null,
): boolean {
  return selectorIsActiveStudyDeck(deck, course);
}

/**
 * Single source of truth for a deck's due-for-review count (#1342 / #1354 D9).
 * Delegates directly to `src/selectors/study-metrics.ts`.
 */
export function deckDueCount(
  deck: { id?: string; due?: unknown; dueCount?: unknown } | null | undefined,
  progressMap?: Record<string, { due?: unknown } | undefined> | null,
): number {
  return selectDeckDueCount(deck, progressMap);
}

export function dueToday(snapshot: StudySnapshot | null | undefined, course?: string | null): number {
  return selectStudySummary(snapshot, course).due;
}

export function wrongCount(snapshot: StudySnapshot | null | undefined, course?: string | null): number {
  return selectStudySummary(snapshot, course).weak;
}

const RUNNING = new Set(['running', 'queued', 'pending', 'active', 'in_progress', 'started', 'processing']);

export function runningJobs(snapshot: StudySnapshot | null | undefined): number {
  return (snapshot?.jobs ?? []).filter((j) => RUNNING.has(String(j.status ?? '').toLowerCase())).length;
}

export function draftCount(snapshot: StudySnapshot | null | undefined): number {
  return (snapshot?.drafts ?? []).filter((d) => !d.status || d.status === 'draft' || d.status === 'ready').length;
}

export function isLibraryEmpty(snapshot: StudySnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return (snapshot.decks?.length ?? 0) === 0 && (snapshot.sources?.length ?? 0) === 0 && (snapshot.courses?.length ?? 0) === 0;
}

export interface ModelBadgeInfo {
  icon: string;
  provider: string;
  model: string;
  ready: boolean;
  reason: string;
  mode: 'agy' | 'openai' | 'codex' | 'unknown';
}

export function modelInfo(
  cfg: DesktopConfigSnapshot | null | undefined,
  binding?: BindingSnapshot | null,
  snapshot?: StudySnapshot | null,
  asciiMode = false,
): ModelBadgeInfo {
  const ready = Boolean(cfg?.effective?.ready ?? binding?.modelStatus?.ready ?? snapshot?.modelReady ?? false);
  const reason = String(cfg?.effective?.reason ?? binding?.modelStatus?.reason ?? '');
  if (!cfg) {
    const route = binding?.route;
    return {
      icon: asciiMode ? 'o' : '◌',
      provider: route?.provider ?? 'Model',
      model: route?.model ?? '',
      ready,
      reason,
      mode: 'unknown',
    };
  }
  if (cfg.mode === 'agy') {
    return { icon: asciiMode ? '*' : '⚡', provider: 'agy', model: cfg.agy?.model || cfg.effective?.model || '', ready, reason, mode: 'agy' };
  }
  if (cfg.mode === 'codex') {
    return { icon: asciiMode ? '>' : '◇', provider: 'codex', model: cfg.codex?.model || cfg.effective?.model || '', ready, reason, mode: 'codex' };
  }
  const preset = cfg.presets?.find((p) => p.id === cfg.openai?.providerId);
  return {
    icon: asciiMode ? '@' : '☁',
    provider: preset?.name ?? (cfg.openai?.providerId && cfg.openai.providerId !== 'custom' ? cfg.openai.providerId : 'OpenAI'),
    model: cfg.openai?.model || cfg.effective?.model || '',
    ready,
    reason,
    mode: 'openai',
  };
}

export interface AgyDetection {
  state: 'probing' | 'ready' | 'missing' | 'unauthenticated';
  version: string | null;
  path: string | null;
  modelCount: number;
  reason: string;
}

export function detectAgy(cfg: DesktopConfigSnapshot | null | undefined): AgyDetection {
  if (!cfg) return { state: 'probing', version: null, path: null, modelCount: 0, reason: '' };
  const p = cfg.providers?.find((x) => x.id === 'agy');
  if (!p) {
    return {
      state: cfg.mode === 'agy' && cfg.effective?.ready ? 'ready' : 'missing',
      version: null,
      path: cfg.agy?.executablePath || null,
      modelCount: 0,
      reason: cfg.effective?.reason ?? '',
    };
  }
  return {
    state: p.ready ? 'ready' : p.unauthenticated ? 'unauthenticated' : 'missing',
    version: p.version ?? null,
    path: p.executablePath ?? (cfg.agy?.executablePath || null),
    modelCount: p.models?.length ?? 0,
    reason: p.reason ?? p.status ?? '',
  };
}
