/**
 * Shared TypeScript contracts for StudyHub TUI.
 * All workers import from here to guarantee type-safe integration with zero cross-file conflicts.
 */

export type PageId =
  | 'library'
  | 'review'
  | 'sources'
  | 'generate'
  | 'wrongbook'
  | 'exam'
  | 'dashboard'
  | 'book'
  | 'skeleton'
  | 'examcoach'
  | 'examprep'
  | 'notes'
  | 'board'
  | 'tasks'
  | 'audio'
  | 'settings';

export type NavGroup = 'daily' | 'exam' | 'tools';

export interface PageMeta {
  id: PageId;
  labelZh: string;
  labelEn: string;
  shortcut: string;
  group: NavGroup | null;
  icon: string;
  descriptionZh: string;
  descriptionEn: string;
}

export type ThemeId = 'dsh-dark' | 'warm-paper' | 'nord' | 'high-contrast' | 'warm-amber' | 'soft-sage';
export type UiLanguage = 'zh' | 'en';

export interface AssistantCommandStat {
  count: number;
  lastUsedAt: number;
}

export interface LastPracticeContext {
  runId: string;
  cardId: string;
  deckId?: string;
  cardIndex: number;
  total?: number;
  promptPreview?: string;
  savedAt: number;
}

export interface PinnedTarget {
  kind: 'page' | 'deck' | 'source';
  id: string;
  label: string;
}

export interface TuiPreferences {
  theme: ThemeId;
  language: UiLanguage;
  sidebarCollapsed: boolean;
  mathUnicode: boolean;
  compactMode: boolean;
  showKeyHints: boolean;
  /** Proactive non-interrupting study nudges (e.g. 20s stuck hint); defaults to true (Round 83 D1). */
  proactiveHints?: boolean;
  /** YYYY-MM-DD local date when the user dismissed the Daily Study Briefing (Round 85 D2). */
  dismissedBriefingDate?: string;
  /** ASCII-safe borders/bars/spinners for legacy Windows PowerShell 5.1 conhost or TERM=dumb. */
  asciiMode?: boolean;
  recentCommands: string[];
  /** Custom OpenAI presets saved by user (DSH-TUI style) */
  lastOpenAiPreset?: string;
  /** Persistent last-read page per document (LRU-bounded at 100 entries). */
  lastReadPages?: Record<string, number>;
  /** Last active practice card position for cross-restart resume (#1319). */
  lastPracticeContext?: LastPracticeContext;
  /** Per-page assistant command frequency for 3x chip promotion & recent pinning (#1315). */
  assistantCommandStats?: Record<string, Record<string, AssistantCommandStat>>;
  /** Pinned quick-jump bookmarks (max 5, Round 95 Track B9). */
  pinnedTargets?: PinnedTarget[];
}

export interface HostCallResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export interface ModelProviderInfo {
  id: string;
  name?: string;
  ready: boolean;
  status?: string;
  executablePath?: string;
  version?: string | null;
  models?: Array<{ id: string; label?: string; name?: string }>;
  reason?: string;
  unauthenticated?: boolean;
}

export interface DesktopConfigSnapshot {
  mode: 'agy' | 'openai' | 'codex';
  openai: {
    providerId: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    hasKey?: boolean;
    keyLast4?: string;
  };
  agy: {
    executablePath: string;
    model: string;
    effort: string;
  };
  codex: {
    executablePath: string;
    model: string;
    effort: string;
  };
  libraryRoot: string;
  libraryPlaceConfirmed: boolean;
  reasoningEffort: string;
  providers?: ModelProviderInfo[];
  effective?: {
    ready: boolean;
    label: string;
    reason: string;
    provider?: string;
    model?: string;
    maxConcurrency?: number | null;
    defaultConcurrency?: number | null;
  };
  configPath?: string;
  presets?: Array<{ id: string; name: string; baseUrl: string; defaultModel: string }>;
}

export interface BindingSnapshot {
  root: string;
  pickedRoot?: string;
  rootSource?: string;
  defaultRoot?: string;
  libraryProblem?: { message: string } | null;
  modelVia?: string;
  reasoningEffort?: string;
  route?: { provider: string; model: string; reasoningEffort?: string } | null;
  modelStatus?: { ready?: boolean; label?: string; reason?: string };
}

export interface LibraryEvent {
  type: string;
  revision?: number;
  source?: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HostClient {
  /** Execute any StudyRuntime or Desktop host action. */
  call<T = any>(action: string, args?: Record<string, unknown>): Promise<HostCallResult<T>>;
  /** Subscribe to live library / job events. Returns unsubscribe function. */
  subscribeEvents(listener: (event: LibraryEvent) => void): () => void;
  /** Get current library root path. */
  getLibraryRoot(): string;
  /** Get current desktop config snapshot (if loaded). */
  getConfig(): DesktopConfigSnapshot | null;
  /** Direct streaming LLM helper using active agy/OpenAI route (for interactive Q&A/help). */
  streamComplete?(params: {
    system: string;
    prompt: string;
    /** Optional true multi-turn message history (#1445). When provided, OpenAI-compatible routes send it natively. */
    messages?: readonly ChatMessage[];
    signal?: AbortSignal;
    onChunk?: (delta: string) => void;
    onReasoning?: (chars: number) => void;
  }): Promise<string>;
  /** Dispose watchers, locks, and background services cleanly. */
  dispose(): Promise<void>;
}

export interface ToastItem {
  id: string;
  text: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  createdAt: number;
}

export interface KeyHint {
  key: string;
  label: string;
}

export interface NavigationContext {
  course?: string | null;
  deckId?: string;
  runId?: string;
  sourceId?: string;
  pageNumber?: number;
  draftId?: string;
  noteId?: string;
  jobId?: string;
  examId?: string;
  focusPointKey?: string;
  sourceIds?: string[];
  mode?: string;
}

export interface CommandPaletteItem {
  id: string;
  label: string;
  category: string;
  hint?: string;
  shortcut?: string;
  keywords?: string[];
  action: () => void | Promise<void>;
}

/** Loose typed view of StudyHub snapshot returned by `snapshot` action. */
export interface StudySnapshot {
  root?: string;
  revision?: number;
  fingerprint?: string;
  modelReady?: boolean;
  courses?: Array<{
    name?: string;
    id?: string;
    title?: string;
    active?: boolean;
    deckCount?: number;
    cardCount?: number;
    dueCount?: number;
    masteredCount?: number;
    sourceCount?: number;
    [k: string]: unknown;
  }>;
  decks?: Array<{
    id: string;
    title?: string;
    name?: string;
    course?: string;
    archived?: boolean;
    cardCount?: number;
    dueCount?: number;
    masteredCount?: number;
    newCount?: number;
    wrongCount?: number;
    updatedAt?: number | string;
    lastStudiedAt?: number | string;
    [k: string]: unknown;
  }>;
  sources?: Array<{
    id: string;
    title?: string;
    name?: string;
    filename?: string;
    format?: string;
    ext?: string;
    course?: string;
    courses?: string[];
    folder?: string;
    pageCount?: number;
    pages?: number;
    status?: string;
    archived?: boolean;
    pinned?: boolean;
    cardCount?: number;
    updatedAt?: number | string;
    [k: string]: unknown;
  }>;
  drafts?: Array<{
    id: string;
    title?: string;
    course?: string;
    cardCount?: number;
    cards?: unknown[];
    status?: string;
    createdAt?: number | string;
    [k: string]: unknown;
  }>;
  jobs?: Array<{
    id: string;
    type?: string;
    kind?: string;
    title?: string;
    status?: string;
    progress?: number;
    phase?: string;
    message?: string;
    error?: string;
    course?: string;
    draftId?: string;
    createdAt?: number | string;
    updatedAt?: number | string;
    [k: string]: unknown;
  }>;
  archivedJobs?: Array<Record<string, unknown>>;
  runs?: Array<{
    id: string;
    title?: string;
    deckId?: string;
    course?: string;
    mode?: string;
    status?: string;
    total?: number;
    answered?: number;
    index?: number;
    updatedAt?: number | string;
    [k: string]: unknown;
  }>;
  lastRun?: Record<string, unknown> | null;
  today?: {
    due?: number;
    reviewed?: number;
    new?: number;
    streak?: number;
    goal?: number;
    [k: string]: unknown;
  };
  progress?: Record<string, unknown>;
  focus?: { course?: string | null; [k: string]: unknown };
  settings?: Record<string, unknown>;
  notes?: Array<Record<string, unknown>>;
  exams?: Array<Record<string, unknown>>;
  oralExams?: Array<Record<string, unknown>>;
  skeletons?: Array<Record<string, unknown>>;
  examPointLists?: Array<Record<string, unknown>>;
  sample?: { loaded?: boolean; [k: string]: unknown };
  coach?: Record<string, unknown>;
  bookCourses?: Array<Record<string, unknown>>;
  materialCoverage?: Record<string, unknown>;
  materialMastery?: Record<string, unknown>;
  materialFolders?: Array<Record<string, unknown>>;
  inbox?: Array<Record<string, unknown>>;
  attempts?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ViewProps {
  host: HostClient;
  width: number;
  height: number;
  isActive: boolean;
}

export const PAGE_REGISTRY: readonly PageMeta[] = Object.freeze([
  { id: 'library', labelZh: '学习库', labelEn: 'Library', shortcut: '1', group: 'daily', icon: '◈', descriptionZh: '今日计划、课程与题组总览', descriptionEn: 'Today plan, courses & decks' },
  { id: 'sources', labelZh: '资料', labelEn: 'Sources', shortcut: '2', group: 'daily', icon: '▤', descriptionZh: '导入讲义课件与分页阅读', descriptionEn: 'Import & read study materials' },
  { id: 'generate', labelZh: '创建题组', labelEn: 'Generate', shortcut: '3', group: 'daily', icon: '✦', descriptionZh: '从资料生成题目与审核草稿', descriptionEn: 'Generate questions & edit drafts' },
  { id: 'wrongbook', labelZh: '错题本', labelEn: 'Mistakes', shortcut: '4', group: 'daily', icon: '✕', descriptionZh: '错题归因与 0-token 错题分流', descriptionEn: 'Mistakes & 0-token triage' },
  { id: 'exam', labelZh: '模拟考试', labelEn: 'Mock Exam', shortcut: '5', group: 'exam', icon: '◷', descriptionZh: '选择题卷、案例卷与口试', descriptionEn: 'Written, case & oral exams' },
  { id: 'dashboard', labelZh: '学习统计', labelEn: 'Stats', shortcut: '6', group: 'exam', icon: '▥', descriptionZh: '掌握度热力图与薄弱点分析', descriptionEn: 'Mastery heatmap & analytics' },
  { id: 'book', labelZh: '复习全书', labelEn: 'Book', shortcut: '7', group: 'exam', icon: '▣', descriptionZh: '按知识点串讲与即时练习', descriptionEn: 'Structured review book' },
  { id: 'skeleton', labelZh: '知识骨架', labelEn: 'Skeleton', shortcut: '8', group: 'exam', icon: '⎇', descriptionZh: '课程知识层级树与前置关系', descriptionEn: 'Knowledge hierarchy tree' },
  { id: 'examcoach', labelZh: '考试教练', labelEn: 'Coach', shortcut: '9', group: 'exam', icon: '◎', descriptionZh: '考法校准与能力证据检查', descriptionEn: 'Exam style calibration' },
  { id: 'examprep', labelZh: '备考补习', labelEn: 'Exam Prep', shortcut: '0', group: 'exam', icon: '⚑', descriptionZh: '考纲重点与查漏补缺', descriptionEn: 'Syllabus focus & gap-fill' },
  { id: 'notes', labelZh: '学习笔记', labelEn: 'Notes', shortcut: 'n', group: 'tools', icon: '✎', descriptionZh: '题后笔记、每日复盘与导出', descriptionEn: 'Study notes & daily recaps' },
  { id: 'board', labelZh: '待办看板', labelEn: 'Board', shortcut: 'b', group: 'tools', icon: '▦', descriptionZh: '三列终端任务看板', descriptionEn: '3-column Kanban board' },
  { id: 'tasks', labelZh: '后台任务', labelEn: 'Jobs', shortcut: 't', group: 'tools', icon: '⟳', descriptionZh: '出题与解析任务进度监控', descriptionEn: 'Background generation jobs' },
  { id: 'audio', labelZh: '音频转写', labelEn: 'Audio', shortcut: 'a', group: 'tools', icon: '♪', descriptionZh: '导入录音转写文本与出题', descriptionEn: 'Audio recording transcription' },
  { id: 'settings', labelZh: '设置', labelEn: 'Settings', shortcut: ',', group: 'tools', icon: '⚙', descriptionZh: 'agy CLI 主模型 / OpenAI 配置与外观', descriptionEn: 'Model providers, workspace & UI' },
  { id: 'review', labelZh: '刷题复习', labelEn: 'Review', shortcut: 'r', group: null, icon: '▶', descriptionZh: 'FSRS-6 间隔复习与 AI 追问', descriptionEn: 'FSRS-6 practice & AI help' },
]);
