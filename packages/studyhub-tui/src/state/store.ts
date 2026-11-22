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

export interface TuiStoreState {
  page: PageId;
  navContext: NavigationContext;
  history: Array<{ page: PageId; navContext: NavigationContext }>;

  /** Whether any modal / overlay / text input currently captures global single-key shortcuts. */
  inputCaptured: boolean;
  commandPaletteOpen: boolean;
  helpOpen: boolean;
  coursePickerOpen: boolean;
  voicePackOpen: boolean;
  showLaunchpad: boolean;

  /** Core StudyHub backend state */
  snapshot: StudySnapshot | null;
  binding: BindingSnapshot | null;
  desktopConfig: DesktopConfigSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  lastError: string | null;
  activeRunId: string | null;

  /** UI feedback */
  toasts: ToastItem[];
  footerHints: KeyHint[];
  preferences: TuiPreferences;

  /** Actions */
  navigate: (page: PageId, context?: NavigationContext) => void;
  goBack: () => void;
  setInputCaptured: (captured: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setCoursePickerOpen: (open: boolean) => void;
  setVoicePackOpen: (open: boolean) => void;
  setShowLaunchpad: (show: boolean) => void;

  setSnapshot: (snapshot: StudySnapshot | null) => void;
  setBinding: (binding: BindingSnapshot | null) => void;
  setDesktopConfig: (config: DesktopConfigSnapshot | null) => void;
  setLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean) => void;
  setLastError: (err: string | null) => void;
  setActiveRunId: (runId: string | null) => void;

  notify: (text: string, tone?: ToastItem['tone']) => void;
  dismissToast: (id: string) => void;
  setFooterHints: (hints: KeyHint[]) => void;

  setPreferences: (patch: Partial<TuiPreferences>) => void;
  setTheme: (theme: ThemeId) => void;
  setLanguage: (language: UiLanguage) => void;
  toggleSidebar: () => void;
  recordRecentCommand: (commandId: string) => void;
}

let toastSeq = 0;

export const useTuiStore = create<TuiStoreState>((set, get) => ({
  page: 'library',
  navContext: {},
  history: [],

  inputCaptured: false,
  commandPaletteOpen: false,
  helpOpen: false,
  coursePickerOpen: false,
  voicePackOpen: false,
  showLaunchpad: false,

  snapshot: null,
  binding: null,
  desktopConfig: null,
  loading: true,
  refreshing: false,
  lastError: null,
  activeRunId: null,

  toasts: [],
  footerHints: [],
  preferences: { ...DEFAULT_PREFERENCES },

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
      showLaunchpad: false,
      ...(page === 'review' && context.runId ? { activeRunId: context.runId } : {}),
    });
  },

  goBack: () => {
    const prev = get();
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
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setCoursePickerOpen: (coursePickerOpen) => set({ coursePickerOpen }),
  setVoicePackOpen: (voicePackOpen) => set({ voicePackOpen }),
  setShowLaunchpad: (showLaunchpad) => set({ showLaunchpad }),

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

  notify: (text, tone = 'info') => {
    const id = `toast-${++toastSeq}`;
    const item: ToastItem = { id, text, tone, createdAt: Date.now() };
    set((state) => ({
      toasts: [...state.toasts.slice(-(MAX_TOASTS - 1)), item],
    }));
  },

  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

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
}));

/** Helper for bilingual copy */
export function t(lang: UiLanguage, zh: string, en: string): string {
  return lang === 'en' ? en : zh;
}
