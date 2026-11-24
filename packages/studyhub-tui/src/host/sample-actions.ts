/**
 * Typed helpers over `host.call(...)` for the StudyHub actions the TUI drives directly.
 * Action names and argument shapes mirror the web UI (`ui/app/use-tour.js`) and `lib/`:
 * `sample.load` / `sample.remove` / `sample.status` (lib/sample-library.js), `study.voicePack`,
 * `materials.document.import`, `source.add`, `review.*` (lib/contexts/study/operations.js).
 */
import { extname, isAbsolute, resolve } from 'node:path';
import { useTuiStore } from '../state/store.js';
import type { HostCallResult, HostClient, StudySnapshot, UiLanguage } from '../types/contracts.js';

type Caller = Pick<HostClient, 'call'>;

/** A failed host action, with a stable `code` and the action that failed. */
export class HostActionError extends Error {
  readonly code: string;
  readonly action: string;
  readonly details?: unknown;

  constructor(action: string, message: string, code = 'STUDY_ERROR', details?: unknown) {
    super(message);
    this.name = 'HostActionError';
    this.action = action;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const BACKEND_ERROR_ZH: ReadonlyArray<[RegExp, string | ((...args: string[]) => string)]> = [
  [/^Review has ended\.?$/i, '本轮练习已结束'],
  [/^Exam has ended without submission\.?$/i, '模拟考已结束（未交卷）'],
  [/^This round has ended; start a new one with review\.start\.?$/i, '本轮练习已结束，请重新开始新一轮'],
  [/^Answer this question before continuing\.?$/i, '请先作答本题再继续'],
  [/^Question changed; refresh review\.?$/i, '题目已变更，请刷新练习'],
  [/^Submit the exam before reviewing answers\.?$/i, '请先交卷后再查看答案'],
  [/^Not an exam run\.?$/i, '当前不是模拟考场次'],
  [/^No questions available for this mode\.?$/i, '当前模式下暂无可练习题目'],
  [/^Restore this archived deck before studying\.?$/i, '请先恢复该已归档题组再学习'],
  [/^Deck not found(?::\s*(.+))?\.?$/i, (_, id) => (id ? `未找到该题组: ${id}` : '未找到该题组')],
  [/^Source not found(?::\s*(.+))?\.?$/i, (_, id) => (id ? `未找到该资料: ${id}` : '未找到该资料')],
  [/^Skeleton not found(?::\s*(.+))?\.?$/i, (_, id) => (id ? `未找到该知识骨架: ${id}` : '未找到该知识骨架')],
];

/** Localize known English backend error strings when UI language is Chinese (`zh`). */
export function localizeBackendError(
  message: string,
  lang: UiLanguage = useTuiStore.getState().preferences.language,
): string {
  if (lang !== 'zh' || !message) return message;
  const trimmed = message.trim();
  if (!trimmed || /[\u4e00-\u9fff]/.test(trimmed)) return message;
  for (const [pattern, replacement] of BACKEND_ERROR_ZH) {
    const match = trimmed.match(pattern);
    if (match) {
      return typeof replacement === 'function' ? replacement(...match) : replacement;
    }
  }
  return message;
}

/** Human-readable message for anything thrown or returned by the host. */
export function errorMessage(error: unknown, lang?: UiLanguage): string {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return localizeBackendError(error, lang);
  if (error instanceof Error) return localizeBackendError(error.message || error.name, lang);
  const err = error as { message?: unknown; error?: unknown };
  if (typeof err.message === 'string') return localizeBackendError(err.message, lang);
  if (typeof err.error === 'string') return localizeBackendError(err.error, lang);
  if (err.error && typeof err.error === 'object') return errorMessage(err.error, lang);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Call an action and never throw: transport errors become `{ ok: false, error }`. */
export async function tryAction<T = unknown>(host: Caller, action: string, args: Record<string, unknown> = {}): Promise<HostCallResult<T>> {
  try {
    const result = await host.call<T>(action, args);
    if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
      if (result.ok) return result;
      const raw = result.error as unknown;
      const error = typeof raw === 'string'
        ? { message: localizeBackendError(raw), code: (result as { code?: string }).code || 'STUDY_ERROR' }
        : { message: errorMessage(raw) || `${action} failed`, code: (raw as { code?: string })?.code || 'STUDY_ERROR', details: (raw as { details?: unknown })?.details };
      return { ok: false, error };
    }
    return { ok: false, error: { message: `${action}: malformed host response`, code: 'EMPTY_RESPONSE' } };
  } catch (error) {
    return { ok: false, error: { message: errorMessage(error), code: (error as { code?: string })?.code || 'STUDY_ERROR' } };
  }
}

/** Call an action and return its value, throwing `HostActionError` on failure. */
export async function callAction<T = unknown>(host: Caller, action: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await tryAction<T>(host, action, args);
  if (!result.ok) throw new HostActionError(action, result.error?.message || `${action} failed`, result.error?.code, result.error?.details);
  return result.value as T;
}

// ---------- snapshot ----------

export const getStudySnapshot = (host: Caller, args: Record<string, unknown> = {}) =>
  callAction<StudySnapshot>(host, 'snapshot', args);

// ---------- sample course ----------

/** `sampleStatusOf(state)` from lib/sample-library.js. */
export interface SampleStatus {
  loaded: boolean;
  loading: boolean;
  language: 'zh' | 'en' | null;
  course: string | null;
  version: number | null;
  loadedAt: string | null;
  deckId: string | null;
  practice: Array<{ deckId: string; cardId: string }>;
  draftId: string | null;
  caseDeckId: string | null;
  sourceId: string | null;
  sessionId: string | null;
  skeletonId?: string | null;
  [k: string]: unknown;
}

export const SAMPLE_DECK_ID = 'sample-deck-patterns';

export const getSampleStatus = (host: Caller) => callAction<SampleStatus>(host, 'sample.status', {});

/** Load the fictional sample course (never calls a model). Idempotent on the server side. */
export const loadSampleCourse = (host: Caller, { language = 'zh' }: { language?: UiLanguage } = {}) =>
  callAction<SampleStatus>(host, 'sample.load', { language });

export interface SampleRemoval {
  /** Records removed per collection, e.g. `{ decks: 2, attempts: 49 }`. */
  removed: Record<string, number>;
  status: SampleStatus;
}

/** Remove exactly the sample records (the learner's own data is untouched). */
export const removeSampleCourse = (host: Caller) => callAction<SampleRemoval>(host, 'sample.remove', {});

// ---------- voice pack ----------

export interface VoicePackArgs {
  language?: UiLanguage;
  course?: string;
  limit?: number;
  [k: string]: unknown;
}

/** `study.voicePack`: a hands-free handoff pack of due/weak cards. */
export const getVoicePack = <T = Record<string, unknown>>(host: Caller, args: VoicePackArgs = {}) =>
  callAction<T>(host, 'study.voicePack', args);

// ---------- materials ----------

export const IMPORT_FORMATS = Object.freeze(['pdf', 'docx', 'pptx', 'ppt', 'md', 'markdown', 'tex', 'latex', 'html', 'txt', 'json'] as const);
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

const EXTENSION_FORMATS: Record<string, ImportFormat> = {
  '.pdf': 'pdf', '.docx': 'docx', '.pptx': 'pptx', '.ppt': 'ppt', '.md': 'md', '.markdown': 'markdown',
  '.tex': 'tex', '.latex': 'latex', '.html': 'html', '.htm': 'html', '.txt': 'txt', '.json': 'json',
};

/** Import format for a file path, or null when StudyHub cannot import it. */
export function importFormatOf(filePath: string): ImportFormat | null {
  return EXTENSION_FORMATS[extname(String(filePath || '')).toLowerCase()] || null;
}

const WIN_DRIVE_PATH_RE = /^[a-zA-Z]:(?:[\\/]|$)/;
const WIN_UNC_PATH_RE = /^(?:\\\\|\/\/)/;

/**
 * Clean a path typed or dropped into a terminal: PowerShell drag & drop gives `& 'C:\\My Files\\a.pdf'`,
 * Explorer "Copy as path" gives `"C:\\My Files\\a.pdf"`, bash gives `'/home/me/a b.pdf'` or `a\\ b.pdf`.
 * Preserves Windows UNC paths (`\\server\share\...`, `//server/share/...`) and drive roots (`C:\`, `D:/`).
 */
export function cleanPathInput(input: string): string {
  const text = String(input ?? '').trim();
  const quoted = text.match(/^(?:&\s*)?(['"])(.*)\1$/s);
  if (quoted) return quoted[2].trim();
  // POSIX / Git-Bash shells escape spaces in dragged paths (`\ `); never touch Windows drive or UNC paths.
  if (!WIN_DRIVE_PATH_RE.test(text) && !WIN_UNC_PATH_RE.test(text)) {
    return text.replace(/\\ /g, ' ');
  }
  return text;
}

export interface ImportLocalSourceArgs {
  path: string;
  title?: string;
  course?: string;
  courses?: string[];
  format?: ImportFormat;
  pages?: number[];
}

export interface ImportedDocument {
  documentId?: string;
  sourceIds?: string[];
  [k: string]: unknown;
}

/**
 * Retain a local file (PDF, Word, PowerPoint, Markdown, LaTeX, HTML, TXT) as a versioned material via
 * `materials.document.import`. Relative paths resolve against `cwd`.
 */
export async function importLocalSource(host: Caller, args: ImportLocalSourceArgs, cwd = process.cwd()): Promise<ImportedDocument> {
  const raw = cleanPathInput(String(args?.path ?? ''));
  if (!raw) throw new HostActionError('materials.document.import', 'A file path is required', 'invalid-path');
  const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const format = args.format || importFormatOf(path);
  if (!format) {
    throw new HostActionError(
      'materials.document.import',
      `Unsupported file type: ${extname(path) || '(none)'} — supported: ${IMPORT_FORMATS.join(', ')}`,
      'unsupported-format',
    );
  }
  const courses = args.courses?.length ? args.courses : args.course ? [args.course] : undefined;
  return callAction<ImportedDocument>(host, 'materials.document.import', {
    path,
    format,
    ...(args.title ? { title: args.title } : {}),
    ...(courses ? { courses } : {}),
    ...(args.pages?.length ? { pages: args.pages } : {}),
  });
}

/** Add pasted text as a source (`source.add`). */
export const addTextSource = (host: Caller, args: { title: string; text: string; format?: 'md' | 'txt'; courses?: string[] }) =>
  callAction<{ id: string; title: string; [k: string]: unknown }>(host, 'source.add', { ...args });

// ---------- review ----------

export type ReviewMode = 'quiz' | 'flashcard' | 'due' | 'wrong' | 'new' | 'path' | 'exam' | 'course';

export interface ReviewStartArgs {
  mode: ReviewMode;
  deckId?: string;
  scope?: Array<{ deckId: string; cardId?: string }>;
  course?: string;
  fresh?: boolean;
  size?: number;
  [k: string]: unknown;
}

export interface ReviewRun {
  id: string;
  deckId?: string;
  mode?: string;
  index: number;
  total: number;
  answered?: number;
  /** The question the run is on (projected by lib `projectRun`). */
  card?: { id: string; kind?: string; prompt?: string; [k: string]: unknown } | null;
  navigation?: Array<{ index: number; cardId: string; deckId: string; topic?: string; level?: string; answered?: boolean; [k: string]: unknown }>;
  position?: { total: number; at: number; retries?: number; retryAt?: number; last?: boolean };
  complete?: boolean;
  closed?: boolean;
  revealed?: boolean;
  feedback?: Record<string, unknown> | null;
  entry?: { cardId?: string; card?: { id: string; kind?: string; [k: string]: unknown }; [k: string]: unknown } | null;
  queueVersion?: number;
  [k: string]: unknown;
}

export const startReview = (host: Caller, args: ReviewStartArgs) => callAction<ReviewRun>(host, 'review.start', { ...args });
export const getReview = (host: Caller, runId: string) => callAction<ReviewRun>(host, 'review.get', { runId });
/** Show the answer of the current question (required before grading a flashcard). */
export const revealReview = (host: Caller, args: { runId: string; cardId: string; queueVersion?: number }) =>
  callAction<ReviewRun>(host, 'review.reveal', { ...args });
export const endReview = (host: Caller, runId: string) => callAction<ReviewRun>(host, 'review.end', { runId });
export const moveReview = (host: Caller, runId: string, args: Record<string, unknown> = {}) =>
  callAction<ReviewRun>(host, 'review.move', { runId, ...args });

export interface ReviewAnswerArgs {
  runId: string;
  cardId: string;
  /** FSRS grade 1..4 for flashcards / self-graded cards. */
  grade?: number;
  selected?: string[];
  answers?: unknown;
  queueVersion?: number;
  [k: string]: unknown;
}

export const answerReview = (host: Caller, args: ReviewAnswerArgs) => callAction<ReviewRun>(host, 'review.answer', { ...args });

/** The card id of the question a run is currently on (`run.card.id`, else the navigation entry at `run.index`). */
export function currentCardId(run: ReviewRun | null | undefined): string | null {
  if (!run) return null;
  if (typeof run.card?.id === 'string' && run.card.id) return run.card.id;
  const nav = run.navigation?.find((item) => item.index === run.index);
  if (nav?.cardId) return nav.cardId;
  const entry = run.entry;
  return (typeof entry?.cardId === 'string' && entry.cardId) || (typeof entry?.card?.id === 'string' && entry.card.id) || null;
}
