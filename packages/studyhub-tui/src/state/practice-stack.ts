/**
 * Practice Context Stack (#1319 — Round 82 Track B0).
 *
 * Pure, in-memory LIFO stack tracking every jump away from an active practice card
 * (source reader, similar cards, wrongbook, exam coach, stats, search) so pressing global `r`
 * (or Esc inside nested similar-card runs) walks back layer-by-layer and restores the exact
 * question index and unsent drafts (choice / cloze / open) with zero re-grading or duplicate billing.
 */
import type { LastPracticeContext, NavigationContext, PageId, UiLanguage } from '../types/contracts.js';

export type PracticeOriginKind = 'source' | 'similar' | 'wrongbook' | 'coach' | 'stats' | 'search' | 'other';

export interface PracticeDraftSnapshot {
  /** Selected option IDs for single/multi/truefalse before submission. */
  selected?: string[];
  /** Unsubmitted fill-in-the-blank draft values. */
  clozeDrafts?: string[];
  /** Unsubmitted open/task answer draft text. */
  openDraft?: string;
}

export interface PracticeReadingPos {
  sourceId: string;
  pageNumber?: number;
  chapter?: string;
  scrollOffset?: number;
}

export interface PracticeContextFrame {
  /** 'review' returns to a specific question (restoring draft/index); 'page' returns to an intermediate page (e.g. reader p.12). */
  kind: 'review' | 'page';
  returnPage: PageId;
  navContext?: NavigationContext;
  runId?: string;
  cardId?: string;
  deckId?: string;
  /** 0-based card index within `runId` (displayed to user as `第 ${cardIndex + 1} 题`). */
  cardIndex?: number;
  total?: number;
  promptPreview?: string;
  /** Unsubmitted user draft captured when leaving the card. */
  draft?: PracticeDraftSnapshot;
  /** True if the card was already answered/graded before leaving — MUST NOT re-submit or re-grade on return. */
  submitted?: boolean;
  /** Reader position when leaving a document mid-chain. */
  readingPos?: PracticeReadingPos;
  originKind: PracticeOriginKind;
  pushedAt: number;
}

export const MAX_PRACTICE_STACK = 16;

function cloneDraft(draft?: PracticeDraftSnapshot): PracticeDraftSnapshot | undefined {
  if (!draft) return undefined;
  const out: PracticeDraftSnapshot = {};
  if (Array.isArray(draft.selected) && draft.selected.length > 0) out.selected = [...draft.selected];
  if (Array.isArray(draft.clozeDrafts) && draft.clozeDrafts.some((s) => s.length > 0)) {
    out.clozeDrafts = [...draft.clozeDrafts];
  }
  if (typeof draft.openDraft === 'string' && draft.openDraft.length > 0) out.openDraft = draft.openDraft;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Push a frame onto the LIFO stack, deduplicating an identical top frame and capping depth. */
export function pushPracticeFrame(
  stack: readonly PracticeContextFrame[],
  incoming: PracticeContextFrame,
): PracticeContextFrame[] {
  const frame: PracticeContextFrame = {
    ...incoming,
    draft: cloneDraft(incoming.draft),
    navContext: incoming.navContext ? { ...incoming.navContext } : undefined,
    readingPos: incoming.readingPos ? { ...incoming.readingPos } : undefined,
  };
  const top = stack[stack.length - 1];
  if (
    top &&
    top.kind === frame.kind &&
    top.returnPage === frame.returnPage &&
    top.runId === frame.runId &&
    top.cardId === frame.cardId &&
    top.readingPos?.sourceId === frame.readingPos?.sourceId &&
    top.readingPos?.pageNumber === frame.readingPos?.pageNumber
  ) {
    // Update top frame in-place (e.g. refreshed draft) instead of creating duplicate entries.
    return [...stack.slice(0, -1), frame];
  }
  return [...stack.slice(-(MAX_PRACTICE_STACK - 1)), frame];
}

/** Pop the topmost frame from the stack. */
export function popPracticeFrame(stack: readonly PracticeContextFrame[]): {
  frame: PracticeContextFrame | null;
  rest: PracticeContextFrame[];
} {
  if (stack.length === 0) return { frame: null, rest: [] };
  return {
    frame: stack[stack.length - 1],
    rest: stack.slice(0, -1),
  };
}

/** Return the most recent review frame in the stack (searching top-down). */
export function nearestReviewFrame(stack: readonly PracticeContextFrame[]): PracticeContextFrame | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].kind === 'review' && stack[i].cardId) return stack[i];
  }
  return null;
}

/** Return the earliest (root) origin review frame in the stack (e.g. the original card before nested similar jumps). */
export function originReviewFrame(stack: readonly PracticeContextFrame[]): PracticeContextFrame | null {
  for (let i = 0; i < stack.length; i += 1) {
    if (stack[i].kind === 'review' && stack[i].cardId) return stack[i];
  }
  return null;
}

/** Human-readable `[r]` return hint label for TopBar / SideNav / Footer. */
export function formatReturnHintLabel(stack: readonly PracticeContextFrame[], lang: UiLanguage): string | null {
  if (stack.length === 0) return null;
  const top = stack[stack.length - 1];
  const targetReview = top.kind === 'review' ? top : nearestReviewFrame(stack);
  const num = typeof targetReview?.cardIndex === 'number' ? targetReview.cardIndex + 1 : null;
  if (top.kind === 'page' && top.returnPage === 'sources' && top.readingPos?.pageNumber) {
    return lang === 'en'
      ? `Back p.${top.readingPos.pageNumber}${num ? ` (#${num})` : ''}`
      : `回原文p.${top.readingPos.pageNumber}${num ? `(第${num}题)` : ''}`;
  }
  if (num !== null) {
    return lang === 'en' ? `Back to #${num}` : `回到第 ${num} 题`;
  }
  return lang === 'en' ? 'Back to card' : '回到原题';
}

/** Convert a review context frame into the compact persistence record (IDs & indices only; never persists `promptPreview`, #1354 D11). */
export function toLastPracticeContext(frame: PracticeContextFrame): LastPracticeContext | null {
  if (frame.kind !== 'review' || !frame.runId || !frame.cardId) return null;
  return {
    runId: frame.runId,
    cardId: frame.cardId,
    ...(frame.deckId ? { deckId: frame.deckId } : {}),
    cardIndex: typeof frame.cardIndex === 'number' && frame.cardIndex >= 0 ? Math.floor(frame.cardIndex) : 0,
    ...(typeof frame.total === 'number' && frame.total > 0 ? { total: Math.floor(frame.total) } : {}),
    savedAt: frame.pushedAt || Date.now(),
  };
}
