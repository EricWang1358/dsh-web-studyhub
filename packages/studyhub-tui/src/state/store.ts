import { create } from 'zustand';
import type {
  BindingSnapshot,
  DesktopConfigSnapshot,
  KeyHint,
  NavigationContext,
  PageId,
  StudySnapshot,
  ThemeId,
  ToastItem,
  TuiPreferences,
  UiLanguage,
} from '../types/contracts.js';
import {
  popPracticeFrame,
  pushPracticeFrame,
  type PracticeContextFrame,
} from './practice-stack.js';
import type { GuidedStageId } from '../render/clipboard.js';

export type AssistantTabId = 'assistant' | 'guided';

export interface AssistantCardCitation {
  sourceId?: string;
  sourceTitle?: string;
  pageNumber?: number;
  quote?: string;
}

export interface AssistantCardContext {
  runId?: string;
  deckId?: string;
  cardId: string;
  cardIndex?: number;
  queueVersion?: number;
  teachingId?: string;
  teachingMode?: string;
  total?: number;
  topic?: string;
  prompt?: string;
  options?: Array<{ id: string; text: string; correct?: boolean }>;
  userAnswer?: string;
  /** Fixed grounding fields for true multi-turn assistant tutoring (#1445). */
  answer?: string;
  explanation?: string;
  citations?: AssistantCardCitation[];
  kind?: string;
  isWrong?: boolean;
  revealed?: boolean;
  isExam?: boolean;
  hasCitation?: boolean;
  /** Optional active page filter or selected item label for full context awareness (#1315). */
  filterQuery?: string;
  selectedLabel?: string;
}

/** The parts of a review run the store hands from the assistant to ReviewView (#1447). */
export type ReviewRunLike = {
  id?: string;
  index?: number;
  deckId?: string | null;
  card?: { id?: string; [k: string]: unknown } | null;
  [k: string]: unknown;
};

export const DEFAULT_PREFERENCES: TuiPreferences = {
  theme: 'dsh-dark',
  language: 'zh',
  sidebarCollapsed: false,
  mathUnicode: true,
  compactMode: false,
  showKeyHints: true,
  asciiMode: false,
  recentCommands: [],
};

const MAX_HISTORY = 24;
const MAX_TOASTS = 4;
export const MAX_TOAST_HISTORY = 50;

export interface PomodoroState {
  phase: 'work' | 'break';
  running: boolean;
  remainingSec: number;
  endsAt: number | null;
  workMinutes: number;
  breakMinutes: number;
}

const DEFAULT_POMODORO: PomodoroState = {
  phase: 'work',
  running: false,
  remainingSec: 25 * 60,
  endsAt: null,
  workMinutes: 25,
  breakMinutes: 5,
};

export interface TuiStoreState {
  page: PageId;
  navContext: NavigationContext;
  history: Array<{ page: PageId; navContext: NavigationContext }>;

  /** Whether any modal / overlay / text input currently captures global single-key shortcuts. */
  inputCaptured: boolean;
  commandPaletteOpen: boolean;
  helpOpen: boolean;
  helpTab: 'shortcuts' | 'guide';
  coursePickerOpen: boolean;
  voicePackOpen: boolean;
  inboxOpen: boolean;
  /** Standalone notification history panel (#1354 P2-b). */
  notificationHistoryOpen: boolean;
  showLaunchpad: boolean;

  /** Practice Context Stack (#1319) — LIFO stack preserving question/draft/reading state across jumps. */
  practiceStack: PracticeContextFrame[];
  pendingPracticeRestore: PracticeContextFrame | null;

  /**
   * The run an assistant action got back from the backend (#1447). Review consumes it and applies it,
   * so a slay/undo/queue edit/grade change made in the assistant is visible there immediately.
   */
  pendingReviewRun: ReviewRunLike | null;
  /** Bumped with every pending run, so an identical run is still applied. */
  pendingReviewRunSeq: number;
  setPendingReviewRun: (run: ReviewRunLike | null) => void;
  consumePendingReviewRun: () => ReviewRunLike | null;

  /** Persistent AI Assistant + Guided Study/Retell panel (#1315 Phase 1). Opening/closing NEVER touches practiceStack. */
  assistantOpen: boolean;
  /** True only when user explicitly focuses the docked panel (or fullscreen); false keeps page focus for answering/paging! */
  assistantFocused: boolean;
  assistantTab: AssistantTabId;
  assistantStage: GuidedStageId;
  assistantFullscreen: boolean;
  assistantCardContext: AssistantCardContext | null;

  /** Core StudyHub backend state */
  snapshot: StudySnapshot | null;
  binding: BindingSnapshot | null;
  desktopConfig: DesktopConfigSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  lastError: string | null;
  activeRunId: string | null;
  quitConfirmOpen: boolean;
  quitGuard: (() => boolean) | null;

  /** UI feedback */
  toasts: ToastItem[];
  /** Persistent recent notifications ring buffer (up to MAX_TOAST_HISTORY) for recall after auto-dismiss (#1354 P2-b). */
  toastHistory: ToastItem[];
  footerHints: KeyHint[];
  preferences: TuiPreferences;
  pomodoro: PomodoroState;

  /** Actions */
  navigate: (page: PageId, context?: NavigationContext) => void;
  goBack: () => void;
  setInputCaptured: (captured: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean, tab?: 'shortcuts' | 'guide') => void;
  setHelpTab: (tab: 'shortcuts' | 'guide') => void;
  setCoursePickerOpen: (open: boolean) => void;
  setVoicePackOpen: (open: boolean) => void;
  setInboxOpen: (open: boolean) => void;
  setNotificationHistoryOpen: (open: boolean) => void;
  setShowLaunchpad: (show: boolean) => void;

  pushPracticeContext: (frame: PracticeContextFrame) => void;
  popPracticeContext: () => PracticeContextFrame | null;
  returnViaPracticeStack: () => PracticeContextFrame | null;
  consumePendingPracticeRestore: () => PracticeContextFrame | null;
  clearPracticeStack: () => void;

  openAssistant: (opts?: {
    tab?: AssistantTabId;
    stage?: GuidedStageId;
    fullscreen?: boolean;
    focused?: boolean;
    cardContext?: AssistantCardContext | null;
  }) => void;
  closeAssistant: () => void;
  setAssistantFocused: (focused: boolean) => void;
  setAssistantTab: (tab: AssistantTabId) => void;
  setAssistantStage: (stage: GuidedStageId) => void;
  setAssistantFullscreen: (fullscreen: boolean) => void;
  setAssistantCardContext: (ctx: AssistantCardContext | null) => void;

  setSnapshot: (snapshot: StudySnapshot | null) => void;
  setBinding: (binding: BindingSnapshot | null) => void;
  setDesktopConfig: (config: DesktopConfigSnapshot | null) => void;
  setLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean) => void;
  setLastError: (err: string | null) => void;
  setActiveRunId: (runId: string | null) => void;
  setQuitConfirmOpen: (open: boolean) => void;
  registerQuitGuard: (guard: () => boolean) => () => void;

  notify: (text: string, tone?: ToastItem['tone'], source?: string) => void;
  dismissToast: (id: string) => void;
  clearToastHistory: () => void;
  setFooterHints: (hints: KeyHint[]) => void;

  setPreferences: (patch: Partial<TuiPreferences>) => void;
  setTheme: (theme: ThemeId) => void;
  setLanguage: (language: UiLanguage) => void;
  toggleSidebar: () => void;
  recordRecentCommand: (commandId: string) => void;
  setPomodoro: (patch: Partial<PomodoroState> | ((prev: PomodoroState) => Partial<PomodoroState>)) => void;
  resetPomodoro: () => void;
}

let toastSeq = 0;
let quitGuards: Array<() => boolean> = [];

export const useTuiStore = create<TuiStoreState>((set, get) => ({
  page: 'library',
  navContext: {},
  history: [],

  inputCaptured: false,
  commandPaletteOpen: false,
  helpOpen: false,
  helpTab: 'shortcuts',
  coursePickerOpen: false,
  voicePackOpen: false,
  inboxOpen: false,
  notificationHistoryOpen: false,
  showLaunchpad: false,
  practiceStack: [],
  pendingPracticeRestore: null,
  pendingReviewRun: null,
  pendingReviewRunSeq: 0,
  assistantOpen: false,
  assistantFocused: false,
  assistantTab: 'assistant',
  assistantStage: 'question',
  assistantFullscreen: false,
  assistantCardContext: null,

  snapshot: null,
  binding: null,
  desktopConfig: null,
  loading: true,
  refreshing: false,
  lastError: null,
  activeRunId: null,
  quitConfirmOpen: false,
  quitGuard: null,

  toasts: [],
  toastHistory: [],
  footerHints: [],
  preferences: { ...DEFAULT_PREFERENCES },
  pomodoro: { ...DEFAULT_POMODORO },

  navigate: (page, context = {}) => {
    const prev = get();
    const nextHistory =
      prev.page === page
        ? prev.history
        : [...prev.history.slice(-(MAX_HISTORY - 1)), { page: prev.page, navContext: prev.navContext }];
    set({
      page,
      navContext: context,
      history: nextHistory,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      notificationHistoryOpen: false,
      showLaunchpad: false,
      ...(page === 'review' && context.runId ? { activeRunId: context.runId } : {}),
    });
  },

  goBack: () => {
    const prev = get();
    // #1412: on the practice page the docked assistant is the top-most layer: "back" folds it away
    // first, so a second Esc after returning the keyboard to the page never ends the run by surprise.
    if (prev.page === 'review' && prev.assistantOpen && !prev.assistantFocused && !prev.assistantFullscreen) {
      set({ assistantOpen: false, assistantFocused: false, assistantFullscreen: false });
      return;
    }
    if (prev.history.length === 0) {
      if (prev.page !== 'library') set({ page: 'library', navContext: {} });
      return;
    }
    const target = prev.history[prev.history.length - 1];
    set({
      page: target.page,
      navContext: target.navContext,
      history: prev.history.slice(0, -1),
    });
  },

  setInputCaptured: (inputCaptured) => set({ inputCaptured }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setHelpOpen: (helpOpen, tab) =>
    set((state) => ({
      helpOpen,
      helpTab: tab ?? (helpOpen ? 'shortcuts' : state.helpTab),
    })),
  setHelpTab: (helpTab) => set({ helpTab }),
  setCoursePickerOpen: (coursePickerOpen) => set({ coursePickerOpen }),
  setVoicePackOpen: (voicePackOpen) => set({ voicePackOpen }),
  setInboxOpen: (inboxOpen) => set({ inboxOpen }),
  setNotificationHistoryOpen: (notificationHistoryOpen) => set({ notificationHistoryOpen }),
  setShowLaunchpad: (showLaunchpad) => set({ showLaunchpad }),

  pushPracticeContext: (frame) =>
    set((state) => ({
      practiceStack: pushPracticeFrame(state.practiceStack, frame),
    })),

  popPracticeContext: () => {
    const prev = get();
    const { frame, rest } = popPracticeFrame(prev.practiceStack);
    if (!frame) return null;
    set({
      practiceStack: rest,
      ...(frame.kind === 'review' ? { pendingPracticeRestore: frame } : {}),
    });
    return frame;
  },

  returnViaPracticeStack: () => {
    const frame = get().popPracticeContext();
    if (!frame) return null;
    if (frame.kind === 'review') {
      get().navigate('review', {
        ...(frame.runId ? { runId: frame.runId } : {}),
        ...(frame.deckId ? { deckId: frame.deckId } : {}),
      });
    } else {
      const ctx = frame.navContext ?? (frame.readingPos ? { sourceId: frame.readingPos.sourceId, pageNumber: frame.readingPos.pageNumber } : {});
      get().navigate(frame.returnPage, ctx);
    }
    return frame;
  },

  consumePendingPracticeRestore: () => {
    const frame = get().pendingPracticeRestore;
    if (frame) set({ pendingPracticeRestore: null });
    return frame;
  },

  clearPracticeStack: () => set({ practiceStack: [], pendingPracticeRestore: null }),

  setPendingReviewRun: (run) =>
    set((state) => ({
      pendingReviewRun: run,
      pendingReviewRunSeq: run ? state.pendingReviewRunSeq + 1 : state.pendingReviewRunSeq,
    })),

  consumePendingReviewRun: () => {
    const run = get().pendingReviewRun;
    if (run) set({ pendingReviewRun: null });
    return run;
  },

  openAssistant: (opts) =>
    set((state) => ({
      assistantOpen: true,
      assistantFocused: opts?.focused ?? true,
      assistantTab: opts?.tab ?? state.assistantTab,
      assistantStage: opts?.stage ?? state.assistantStage,
      assistantFullscreen: opts?.fullscreen ?? state.assistantFullscreen,
      ...(opts?.cardContext !== undefined ? { assistantCardContext: opts.cardContext } : {}),
    })),

  closeAssistant: () => set({ assistantOpen: false, assistantFocused: false, assistantFullscreen: false }),
  setAssistantFocused: (assistantFocused) => set({ assistantFocused }),
  setAssistantTab: (assistantTab) => set({ assistantTab }),
  setAssistantStage: (assistantStage) => set({ assistantStage }),
  setAssistantFullscreen: (assistantFullscreen) => set({ assistantFullscreen }),
  setAssistantCardContext: (next) =>
    set((state) => {
      const prev = state.assistantCardContext;
      if (prev === next) return state;
      if (
        prev &&
        next &&
        prev.runId === next.runId &&
        prev.deckId === next.deckId &&
        prev.cardId === next.cardId &&
        prev.cardIndex === next.cardIndex &&
        prev.queueVersion === next.queueVersion &&
        prev.teachingId === next.teachingId &&
        prev.teachingMode === next.teachingMode &&
        prev.total === next.total &&
        prev.prompt === next.prompt &&
        prev.userAnswer === next.userAnswer &&
        prev.kind === next.kind &&
        prev.isWrong === next.isWrong &&
        prev.revealed === next.revealed &&
        prev.isExam === next.isExam &&
        prev.hasCitation === next.hasCitation
      ) {
        return state;
      }
      return { assistantCardContext: next };
    }),

  setSnapshot: (snapshot) => {
    const activeRun =
      (snapshot?.lastRun && typeof snapshot.lastRun === 'object' && typeof (snapshot.lastRun as Record<string, unknown>).id === 'string'
        ? String((snapshot.lastRun as Record<string, unknown>).id)
        : null) ||
      snapshot?.runs?.find((r) => r.status === 'active' || r.status === 'in_progress')?.id ||
      get().activeRunId;
    set({ snapshot, activeRunId: activeRun || null });
  },

  setBinding: (binding) => set({ binding }),
  setDesktopConfig: (desktopConfig) => set({ desktopConfig }),
  setLoading: (loading) => set({ loading }),
  setRefreshing: (refreshing) => set({ refreshing }),
  setLastError: (lastError) => set({ lastError }),
  setActiveRunId: (activeRunId) => set({ activeRunId }),
  setQuitConfirmOpen: (quitConfirmOpen) => set({ quitConfirmOpen }),
  registerQuitGuard: (guard) => {
    quitGuards = [...quitGuards.filter((g) => g !== guard), guard];
    set({ quitGuard: guard });
    return () => {
      quitGuards = quitGuards.filter((g) => g !== guard);
      if (get().quitGuard === guard) set({ quitGuard: quitGuards.at(-1) ?? null });
    };
  },

  notify: (text, tone = 'info', source) => {
    const id = `toast-${++toastSeq}`;
    const item: ToastItem = { id, text, tone, createdAt: Date.now(), ...(source ? { source } : {}) };
    set((state) => ({
      toasts: [...state.toasts.slice(-(MAX_TOASTS - 1)), item],
      toastHistory: [...state.toastHistory.slice(-(MAX_TOAST_HISTORY - 1)), item],
    }));
  },

  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  clearToastHistory: () => set({ toastHistory: [] }),

  setFooterHints: (footerHints) => set({ footerHints }),

  setPreferences: (patch) =>
    set((state) => ({
      preferences: { ...state.preferences, ...patch },
    })),

  setTheme: (theme) =>
    set((state) => ({
      preferences: { ...state.preferences, theme },
    })),

  setLanguage: (language) =>
    set((state) => ({
      preferences: { ...state.preferences, language },
    })),

  toggleSidebar: () =>
    set((state) => ({
      preferences: { ...state.preferences, sidebarCollapsed: !state.preferences.sidebarCollapsed },
    })),

  recordRecentCommand: (commandId) =>
    set((state) => {
      const next = [commandId, ...state.preferences.recentCommands.filter((id) => id !== commandId)].slice(0, 12);
      return { preferences: { ...state.preferences, recentCommands: next } };
    }),

  setPomodoro: (patch) =>
    set((state) => {
      const resolved = typeof patch === 'function' ? patch(state.pomodoro) : patch;
      return { pomodoro: { ...state.pomodoro, ...resolved } };
    }),

  resetPomodoro: () =>
    set((state) => {
      const mins = state.pomodoro.phase === 'work' ? state.pomodoro.workMinutes : state.pomodoro.breakMinutes;
      return {
        pomodoro: {
          ...state.pomodoro,
          running: false,
          endsAt: null,
          remainingSec: mins * 60,
        },
      };
    }),
}));

/** Helper for bilingual copy */
export function t(lang: UiLanguage, zh: string, en: string): string {
  return lang === 'en' ? en : zh;
}
