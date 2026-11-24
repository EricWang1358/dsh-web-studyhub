import type { ReviewRun } from '../../host/sample-actions.js';
import {
  buildCardDialogueUserPrompt,
  buildUnifiedAiSystemPrompt,
  canExposeReferenceAnswer,
} from '../../host/ai-dialogue.js';
import type { UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';

export type NormalizedKind =
  | 'single'
  | 'multiple'
  | 'true_false'
  | 'fill_blank'
  | 'short_answer'
  | 'flashcard';

export interface CardOptionItem {
  id: string;
  text: string;
}

export interface ClozeBlankItem {
  id: string;
}

export interface ClozeBlankDiff {
  id: string;
  index: number;
  userValue: string;
  expected: string;
  matched: boolean | null;
}

export interface CardFeedbackShape {
  correct?: boolean;
  grade?: number;
  selected?: string[];
  nextDue?: string;
  level?: string;
  hintGraded?: boolean;
  focusScheduled?: boolean;
  selfReported?: boolean;
  assessment?: string;
  credited?: number;
  answers?: Record<string, string>;
  details?: Array<{ id: string; correct?: boolean; expected?: string }>;
  hasRubric?: boolean;
  taskCheck?: boolean;
  gradeOriginal?: number;
  adjustedAt?: string;
  correctionPending?: boolean;
  correctionSeenAt?: string;
  [k: string]: unknown;
}

export interface CardSolutionShape {
  answer?: string;
  explanation?: string;
  misconception?: string;
  rubric?: string;
  citations?: Array<{ sourceId?: string; page?: number; pageNumber?: number; title?: string; quote?: string; [k: string]: unknown }>;
  options?: Array<{ id: string; text: string; correct?: boolean; explanation?: string }>;
  cloze?: { text?: string; answers?: Array<{ id: string; value: string; accept?: string[] }> };
  followups?: Array<{ id: string; question: string; answer: string; at?: string }>;
  [k: string]: unknown;
}

export interface CardSourceLocation {
  sourceId: string;
  pageNumber?: number;
  title?: string;
  unit?: string;
}

export interface AiTurn {
  role: 'user' | 'assistant';
  text: string;
}

export const MAX_AI_TURNS = 20;
export const MAX_TRANSLATION_CACHE = 32;

export interface CardTranslation {
  lang?: string;
  at?: string;
  digest?: string;
  prompt: string;
  answer: string;
  explanation: string;
  clozeText?: string;
  blanks?: Array<{ id: string; value: string }>;
  options?: Array<{ id: string; text: string; explanation?: string }>;
}

export interface SimilarCardReason {
  type: string;
  topic?: string;
  terms?: string[];
  sourceTitle?: string;
  [k: string]: unknown;
}

export interface SimilarCardItem {
  deckId: string;
  deckTitle?: string;
  cardId: string;
  topic?: string;
  kind?: string;
  prompt?: string;
  score?: number;
  reasons?: SimilarCardReason[];
  [k: string]: unknown;
}

export interface FsrsGradeSpec {
  key: '0' | '1' | '2' | '3' | '4' | '5';
  grade: number;
  intervalIndex: number;
  labelZh: string;
  labelEn: string;
  tone: 'error' | 'warning' | 'success' | 'primary';
}

/**
 * FSRS-6 6-grade selector aligned 1:1 with StudyHub web & backend 0-5 grade scale:
 * - 0 (Forgot) -> backend grade 0 (fails < 3, triggers tail retry)
 * - 1 (Again)  -> backend grade 1 (fails < 3, triggers tail retry)
 * - 2 (Fuzzy)  -> backend grade 2 (fails < 3, stays on card without tail retry)
 * - 3 (Hard)   -> backend grade 3 (passes >= 3)
 * - 4 (Good)   -> backend grade 4 (passes >= 3)
 * - 5 (Easy)   -> backend grade 5 (passes >= 3)
 */
export const FSRS_GRADES: readonly FsrsGradeSpec[] = Object.freeze([
  { key: '0', grade: 0, intervalIndex: 0, labelZh: '忘了', labelEn: 'Forgot', tone: 'error' },
  { key: '1', grade: 1, intervalIndex: 1, labelZh: '重来', labelEn: 'Again', tone: 'error' },
  { key: '2', grade: 2, intervalIndex: 2, labelZh: '模糊', labelEn: 'Fuzzy', tone: 'warning' },
  { key: '3', grade: 3, intervalIndex: 3, labelZh: '困难', labelEn: 'Hard', tone: 'warning' },
  { key: '4', grade: 4, intervalIndex: 4, labelZh: '良好', labelEn: 'Good', tone: 'success' },
  { key: '5', grade: 5, intervalIndex: 5, labelZh: '简单', labelEn: 'Easy', tone: 'primary' },
]);

export function normalizeCardKind(run: ReviewRun | null | undefined): NormalizedKind {
  if (!run?.card) return 'flashcard';
  if (run.mode === 'flashcard') return 'flashcard';
  const raw = String(run.card.kind || '').toLowerCase();
  if (raw === 'single' || raw === 'mcq' || raw === 'quiz') return 'single';
  if (raw === 'multiple' || raw === 'multi') return 'multiple';
  if (raw === 'true_false' || raw === 'boolean' || raw === 'truefalse') return 'true_false';
  if (raw === 'fill_blank' || raw === 'cloze') return 'fill_blank';
  if (raw === 'short_answer' || raw === 'open' || raw === 'task') return 'short_answer';
  return 'flashcard';
}

export function kindLabel(kind: NormalizedKind, lang: UiLanguage): string {
  switch (kind) {
    case 'single':
      return t(lang, '单选', 'Single');
    case 'multiple':
      return t(lang, '多选', 'Multi');
    case 'true_false':
      return t(lang, '判断', 'T/F');
    case 'fill_blank':
      return t(lang, '填空', 'Cloze');
    case 'short_answer':
      return t(lang, '简答', 'Open');
    case 'flashcard':
      return t(lang, '闪卡', 'Flashcard');
  }
}

export function resolveOptions(
  card: Record<string, unknown> | null | undefined,
  kind: NormalizedKind,
  lang: UiLanguage,
): CardOptionItem[] {
  const raw = Array.isArray(card?.options)
    ? (card.options as Array<{ id?: unknown; text?: unknown }>)
        .filter((o) => o && typeof o.id === 'string')
        .map((o) => ({ id: String(o.id), text: String(o.text ?? o.id) }))
    : [];
  if (raw.length > 0) return raw;
  if (kind === 'true_false') {
    return [
      { id: 'true', text: lang === 'en' ? 'True' : '对 / 正确' },
      { id: 'false', text: lang === 'en' ? 'False' : '错 / 错误' },
    ];
  }
  return [];
}

export function resolveClozeBlanks(card: Record<string, unknown> | null | undefined): {
  text: string;
  blanks: ClozeBlankItem[];
} {
  const cloze = (card?.cloze as { text?: unknown; blanks?: unknown; answers?: unknown } | undefined) || {};
  const text = typeof cloze.text === 'string' && cloze.text ? cloze.text : String(card?.prompt ?? '');
  const rawBlanks = Array.isArray(cloze.blanks)
    ? cloze.blanks
    : Array.isArray(cloze.answers)
      ? cloze.answers
      : [];
  const blanks: ClozeBlankItem[] = rawBlanks
    .map((b, idx) => {
      if (typeof b === 'string') return { id: b };
      if (b && typeof b === 'object' && typeof (b as { id?: unknown }).id === 'string') {
        return { id: String((b as { id: string }).id) };
      }
      return { id: `b${idx + 1}` };
    });
  if (blanks.length === 0) {
    const matches = text.match(/\{\{[^{}]+\}\}/g);
    if (matches && matches.length > 0) {
      return {
        text,
        blanks: matches.map((_, idx) => ({ id: `b${idx + 1}` })),
      };
    }
    return { text, blanks: [{ id: 'b1' }] };
  }
  return { text, blanks };
}

export function formatClozeDisplay(
  clozeText: string,
  blanks: readonly ClozeBlankItem[],
  values: Record<string, string>,
  revealed: boolean,
  solution?: CardSolutionShape | null,
  ascii = false,
): string {
  let idx = 0;
  const solAnswers = solution?.cloze?.answers ?? [];
  const openBr = ascii ? '[' : '〔';
  const closeBr = ascii ? ']' : '〕';
  const blankMark = ascii ? '___' : '＿＿＿';
  const arrow = ascii ? '->' : '→';
  const replaceBlank = () => {
    const blank = blanks[idx];
    const num = idx + 1;
    idx += 1;
    if (!blank) return `${openBr}${ascii ? '__' : '＿＿'}${closeBr}`;
    const userVal = (values[blank.id] ?? '').trim();
    const expected = solAnswers.find((a) => a.id === blank.id)?.value;
    if (revealed && expected) {
      if (userVal) return `${openBr}#${num}: ${userVal} ${arrow} **${expected}**${closeBr}`;
      return `${openBr}#${num}: **${expected}**${closeBr}`;
    }
    return userVal ? `${openBr}#${num}: ${userVal}${closeBr}` : `${openBr}#${num}: ${blankMark}${closeBr}`;
  };
  if (/\{\{[^{}]+\}\}/.test(clozeText)) {
    return clozeText.replace(/\{\{[^{}]+\}\}/g, () => replaceBlank());
  }
  if (/_{3,}/.test(clozeText)) {
    return clozeText.replace(/_{3,}/g, () => replaceBlank());
  }
  return clozeText;
}

export function buildClozeBlankDiffs(
  blanks: readonly ClozeBlankItem[],
  values: Record<string, string>,
  feedback?: CardFeedbackShape | null,
  solution?: CardSolutionShape | null,
): ClozeBlankDiff[] {
  const details = feedback?.details;
  const solAnswers = solution?.cloze?.answers;
  return blanks.map((blank, idx) => {
    const rawUser = values[blank.id] ?? feedback?.answers?.[blank.id] ?? '';
    const userValue = String(rawUser).trim();
    const detail = Array.isArray(details) ? details.find((d) => d.id === blank.id) : undefined;
    const solAns = Array.isArray(solAnswers) ? solAnswers.find((a) => a.id === blank.id) : undefined;
    const rawExpected =
      typeof detail?.expected === 'string' && detail.expected.trim().length > 0
        ? detail.expected
        : (solAns?.value ?? '');
    const expected = String(rawExpected).trim();

    let matched: boolean | null = null;
    if (typeof detail?.correct === 'boolean') {
      matched = detail.correct;
    } else {
      const candidates: string[] = [];
      if (expected) candidates.push(expected);
      if (Array.isArray(solAns?.accept)) {
        for (const alias of solAns.accept) {
          if (typeof alias === 'string' && alias.trim()) {
            candidates.push(alias.trim());
          }
        }
      }
      if (candidates.length > 0) {
        const normUser = userValue.toLowerCase();
        matched = normUser.length > 0 && candidates.some((c) => c.trim().toLowerCase() === normUser);
      }
    }

    return {
      id: blank.id,
      index: idx + 1,
      userValue,
      expected,
      matched,
    };
  });
}

export function formatGapDays(days: unknown, lang: UiLanguage): string {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1) return lang === 'en' ? '<1d' : '<1天';
  if (n < 60) {
    const d = Math.round(n);
    return lang === 'en' ? `${d}d` : `${d}天`;
  }
  if (n < 365) {
    const m = Math.round(n / 30);
    return lang === 'en' ? `${m}mo` : `${m}个月`;
  }
  const y = n / 365;
  const rounded = y < 10 ? Math.round(y * 10) / 10 : Math.round(y);
  return lang === 'en' ? `${rounded}y` : `${rounded}年`;
}

export function extractFeedback(run: ReviewRun | null | undefined): CardFeedbackShape | null {
  if (!run?.feedback || typeof run.feedback !== 'object') return null;
  const raw = run.feedback as Record<string, unknown>;
  return {
    ...(raw as CardFeedbackShape),
    hasRubric: Boolean(raw.rubric),
    taskCheck: Boolean(raw.taskCheck),
    ...(typeof raw.gradeOriginal === 'number' ? { gradeOriginal: raw.gradeOriginal } : {}),
    ...(typeof raw.adjustedAt === 'string' ? { adjustedAt: raw.adjustedAt } : {}),
    ...(typeof raw.correctionPending === 'boolean' ? { correctionPending: raw.correctionPending } : {}),
    ...(typeof raw.correctionSeenAt === 'string' ? { correctionSeenAt: raw.correctionSeenAt } : {}),
  };
}

export function canAdjustAiGrade(
  run: (Pick<ReviewRun, 'mode' | 'closed'> & { closedAt?: unknown }) | null | undefined,
  entry: { retry?: unknown; [k: string]: unknown } | null | undefined,
  feedback: CardFeedbackShape | null | undefined,
): boolean {
  return Boolean(
    run &&
      run.mode !== 'exam' &&
      !run.closed &&
      !run.closedAt &&
      entry &&
      !entry.retry &&
      feedback?.hasRubric &&
      !feedback?.taskCheck,
  );
}

export function extractSolution(run: ReviewRun | null | undefined): CardSolutionShape | null {
  const raw = (run as { solution?: unknown } | null | undefined)?.solution;
  if (!raw || typeof raw !== 'object') return null;
  return raw as CardSolutionShape;
}

export interface RunFollowupItem {
  id?: string;
  question?: string;
  answer?: string;
  at?: string;
}

/**
 * Extract saved follow-up explanations from both `run.followups` (exposed by the backend
 * before revealing the answer, except in exam mode) and `run.solution.followups`.
 */
export function extractRunFollowups(run: ReviewRun | null | undefined): RunFollowupItem[] {
  const sol = extractSolution(run)?.followups;
  const rawTop = (run as { followups?: unknown } | null | undefined)?.followups;
  const top = Array.isArray(rawTop) ? (rawTop as RunFollowupItem[]) : [];
  const solList = Array.isArray(sol) ? (sol as RunFollowupItem[]) : [];
  if (solList.length === 0) return top;
  if (top.length === 0) return solList;
  const merged: RunFollowupItem[] = [];
  const seen = new Set<string>();
  for (const list of [top, solList]) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const key = item.id || `${item.question ?? ''}\0${item.answer ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

export function extractReferenceAnswer(
  run: ReviewRun | null | undefined,
  kind: NormalizedKind,
  lang: UiLanguage,
): string {
  const sol = extractSolution(run);
  const card = run?.card as Record<string, unknown> | null | undefined;
  const opts = sol?.options ?? (Array.isArray(card?.options) ? (card.options as CardSolutionShape['options']) : undefined);
  if ((kind === 'single' || kind === 'multiple' || kind === 'true_false') && Array.isArray(opts)) {
    const correct = opts.filter((o) => o.correct);
    if (correct.length > 0) {
      return correct.map((o) => o.text || o.id).join(' / ');
    }
  }
  if (kind === 'fill_blank' && sol?.cloze?.answers?.length) {
    return sol.cloze.answers.map((a, i) => `#${i + 1}: ${a.value}`).join('  |  ');
  }
  if (typeof sol?.answer === 'string' && sol.answer.trim()) return sol.answer.trim();
  if (typeof card?.answer === 'string' && card.answer.trim()) return card.answer.trim();
  return t(lang, '（暂无标准答案）', '(No reference answer)');
}

export function extractUserAnswerText(
  run: ReviewRun | null | undefined,
  kind: NormalizedKind,
  localSelected: readonly string[],
  localCloze: Record<string, string>,
  localOpenText: string,
  lang: UiLanguage,
): string {
  const fb = extractFeedback(run);
  const card = run?.card as Record<string, unknown> | null | undefined;
  const opts = resolveOptions(card, kind, lang);
  if (kind === 'single' || kind === 'multiple' || kind === 'true_false') {
    const ids = Array.isArray(fb?.selected) && fb.selected.length > 0 ? fb.selected : localSelected;
    if (ids.length === 0) return '';
    return ids
      .map((id) => opts.find((o) => o.id === id)?.text || id)
      .join(' / ');
  }
  if (kind === 'fill_blank') {
    const map = fb?.answers && typeof fb.answers === 'object' ? fb.answers : localCloze;
    const entries = Object.entries(map).filter(([, v]) => String(v || '').trim());
    return entries.map(([k, v], i) => `#${i + 1}(${k}): ${v}`).join('  |  ');
  }
  if (localOpenText.trim()) return localOpenText.trim();
  return '';
}

function toPositivePageNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

export function extractCitation(run: ReviewRun | null | undefined): CardSourceLocation | null {
  const cardSource = (run as { cardSource?: unknown } | null | undefined)?.cardSource as
    | { sourceId?: unknown; documentSourceId?: unknown; title?: unknown; page?: unknown; unit?: unknown }
    | undefined;
  if (cardSource && (typeof cardSource.documentSourceId === 'string' || typeof cardSource.sourceId === 'string')) {
    const sourceId = String(cardSource.documentSourceId || cardSource.sourceId);
    const pageNumber = toPositivePageNumber(cardSource.page);
    return {
      sourceId,
      pageNumber,
      title: typeof cardSource.title === 'string' ? cardSource.title : undefined,
      unit: typeof cardSource.unit === 'string' ? cardSource.unit : undefined,
    };
  }
  const sol = extractSolution(run);
  const cites = sol?.citations ?? (Array.isArray(run?.card?.citations) ? (run.card.citations as CardSolutionShape['citations']) : undefined);
  const first = cites?.find((c) => c && typeof c.sourceId === 'string' && c.sourceId);
  if (!first || !first.sourceId) return null;
  const pg = first.pageNumber ?? first.page;
  return {
    sourceId: first.sourceId,
    pageNumber: toPositivePageNumber(pg),
    title: typeof first.title === 'string' ? first.title : undefined,
  };
}

export function skipTargetIndex(run: ReviewRun | null | undefined): number | null {
  if (!run?.card || run.mode === 'exam' || run.feedback) return null;
  const nav = run.navigation ?? [];
  const waiting = (item: { answered?: boolean; index: number }) => !item.answered && item.index !== run.index;
  const next = nav.find((item) => item.index > run.index && waiting(item)) || nav.find(waiting);
  return next ? next.index : null;
}

export function currentDeckIdOf(run: ReviewRun | null | undefined): string | null {
  if (!run) return null;
  if (typeof run.deckId === 'string' && run.deckId) return run.deckId;
  const nav = run.navigation?.find((item) => item.index === run.index);
  if (nav?.deckId) return nav.deckId;
  const rawScope = (run as Record<string, unknown>).scope;
  const firstScope = Array.isArray(rawScope)
    ? ((rawScope as Array<{ deckId?: string }>)[0]?.deckId ?? null)
    : null;
  return firstScope || null;
}

/** Build the daily course study-note title expected by `note.qa.add` (mirrors `ui/review/question-note.js`). */
export function buildDailyQuestionNoteTitle(
  run: ReviewRun | null | undefined,
  decks: ReadonlyArray<{ id?: string; course?: string; folder?: string }> | undefined,
  lang: UiLanguage,
  now: Date = new Date(),
): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const deckId = currentDeckIdOf(run);
  const deck = deckId && Array.isArray(decks) ? decks.find((d) => d.id === deckId) : null;
  const cardRec = run?.card as Record<string, unknown> | null | undefined;
  const runRec = run as Record<string, unknown> | null | undefined;
  const course = String(deck?.course ?? deck?.folder ?? cardRec?.course ?? runRec?.course ?? '').trim();
  if (lang === 'en') {
    return course ? `${day} · ${course} · Study Notes` : `Study Notes · ${day}`;
  }
  return course ? `${day} · ${course} · 学习笔记` : `学习笔记 · ${day}`;
}

export function buildCardHelpSystemPrompt(lang: UiLanguage): string {
  return buildUnifiedAiSystemPrompt('explain', lang);
}

export function buildCardHelpUserPrompt(params: {
  run: ReviewRun;
  kind: NormalizedKind;
  userAnswer: string;
  history: readonly AiTurn[];
  question: string;
  lang: UiLanguage;
}): string {
  const { run, kind, userAnswer, history, question, lang } = params;
  const card = (run.card || {}) as Record<string, unknown>;
  const sol = extractSolution(run);
  const revealed = canExposeReferenceAnswer(run);
  const opts = resolveOptions(card, kind, lang);
  return buildCardDialogueUserPrompt({
    kindLabel: kindLabel(kind, lang),
    topic: card.topic ? String(card.topic) : undefined,
    prompt: String(card.prompt || ''),
    options: opts.map((o) => o.text),
    userAnswer,
    revealed,
    referenceAnswer: revealed ? extractReferenceAnswer(run, kind, lang) : undefined,
    explanation: sol?.explanation,
    misconception: sol?.misconception,
    history,
    maxHistoryTurns: MAX_AI_TURNS,
    question,
    lang,
  });
}
