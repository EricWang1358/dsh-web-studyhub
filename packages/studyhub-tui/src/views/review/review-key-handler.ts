import type { Key } from 'ink';
import type { ReviewRun } from '../../host/sample-actions.js';
import type { PracticeContextFrame } from '../../state/practice-stack.js';
import type { PageId, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  FSRS_GRADES,
  type CardSourceLocation,
  type CardFeedbackShape,
  type NormalizedKind,
  type CardOptionItem,
} from './review-helpers.js';

export interface ReviewCardKeyContext {
  run: ReviewRun | null;
  busy: boolean;
  lang: UiLanguage;
  mathUnicode: boolean;
  kind: NormalizedKind;
  isRubricEligibleKind: boolean;
  needsRating: boolean;
  feedback: CardFeedbackShape | null;
  canAdjustGrade: boolean;
  canAckCorrection: boolean;
  canCoachNudge: boolean;
  citation: CardSourceLocation | null;
  options: readonly CardOptionItem[];
  cursorOpt: number;
  selectedIds: string[];
  stuckNudgeVisible: boolean;
  setStuckNudgeVisible: (v: boolean) => void;
  bumpStuckActivity: () => void;
  setSkipUnmountPush: (v: boolean) => void;
  loadInitialRun: (forceFresh?: boolean) => Promise<void>;
  goBack: () => void;
  navigate: (page: PageId, context?: Record<string, unknown>) => void;
  notify: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  setPreferences: (patch: { mathUnicode?: boolean }) => void;
  setAiDrawerOpen: (v: boolean) => void;
  setRetellModalOpen: (v: boolean) => void;
  setGradeAdjustModalOpen: (v: boolean) => void;
  setNudgeModalOpen: (v: boolean) => void;
  setSimilarModalOpen: (v: boolean) => void;
  setCardToolsModalOpen: (v: boolean) => void;
  setQueueModalOpen: (v: boolean) => void;
  setAnswerCardModalOpen: (v: boolean) => void;
  setFlagReason: (v: string) => void;
  setFlagModalOpen: (v: boolean) => void;
  setConfirmEndOpen: (v: boolean) => void;
  setOpenEditing: (v: boolean) => void;
  setClozeEditing: (v: boolean) => void;
  setCursorOpt: (updater: number | ((prev: number) => number)) => void;
  setSelectedIds: (updater: string[] | ((prev: string[]) => string[])) => void;
  openGuidedStudy: () => void;
  pushCurrentToPracticeStack: (originKind: 'source' | 'similar') => void;
  handleToggleFocus: () => Promise<void>;
  handleRubricGrade: () => Promise<void>;
  handleAckCorrection: () => Promise<void>;
  handleToggleTranslate: () => Promise<void>;
  handleRedoCard: () => Promise<void>;
  handleUndo: () => void;
  handleSkip: () => void;
  handleMove: (direction: -1 | 1) => void;
  handleFsrsGrade: (grade: number) => void;
  handleReveal: () => void;
  handleSubmitChoice: (ids: string[]) => void;
}

export function handleReviewCardKey(input: string, key: Key, ctx: ReviewCardKeyContext): boolean {
  if (ctx.stuckNudgeVisible) ctx.setStuckNudgeVisible(false);
  ctx.bumpStuckActivity();

  if (key.escape) {
    const st = useTuiStore.getState();
    if (st.assistantOpen && !st.assistantFocused && !st.assistantFullscreen) {
      st.closeAssistant();
      return true;
    }
    const stack = st.practiceStack;
    const top = stack[stack.length - 1];
    if (top && top.originKind === 'similar') {
      ctx.setSkipUnmountPush(true);
      const popped = st.returnViaPracticeStack();
      if (popped && popped.kind === 'review') {
        ctx.setSkipUnmountPush(false);
        void ctx.loadInitialRun(false);
      }
      return true;
    }
    ctx.goBack();
    return true;
  }

  const { run, busy, lang, kind, isRubricEligibleKind, feedback, options, cursorOpt, selectedIds } = ctx;
  if (!run || !run.card || busy) return false;

  // Global card utilities
  if (input === 'h') {
    ctx.setAiDrawerOpen(true);
    return true;
  }
  if (input === 'F') {
    ctx.setRetellModalOpen(true);
    return true;
  }
  if (input === '*') {
    void ctx.handleToggleFocus();
    return true;
  }
  if (input === 'G' && isRubricEligibleKind) {
    void ctx.handleRubricGrade();
    return true;
  }
  if (input === 'J' && ctx.canAdjustGrade) {
    ctx.setGradeAdjustModalOpen(true);
    return true;
  }
  if (input === 'K' && ctx.canAckCorrection) {
    void ctx.handleAckCorrection();
    return true;
  }
  if (input === 'N') {
    if (ctx.canCoachNudge) {
      ctx.setNudgeModalOpen(true);
    } else if (run.mode === 'exam') {
      ctx.notify(t(lang, '模拟考试期间不可开启陪学点拨', 'Coach nudge is unavailable in exam mode'), 'info');
    } else if (!feedback) {
      ctx.notify(
        t(lang, '请先作答且答错或自评低于3分后再开启陪学点拨', 'Answer first (wrong or rating < 3) to open coach nudge'),
        'info',
      );
    } else {
      ctx.notify(
        t(lang, '仅在答错或自评低于3分时可开启陪学点拨', 'Coach nudge is only available for wrong answers or ratings < 3'),
        'info',
      );
    }
    return true;
  }
  if (input === 't' || input === 'T') {
    ctx.openGuidedStudy();
    return true;
  }
  if (input === 'W') {
    void ctx.handleToggleTranslate();
    return true;
  }
  if (input === 'S') {
    ctx.setSimilarModalOpen(true);
    return true;
  }
  if (input === 'R') {
    void ctx.handleRedoCard();
    return true;
  }
  if (input === 'D') {
    ctx.setCardToolsModalOpen(true);
    return true;
  }
  if (input === 'Q') {
    if (run.mode !== 'exam') {
      ctx.setQueueModalOpen(true);
    } else {
      ctx.notify(t(lang, '模拟考试队列已锁定，不能修改', 'Exam queue is locked'), 'info');
    }
    return true;
  }
  if (input === 'A') {
    ctx.setAnswerCardModalOpen(true);
    return true;
  }
  if (input === 'm') {
    ctx.setPreferences({ mathUnicode: !ctx.mathUnicode });
    return true;
  }
  if (input === 'E') {
    ctx.setFlagReason('');
    ctx.setFlagModalOpen(true);
    return true;
  }
  if (input === 'o' && ctx.citation) {
    ctx.pushCurrentToPracticeStack('source');
    ctx.setSkipUnmountPush(true);
    ctx.navigate('sources', { sourceId: ctx.citation.sourceId, pageNumber: ctx.citation.pageNumber });
    return true;
  }
  if (input === 'u' && !key.ctrl && !key.meta) {
    ctx.handleUndo();
    return true;
  }
  if (input === 's' && !feedback) {
    ctx.handleSkip();
    return true;
  }
  if (input === ',' || key.leftArrow) {
    ctx.handleMove(-1);
    return true;
  }
  if (input === '.' || key.rightArrow) {
    ctx.handleMove(1);
    return true;
  }
  if (input === 'X') {
    ctx.setConfirmEndOpen(true);
    return true;
  }

  // Rating phase for flashcards & self-graded open questions
  if (ctx.needsRating) {
    const gradeSpec = FSRS_GRADES.find((g) => g.key === input);
    if (gradeSpec) {
      ctx.handleFsrsGrade(gradeSpec.grade);
      return true;
    }
    return false;
  }

  // Post-feedback phase: Enter advances to next card
  if (feedback) {
    if (key.return) {
      ctx.handleMove(1);
      return true;
    }
    return false;
  }

  // Answering phase by kind
  if (kind === 'flashcard') {
    if (input === ' ' || key.return) {
      ctx.handleReveal();
      return true;
    }
    return false;
  }

  if (isRubricEligibleKind) {
    if (input === ' ') {
      ctx.handleReveal();
      return true;
    }
    if (input === 'i' || key.return) {
      ctx.setOpenEditing(true);
      return true;
    }
    return false;
  }

  if (kind === 'fill_blank') {
    if (input === 'i' || key.return) {
      ctx.setClozeEditing(true);
      return true;
    }
    return false;
  }

  if (kind === 'true_false') {
    if (input === '1') {
      const id = options[0]?.id || 'true';
      ctx.setSelectedIds([id]);
      ctx.handleSubmitChoice([id]);
      return true;
    }
    if (input === '2') {
      const id = options[1]?.id || 'false';
      ctx.setSelectedIds([id]);
      ctx.handleSubmitChoice([id]);
      return true;
    }
    if (key.downArrow || input === 'j') {
      ctx.setCursorOpt((prev) => Math.min(Math.max(0, options.length - 1), prev + 1));
      return true;
    }
    if (key.upArrow || input === 'k') {
      ctx.setCursorOpt((prev) => Math.max(0, prev - 1));
      return true;
    }
    if (key.return && options[cursorOpt]) {
      const id = options[cursorOpt].id;
      ctx.setSelectedIds([id]);
      ctx.handleSubmitChoice([id]);
      return true;
    }
    return false;
  }

  if (kind === 'single' || kind === 'multiple') {
    if (key.downArrow || input === 'j') {
      ctx.setCursorOpt((prev) => Math.min(Math.max(0, options.length - 1), prev + 1));
      return true;
    }
    if (key.upArrow || input === 'k') {
      ctx.setCursorOpt((prev) => Math.max(0, prev - 1));
      return true;
    }
    let pickedIdx = -1;
    if (/^[1-6]$/.test(input)) pickedIdx = Number(input) - 1;
    else if (/^[a-f]$/.test(input)) pickedIdx = input.charCodeAt(0) - 97;

    if (pickedIdx >= 0 && pickedIdx < options.length) {
      const targetId = options[pickedIdx].id;
      ctx.setCursorOpt(pickedIdx);
      if (kind === 'single') {
        ctx.setSelectedIds([targetId]);
        ctx.handleSubmitChoice([targetId]);
      } else {
        ctx.setSelectedIds((prev) =>
          prev.includes(targetId) ? prev.filter((x) => x !== targetId) : [...prev, targetId],
        );
      }
      return true;
    }

    if (kind === 'multiple') {
      if (input === ' ' && options[cursorOpt]) {
        const targetId = options[cursorOpt].id;
        ctx.setSelectedIds((prev) =>
          prev.includes(targetId) ? prev.filter((x) => x !== targetId) : [...prev, targetId],
        );
        return true;
      }
      if (key.return) {
        if (selectedIds.length > 0) {
          ctx.handleSubmitChoice(selectedIds);
          return true;
        }
        if (options[cursorOpt]) {
          const targetId = options[cursorOpt].id;
          ctx.setSelectedIds([targetId]);
          ctx.handleSubmitChoice([targetId]);
          return true;
        }
      }
    } else if (kind === 'single' && key.return && options[cursorOpt]) {
      const targetId = options[cursorOpt].id;
      ctx.setSelectedIds([targetId]);
      ctx.handleSubmitChoice([targetId]);
      return true;
    }
  }
  return false;
}

export interface ReviewEmptyKeyContext {
  endedRestoreFrame: PracticeContextFrame | null;
  setEndedRestoreFrame: (v: PracticeContextFrame | null) => void;
  handleRetryEndedCard: () => Promise<void>;
  navigate: (page: PageId) => void;
  goBack: () => void;
  loadInitialRun: (forceFresh?: boolean) => Promise<void>;
}

export function handleReviewEmptyKey(input: string, key: Key, ctx: ReviewEmptyKeyContext): boolean {
  if (ctx.endedRestoreFrame) {
    if (input === 'R' || key.return) {
      void ctx.handleRetryEndedCard();
      return true;
    }
    if (key.escape || input === 'l' || input === 'L') {
      ctx.setEndedRestoreFrame(null);
      ctx.navigate('library');
      return true;
    }
    return false;
  }
  if (key.escape) {
    ctx.goBack();
    return true;
  }
  if (input === 'l' || input === 'L') {
    ctx.navigate('library');
    return true;
  }
  if ((key.ctrl && input === 'r') || input === 'R') {
    void ctx.loadInitialRun(true);
    return true;
  }
  return false;
}
