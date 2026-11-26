import type { KeyHint, PageId, StudySnapshot, UiLanguage } from '../../types/contracts.js';
import type { AssistantCardContext } from '../../state/store.js';
import { t } from '../../state/store.js';
import { currentCardId, type ReviewRun } from '../../host/sample-actions.js';
import type { PracticeContextFrame, PracticeOriginKind } from '../../state/practice-stack.js';
import type { SavedFollowupItem } from './AiHelpDrawer.js';
import {
  type NormalizedKind,
  type CardFeedbackShape,
  type CardSolutionShape,
  type CardTranslation,
  type ClozeBlankItem,
  currentDeckIdOf,
  extractRunFollowups,
  extractUserAnswerText,
  formatClozeDisplay,
  resolveClozeBlanks,
} from './review-helpers.js';

export interface RubricCriterionResult {
  id: string;
  label?: string;
  score: number;
  max: number;
  ratio?: number;
  evidence?: string[];
  missing?: Array<{ id?: string; text?: string }>;
  suggestion?: string;
  note?: string;
}

export interface RubricSummaryShape {
  total: number;
  max: number;
  ratio?: number;
  band?: string;
  unanswered?: boolean;
  criteria?: RubricCriterionResult[];
  summary?: string;
}

export interface CardGradeResponse {
  deckId?: string;
  cardId?: string;
  runId?: string | null;
  grade?: number;
  total?: number;
  max?: number;
  rubric?: RubricSummaryShape;
  message?: string;
}

export interface RunDraftShape {
  text?: unknown;
  stepInputs?: unknown;
  selected?: unknown;
  updatedAt?: unknown;
}

export interface PendingDraftRestore {
  cardId?: string;
  draft?: PracticeContextFrame['draft'];
  submitted?: boolean;
}

export const DRAFT_SAVE_DEBOUNCE_MS = 600;

export const CARD_UTIL_KEYS: readonly string[] = Object.freeze([
  'X',
  'Q',
  's',
  'm',
  ',',
  '.',
  't',
  'a',
  'f',
  'n',
  'F',
  '*',
  'T',
  'W',
  'S',
  'D',
  'A',
  'E',
  'h',
  'u',
  'o',
  'N',
  'R',
]);
export const ALL_REVIEW_DIGIT_KEYS: readonly string[] = Object.freeze([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);
export const CHOICE_LETTER_KEYS: readonly string[] = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f']);
export const EMPTY_CLAIMED_KEYS: readonly string[] = Object.freeze([]);

export function isRubricEligibleCardKind(kind: NormalizedKind, rawCardKind: string): boolean {
  const lowered = rawCardKind.toLowerCase();
  return (
    kind === 'short_answer' ||
    lowered === 'open' ||
    lowered === 'short_answer' ||
    lowered === 'case'
  );
}

export function resolvePracticeReturnOrigin(destPage: PageId): PracticeOriginKind {
  if (destPage === 'sources') return 'source';
  if (destPage === 'wrongbook') return 'wrongbook';
  if (destPage === 'examcoach') return 'coach';
  if (destPage === 'dashboard') return 'stats';
  return 'other';
}

export function resolveInitialCardDraft(params: {
  run: ReviewRun | null;
  stackRestore: PendingDraftRestore | null;
}): {
  selected: string[];
  clozeInputs: Record<string, string>;
  openDraft: string;
  consumedStackRestore: boolean;
} {
  const { run: activeRun, stackRestore } = params;
  const rawDraft =
    activeRun && !activeRun.feedback && !activeRun.complete && !activeRun.closed
      ? ((activeRun as { draft?: RunDraftShape | null }).draft ?? null)
      : null;
  const restoredText = typeof rawDraft?.text === 'string' ? rawDraft.text : '';
  const restoredCloze: Record<string, string> = {};
  if (rawDraft?.stepInputs && typeof rawDraft.stepInputs === 'object' && !Array.isArray(rawDraft.stepInputs)) {
    for (const [key, val] of Object.entries(rawDraft.stepInputs as Record<string, unknown>)) {
      if (typeof val === 'string') restoredCloze[key] = val;
    }
  }
  const restoredSelected = Array.isArray(rawDraft?.selected)
    ? rawDraft.selected.filter((id): id is string => typeof id === 'string')
    : [];

  let finalSelected = restoredSelected;
  let finalCloze = restoredCloze;
  let finalOpen = restoredText;
  let consumedStackRestore = false;

  if (stackRestore && (!stackRestore.cardId || stackRestore.cardId === currentCardId(activeRun))) {
    consumedStackRestore = true;
    if (!stackRestore.submitted && !activeRun?.feedback && stackRestore.draft) {
      if (Array.isArray(stackRestore.draft.selected) && stackRestore.draft.selected.length > 0) {
        finalSelected = [...stackRestore.draft.selected];
      }
      if (typeof stackRestore.draft.openDraft === 'string' && stackRestore.draft.openDraft.length > 0) {
        finalOpen = stackRestore.draft.openDraft;
      }
      if (Array.isArray(stackRestore.draft.clozeDrafts) && stackRestore.draft.clozeDrafts.length > 0) {
        const clozeMeta = resolveClozeBlanks(activeRun?.card as Record<string, unknown> | undefined);
        const merged: Record<string, string> = { ...restoredCloze };
        if (clozeMeta) {
          clozeMeta.blanks.forEach((b, idx) => {
            const val = stackRestore.draft?.clozeDrafts?.[idx];
            if (typeof val === 'string' && val.length > 0) merged[b.id] = val;
          });
        }
        finalCloze = merged;
      }
    }
  }

  return {
    selected: finalSelected,
    clozeInputs: finalCloze,
    openDraft: finalOpen,
    consumedStackRestore,
  };
}

export function buildCardClaimedKeys(params: {
  isActive: boolean;
  hasRun: boolean;
  isFinished: boolean;
  isRubricEligibleKind: boolean;
  canAdjustGrade: boolean;
  canAckCorrection: boolean;
  kind: NormalizedKind;
}): readonly string[] {
  const { isActive, hasRun, isFinished, isRubricEligibleKind, canAdjustGrade, canAckCorrection, kind } = params;
  if (!isActive || !hasRun || isFinished) return [];
  const baseUtil = [
    ...CARD_UTIL_KEYS,
    ...ALL_REVIEW_DIGIT_KEYS,
    ...(isRubricEligibleKind ? ['G'] : []),
    ...(canAdjustGrade ? ['J'] : []),
    ...(canAckCorrection ? ['K'] : []),
  ];
  // Claim option letters a-f for the entire lifecycle of choice cards (before AND after reveal/feedback)
  // so pressing b/c while reviewing the explanation never unexpectedly jumps to Board or CoursePicker (#1350).
  if (kind === 'single' || kind === 'multiple') {
    return [...baseUtil, ...CHOICE_LETTER_KEYS];
  }
  return baseUtil;
}

export function buildReviewFooterHints(params: {
  loading: boolean;
  run: ReviewRun | null;
  isFinished: boolean;
  revealed: boolean;
  feedback: CardFeedbackShape | null;
  kind: NormalizedKind;
  isRubricEligibleKind: boolean;
  needsRating: boolean;
  canRubricGrade: boolean;
  activeRubric: RubricSummaryShape | null;
  canAdjustGrade: boolean;
  canAckCorrection: boolean;
  canCoachNudge: boolean;
  canRedo: boolean;
  canUndo: boolean;
  mathUnicode: boolean;
  hasCitation: boolean;
  lang: UiLanguage;
}): KeyHint[] {
  const {
    loading,
    run,
    isFinished,
    revealed,
    feedback,
    kind,
    isRubricEligibleKind,
    needsRating,
    canRubricGrade,
    activeRubric,
    canAdjustGrade,
    canAckCorrection,
    canCoachNudge,
    canRedo,
    canUndo,
    mathUnicode,
    hasCitation,
    lang,
  } = params;

  if (loading || !run || isFinished) return [];
  const base: KeyHint[] = [];
  if (!revealed && !feedback) {
    if (kind === 'single') base.push({ key: '1-6/a-f', label: t(lang, '选择提交', 'Select') });
    else if (kind === 'multiple') {
      base.push({ key: '1-6/Space', label: t(lang, '勾选', 'Toggle') });
      base.push({ key: 'Enter', label: t(lang, '提交', 'Submit') });
    } else if (kind === 'true_false') {
      base.push({ key: '1/2', label: t(lang, '判断', 'Judge') });
    } else if (kind === 'fill_blank') {
      base.push({ key: 'i/Enter', label: t(lang, '填空', 'Type') });
    } else if (isRubricEligibleKind) {
      base.push({ key: 'i', label: t(lang, '作答', 'Type') });
      base.push({ key: 'Space', label: t(lang, '翻看答案', 'Reveal') });
    } else {
      base.push({ key: 'Space/Enter', label: t(lang, '翻卡', 'Flip') });
    }
  } else if (needsRating) {
    base.push({ key: '0-5', label: t(lang, 'FSRS评分', 'Rate 0-5') });
  } else {
    base.push({ key: 'Enter / .', label: t(lang, '下一题', 'Next') });
  }
  if (canRubricGrade && !activeRubric) {
    base.push({ key: 'G', label: t(lang, 'AI评分', 'Grade') });
  }
  if (canAdjustGrade) {
    base.push({ key: 'J', label: t(lang, '改分', 'Adjust') });
  }
  if (canAckCorrection) {
    base.push({ key: 'K', label: t(lang, '确认订正', 'Ack fix') });
  }
  if (canCoachNudge) {
    base.push({ key: 'N', label: t(lang, '陪学点拨', 'Nudge') });
  }
  base.push({ key: 'h', label: t(lang, 'AI讲解', 'AI Help') });
  base.push({ key: 't', label: t(lang, '带学/复述', 'Guided') });
  base.push({ key: '*', label: t(lang, '重点', 'Focus') });
  if (canRedo) base.push({ key: 'R', label: t(lang, '重做', 'Redo') });
  base.push({ key: 'W', label: t(lang, '翻译', 'Trans') });
  base.push({ key: 'S', label: t(lang, '同类', 'Similar') });
  base.push({ key: 'D', label: t(lang, '工具', 'Tools') });
  if (run.mode !== 'exam') base.push({ key: 'Q', label: t(lang, '队列', 'Queue') });
  if (canUndo) base.push({ key: 'u', label: t(lang, '撤销评分', 'Undo') });
  base.push({ key: 'A', label: t(lang, '答题卡', 'AnswerCard') });
  base.push({ key: 'm', label: mathUnicode ? 'Unicode' : 'LaTeX' });
  if (hasCitation) base.push({ key: 'o', label: t(lang, '原文', 'Source') });
  base.push({ key: 'X', label: t(lang, '结束', 'End') });
  return base;
}

export function buildReviewStemMarkdown(params: {
  run: ReviewRun | null;
  kind: NormalizedKind;
  clozeData: { text: string; blanks: ClozeBlankItem[] } | null;
  effectiveClozeValues: Record<string, string>;
  revealed: boolean;
  solution: CardSolutionShape | null;
  activeTranslation: CardTranslation | null;
  asciiMode: boolean;
}): string {
  const { run, kind, clozeData, effectiveClozeValues, revealed, solution, activeTranslation, asciiMode } = params;
  if (!run) return '';
  const baseStem =
    kind === 'fill_blank' && clozeData
      ? formatClozeDisplay(clozeData.text, clozeData.blanks, effectiveClozeValues, revealed, solution, asciiMode)
      : String(run.card?.prompt ?? '');
  if (!activeTranslation) return baseStem;
  const trStemRaw =
    kind === 'fill_blank' && activeTranslation.clozeText
      ? activeTranslation.clozeText.replace(/\{\{[^{}]+\}\}/g, asciiMode ? '___' : '＿＿')
      : activeTranslation.prompt;
  if (!trStemRaw) return baseStem;
  return `${baseStem}\n\n> **EN**: ${trStemRaw}`;
}

export function buildPostAnswerMarkdown(params: {
  activeRubric: RubricSummaryShape | null;
  asciiMode: boolean;
  revealed: boolean;
  solution: CardSolutionShape | null;
  activeTranslation: CardTranslation | null;
  lang: UiLanguage;
}): string {
  const { activeRubric, asciiMode, revealed, solution, activeTranslation, lang } = params;
  const blocks: string[] = [];
  if (activeRubric) {
    const criteria = Array.isArray(activeRubric.criteria) ? activeRubric.criteria : [];
    if (criteria.length > 0) {
      blocks.push(`### ${t(lang, 'AI 评分细则', 'AI Rubric Breakdown')}`);
      for (const c of criteria) {
        const mark =
          c.max > 0 && c.score >= c.max
            ? asciiMode
              ? '[+]'
              : '✓'
            : c.score > 0
              ? asciiMode
                ? '[~]'
                : '◐'
              : asciiMode
                ? '[x]'
                : '✕';
        blocks.push(`- ${mark} **${c.label || c.id}** (${c.score}/${c.max})`);
        if (Array.isArray(c.evidence) && c.evidence.length > 0) {
          blocks.push(`  - ${t(lang, '命中依据', 'Evidence')}: "${c.evidence[0]}"`);
        }
        if (Array.isArray(c.missing) && c.missing.length > 0) {
          const missTexts = c.missing
            .map((m) => (typeof m?.text === 'string' ? m.text.trim() : ''))
            .filter(Boolean);
          if (missTexts.length > 0) {
            blocks.push(`  - ${t(lang, '遗漏要点', 'Missing')}: ${missTexts.join('; ')}`);
          }
        }
        if (c.suggestion) {
          blocks.push(`  - ${t(lang, '改进建议', 'Suggestion')}: ${c.suggestion}`);
        }
      }
    }
    if (activeRubric.summary) {
      blocks.push(`> **${t(lang, '总评', 'Feedback')}**: ${activeRubric.summary}`);
    }
  }
  if (revealed) {
    if (solution?.explanation) blocks.push(solution.explanation);
    if (activeTranslation?.explanation) blocks.push(`> **EN**: ${activeTranslation.explanation}`);
    if (solution?.misconception) {
      blocks.push(`> **${t(lang, '常见误区', 'Misconception')}**: ${solution.misconception}`);
    }
  }
  return blocks.join('\n\n');
}

export function countSavedFollowups(run: ReviewRun | null, extraSavedFollowups: readonly SavedFollowupItem[]): number {
  const sol = extractRunFollowups(run);
  if (extraSavedFollowups.length === 0) return sol.length;
  const seenIds = new Set(sol.map((f) => f.id).filter(Boolean));
  const seenQuestions = new Set(sol.map((f) => f.question).filter(Boolean));
  let count = sol.length;
  for (const item of extraSavedFollowups) {
    if ((item.id && seenIds.has(item.id)) || (item.question && seenQuestions.has(item.question))) continue;
    count += 1;
  }
  return count;
}

export function buildAssistantCardContextPayload(params: {
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  selectedIds: string[];
  clozeInputs: Record<string, string>;
  openDraft: string;
  feedback: CardFeedbackShape | null;
  revealed: boolean;
  hasCitation: boolean;
  lang: UiLanguage;
  solution: CardSolutionShape | null;
  sources?: StudySnapshot['sources'];
}): AssistantCardContext {
  const {
    run,
    cardId,
    kind,
    selectedIds,
    clozeInputs,
    openDraft,
    feedback,
    revealed,
    hasCitation,
    lang,
    solution,
    sources,
  } = params;

  const rawOpts = Array.isArray(run.card?.options)
    ? run.card.options.map((o) => ({ id: String(o.id ?? ''), text: String(o.text ?? '') }))
    : undefined;
  const solOptions = Array.isArray(solution?.options) ? solution.options : [];
  const correctTexts = solOptions
    .filter((o) => o && o.correct)
    .map((o) => {
      const match = rawOpts?.find((ro) => ro.id === o.id);
      return match?.text ? `${match.text}` : String(o.text || o.id || '');
    })
    .filter(Boolean);
  const standardAnswer =
    (typeof solution?.answer === 'string' && solution.answer.trim()) ||
    (Array.isArray(solution?.blanks) && solution.blanks.length > 0 ? solution.blanks.join(' / ') : '') ||
    (correctTexts.length > 0 ? correctTexts.join('；') : '');
  const rawCitations =
    Array.isArray(solution?.citations) && solution.citations.length > 0
      ? solution.citations
      : Array.isArray(run.card?.citations)
        ? run.card.citations
        : [];
  const mappedCitations = rawCitations
    .filter((c): c is NonNullable<typeof c> => Boolean(c && (c.sourceId || c.quote)))
    .map((c) => {
      const src = c.sourceId ? sources?.find((s) => s.id === c.sourceId) : undefined;
      return {
        ...(c.sourceId ? { sourceId: c.sourceId } : {}),
        ...(src?.title || src?.name ? { sourceTitle: String(src.title || src.name) } : {}),
        ...(typeof c.page === 'number' ? { pageNumber: c.page } : {}),
        ...(typeof c.quote === 'string' && c.quote.trim() ? { quote: c.quote.trim() } : {}),
      };
    });
  const teaching = (run as { teaching?: { id?: string; mode?: string } | null }).teaching;

  return {
    runId: run.id,
    deckId: currentDeckIdOf(run) ?? undefined,
    cardId,
    cardIndex: typeof run.index === 'number' ? run.index : 0,
    queueVersion: run.queueVersion ?? 0,
    ...(teaching?.id ? { teachingId: teaching.id, teachingMode: teaching.mode } : {}),
    total: typeof run.total === 'number' ? run.total : undefined,
    ...(typeof run.card?.topic === 'string' && run.card.topic ? { topic: run.card.topic } : {}),
    prompt: String(run.card?.prompt || ''),
    ...(rawOpts && rawOpts.length > 0 ? { options: rawOpts } : {}),
    userAnswer: extractUserAnswerText(run, kind, selectedIds, clozeInputs, openDraft, lang),
    ...(standardAnswer ? { answer: standardAnswer } : {}),
    ...(typeof solution?.explanation === 'string' && solution.explanation.trim()
      ? { explanation: solution.explanation.trim() }
      : {}),
    ...(mappedCitations.length > 0 ? { citations: mappedCitations } : {}),
    kind,
    isWrong: Boolean(feedback && feedback.correct === false),
    revealed,
    answered: Boolean(feedback),
    isExam: run.mode === 'exam',
    hasCitation,
  };
}

export function buildGuidedStudyCardContext(params: {
  prevCtx: AssistantCardContext | null;
  run: ReviewRun;
  cardId: string | null;
  userAnswer: string;
  kind: NormalizedKind;
  extra?: Partial<AssistantCardContext>;
}): AssistantCardContext {
  const { prevCtx, run, cardId, userAnswer, kind, extra } = params;
  const teaching = (run as { teaching?: { id?: string; mode?: string } | null }).teaching;
  return {
    ...(prevCtx && prevCtx.cardId === (cardId ?? '') ? prevCtx : {}),
    runId: run.id,
    deckId: currentDeckIdOf(run) ?? undefined,
    cardId: cardId ?? '',
    cardIndex: typeof run.index === 'number' ? run.index : 0,
    queueVersion: run.queueVersion ?? 0,
    ...(teaching?.id ? { teachingId: teaching.id, teachingMode: teaching.mode } : {}),
    prompt: String(run.card?.prompt || ''),
    userAnswer,
    kind,
    ...extra,
  };
}
