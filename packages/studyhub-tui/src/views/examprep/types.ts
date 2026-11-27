/** Types & pure helpers for ExamPrepView (`course.focusProgress`, `book.crunch`, `focus.extract`, `course.save`). */
import type { UiLanguage } from '../../types/contracts.js';

export type PrepTab = 'focus' | 'crunch';

export interface FocusTopicProgress {
  topic: string;
  cards: number;
  counts: {
    new?: number;
    weak?: number;
    learning?: number;
    familiar?: number;
    mastered?: number;
    [k: string]: number | undefined;
  };
  mastery: number;
  status: 'none' | 'weak' | 'todo' | 'active' | 'done' | string;
  weakCards: Array<{ deckId: string; cardId: string }>;
}

export interface FocusProgressResult {
  course: string | null;
  topics: FocusTopicProgress[];
  total: number;
  done: number;
  weak: number;
  none: number;
  weakScope: Array<{ deckId: string; cardId: string }>;
}

export interface CrunchPoint {
  id: string;
  key?: string;
  code?: string;
  number?: string;
  title: string;
  order?: number;
  tested?: number;
  weakness?: number;
  questions?: number;
  weak?: number;
  due?: number;
  fresh?: number;
  size?: number;
  pitfalls?: number;
  done?: string | null;
  seen?: string | null;
  examDay?: {
    band?: 'solid' | 'slip' | 'weak' | string;
    atRisk?: Array<{ deckId: string; cardId: string; rank?: number }>;
  };
}

export interface BookCrunchResult {
  status: 'ok' | 'far' | 'past' | 'no-exam' | 'no-book' | 'no-course' | string;
  course: string | null;
  examDate?: string | null;
  daysLeft?: number | null;
  today?: string;
  window?: number;
  plan?: {
    status?: string;
    daysLeft?: number;
    minutesPerDay?: number;
    today?: string[];
    order?: { flip?: string[] };
  };
  points?: CrunchPoint[];
}

export interface CourseRecordView {
  id?: string;
  name: string;
  exam?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  focusTopics?: string[];
  guidanceSourceIds?: string[];
}

export function splitFocusTopicsInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(raw || '').split(/[,，;；\r\n]+/)) {
    const cleaned = part.replace(/^[-*•\d.)、\s]+/, '').trim().slice(0, 80);
    if (!cleaned) continue;
    const key = cleaned.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 200) break;
  }
  return out;
}

export function mergeUniqueTopics(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...existing, ...incoming]) {
    const cleaned = String(item || '').trim().slice(0, 80);
    if (!cleaned) continue;
    const key = cleaned.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 200) break;
  }
  return out;
}

export function detectImageMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const ascii = (offset: number, expected: string) =>
    bytes.length >= offset + expected.length && [...expected].every((ch, idx) => bytes[offset + idx] === ch.charCodeAt(0));
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

export function focusStatusGroup(status: string): 'none' | 'in_progress' | 'mastered' {
  if (status === 'done') return 'mastered';
  if (status === 'none') return 'none';
  return 'in_progress';
}

export function focusStatusLabel(status: string, lang: UiLanguage): string {
  if (status === 'done') return lang === 'en' ? 'Mastered' : '已掌握';
  if (status === 'none') return lang === 'en' ? 'No Qs' : '暂无题';
  if (status === 'weak') return lang === 'en' ? 'Weak' : '薄弱';
  if (status === 'todo') return lang === 'en' ? 'To Study' : '待学';
  return lang === 'en' ? 'In Progress' : '学习中';
}

export function focusStatusTone(status: string): 'success' | 'warning' | 'error' | 'muted' {
  if (status === 'done') return 'success';
  if (status === 'weak') return 'error';
  if (status === 'none') return 'muted';
  return 'warning';
}

export function crunchStatusLabel(status: string, lang: UiLanguage): string {
  const map: Record<string, [string, string]> = {
    ok: ['冲刺窗口内', 'Crunch Window'],
    far: ['距考尚早', 'Before Window'],
    past: ['已过考试日', 'Past Exam'],
    'no-exam': ['未设考试日期', 'No Exam Date'],
    'no-book': ['尚未生成复习全书', 'No Review Book'],
    'no-course': ['未选择课程', 'No Course'],
  };
  const pair = map[status];
  return pair ? (lang === 'en' ? pair[1] : pair[0]) : status;
}
