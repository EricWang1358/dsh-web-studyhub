import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, ProgressBar, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { useInputCapture } from '../../components/focus.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import {
  dayModeMeta,
  formatPlanDayReason,
  planScheduleDays,
  type CoursePlanDay,
  type CoursePlanPoint,
  type CoursePlanResponse,
} from './course-plan-display.js';

export interface StudyPlanModalProps {
  host: HostClient;
  course: string;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
  onUpdated?: () => void;
}

type ModalTab = 'plan' | 'readiness' | 'custom';

type CustomPurpose = 'preview' | 'follow' | 'review' | 'openbook';
type CustomScopeKind = 'all' | 'exam' | 'chapters';
type BookPart = 'explain' | 'terms' | 'formulas' | 'index' | 'confusables' | 'answerKit' | 'cheatSheet';
type QuestionStrength = 'lean' | 'standard' | 'full';
type CustomRowId =
  | 'purpose'
  | 'scope'
  | `part:${BookPart}`
  | 'strength'
  | 'minutes';

interface CustomPlanConfig {
  version: 1;
  purpose: CustomPurpose;
  scope: {
    kind: CustomScopeKind;
    chapters?: string[];
    resolvedChapters?: string[];
    titles?: Array<string | null>;
    note?: string;
  };
  book: {
    make: boolean;
    coverage: 'brief' | 'standard' | 'full';
    parts: BookPart[];
  };
  questions: {
    make: boolean;
    kinds: string[];
    strength: QuestionStrength;
    variants: boolean;
  };
  plan: {
    make: boolean;
    by: 'exam' | 'weekly';
    chaptersPerWeek?: number;
    minutesPerDay?: number;
  };
  sampleFirst: boolean;
}

interface CustomOptionRow {
  id: CustomRowId;
  label: string;
  value: string;
  note: string;
  detail: string;
  enabled?: boolean;
  locked?: boolean;
}

interface CustomReadinessChapter {
  id: string;
  title: string;
  built: boolean;
  points: number;
  explained: number | null;
  asked: number | null;
  drafted: number | null;
  practised: number | null;
  solid: number | null;
  weak: number | null;
  readiness: number | null;
  quality?: { sentBack?: number };
  todo: {
    explain: number;
    questions: number;
    weak: number;
  };
  gapHint?: string;
}

interface CustomReadinessResponse {
  status: 'ok' | 'no-course' | 'no-book' | string;
  course: string | null;
  basis: 'outline' | 'documents' | string;
  plan: boolean;
  counted: {
    explained: boolean;
    questions: boolean;
  };
  unknownChapters: string[];
  chapters: CustomReadinessChapter[];
  total: {
    points: number;
    explained: number | null;
    asked: number | null;
    practised: number | null;
    solid: number | null;
    readiness: number | null;
  };
}

interface TokenRange {
  low: number;
  high: number;
}

interface CustomPreviewResponse {
  status: 'ok' | 'no-course' | string;
  course: string | null;
  skeleton?: {
    basis: 'outline' | 'documents' | string;
    outline?: { id?: string; stale?: boolean; chapters?: Array<{ id: string; title: string; points?: number }> };
  };
  defaults?: Partial<Record<CustomPurpose, CustomPlanConfig>>;
  estimate?: {
    book?: {
      points: number;
      calls: number;
      readTokens: TokenRange;
    };
    questions?: {
      count: number;
      runs: number;
      calls: number;
      readTokens: TokenRange;
    };
    total?: {
      calls: number;
      readTokens: TokenRange;
    };
    rough?: boolean;
  } | null;
  filled?: CustomPlanConfig | null;
  saved?: CustomPlanConfig | null;
  unknownChapters?: string[];
  examScope?: {
    matchedChapters?: Array<{ id: string; title: string }>;
    unmatchedTopics?: string[];
    coverageNote?: string;
    confirmed?: boolean;
    resolvedChapters?: string[] | null;
  } | null;
}

interface CustomApplyItem {
  step: string;
  jobId?: string;
  what: string;
}

interface CustomApplyResponse {
  status: 'ok' | 'no-course' | 'no-plan' | string;
  course: string | null;
  started: CustomApplyItem[];
  waiting: CustomApplyItem[];
  recorded: CustomApplyItem[];
  done: CustomApplyItem[];
  examScope?: CustomPreviewResponse['examScope'];
}

interface CourseRecordView {
  id?: string;
  name?: string;
  virtual?: boolean;
  exam?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  focusTopics?: string[];
  guidanceSourceIds?: string[];
  custom?: CustomPlanConfig | null;
}

interface CustomFillResponse {
  status: 'ok' | 'nothing' | 'no-course' | 'no-book' | 'no-outline' | 'exam-scope-unconfirmed' | string;
  course: string | null;
  chapters: string[];
  unknownChapters: string[];
  estimate: boolean;
  book: null | { chapters: string[]; points: number; calls: { low: number; high: number } | null };
  questions: null | { points: number; chapters: number; sources?: number; calls: { low: number; high: number } | null };
  variants: null | { cards: number; points: number; calls: { low: number; high: number } | null };
  calls: { low: number; high: number } | null;
  started?: {
    book?: { error?: string; alreadyRunning?: boolean; [k: string]: unknown };
    questions?: { error?: string; alreadyRunning?: boolean; leftToRunning?: number; [k: string]: unknown };
    variants?: { error?: string; needsConsent?: boolean; [k: string]: unknown };
  };
}

function fmtCount(val: number | null | undefined): string {
  return typeof val === 'number' && Number.isFinite(val) ? String(val) : '-';
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTokenRange(range: TokenRange | undefined | null): string {
  if (!range) return '-';
  const low = fmtTokens(range.low);
  const high = fmtTokens(range.high);
  return low === high ? low : `${low}~${high}`;
}

function fmtCallRange(range: { low: number; high: number } | null | undefined): string {
  if (!range) return '-';
  return range.low === range.high ? String(range.low) : `${range.low}~${range.high}`;
}

function planStatusMeta(status: string, lang: 'zh' | 'en'): { label: string; tone: 'success' | 'warning' | 'error' | 'muted' } {
  switch (status) {
    case 'ok':
      return { label: t(lang, '排期中', 'Active'), tone: 'success' };
    case 'no-plan':
      return { label: t(lang, '未设计划', 'No Plan'), tone: 'warning' };
    case 'no-exam':
      return { label: t(lang, '未设考期', 'No Exam Date'), tone: 'warning' };
    case 'no-book':
      return { label: t(lang, '未建全书', 'No Book'), tone: 'warning' };
    case 'past':
      return { label: t(lang, '考期已过', 'Past Exam'), tone: 'error' };
    case 'no-course':
      return { label: t(lang, '未选课程', 'No Course'), tone: 'muted' };
    default:
      return { label: status, tone: 'muted' };
  }
}

function summarizeStartedFill(started: NonNullable<CustomFillResponse['started']>, lang: 'zh' | 'en'): { text: string; tone: 'success' | 'warning' } {
  const parts: string[] = [];
  let hasIssue = false;

  if (started.book) {
    if (started.book.error) {
      hasIssue = true;
      parts.push(t(lang, `全书:${started.book.error}`, `Book:${started.book.error}`));
    } else if (started.book.alreadyRunning) {
      parts.push(t(lang, '全书:已在生成中', 'Book:already running'));
    } else {
      parts.push(t(lang, '全书:已启动', 'Book:started'));
    }
  }
  if (started.questions) {
    if (started.questions.error) {
      hasIssue = true;
      parts.push(t(lang, `出题:${started.questions.error}`, `Qs:${started.questions.error}`));
    } else if (started.questions.alreadyRunning) {
      parts.push(t(lang, '出题:已在运行', 'Qs:already running'));
    } else {
      const left = started.questions.leftToRunning ? t(lang, ` (另${started.questions.leftToRunning}页运行中)`, ` (${started.questions.leftToRunning} held)`) : '';
      parts.push(t(lang, `出题:已启动${left}`, `Qs:started${left}`));
    }
  }
  if (started.variants) {
    if (started.variants.error) {
      hasIssue = true;
      parts.push(t(lang, `变式:${started.variants.error}`, `Var:${started.variants.error}`));
    } else if (started.variants.needsConsent) {
      hasIssue = true;
      parts.push(t(lang, '变式:需先在教练页确认授权', 'Var:needs consent'));
    } else {
      parts.push(t(lang, '变式:已启动', 'Var:started'));
    }
  }

  return {
    text: parts.length > 0 ? parts.join(' · ') : t(lang, '已提交补齐任务', 'Fill tasks submitted'),
    tone: hasIssue ? 'warning' : 'success',
  };
}

const CUSTOM_PURPOSES: readonly CustomPurpose[] = ['preview', 'follow', 'review', 'openbook'];
const BOOK_PARTS: readonly BookPart[] = ['explain', 'terms', 'formulas', 'index', 'confusables', 'answerKit', 'cheatSheet'];
const STRENGTH_LEVELS: readonly QuestionStrength[] = ['lean', 'standard', 'full'];
const DEFAULT_MINUTES_PER_DAY = 180;
const MIN_MINUTES_PER_DAY = 15;
const MAX_MINUTES_PER_DAY = 240;
const STEP_MINUTES_PER_DAY = 15;

const PART_NEEDS: Partial<Record<BookPart, readonly BookPart[]>> = {
  terms: ['explain'],
  formulas: ['explain'],
  index: ['explain'],
  confusables: ['terms'],
};

const SHEET_FROM: readonly BookPart[] = ['terms', 'formulas', 'answerKit', 'confusables'];

const FALLBACK_CUSTOM_PLAN: CustomPlanConfig = {
  version: 1,
  purpose: 'review',
  scope: { kind: 'all' },
  book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'formulas', 'confusables', 'answerKit'] },
  questions: { make: true, kinds: ['quiz', 'multi', 'truefalse', 'flashcard', 'open', 'cloze'], strength: 'standard', variants: true },
  plan: { make: true, by: 'exam', minutesPerDay: DEFAULT_MINUTES_PER_DAY },
  sampleFirst: true,
};

/** Close book parts to satisfy upstream dependencies (mirrors lib/custom-plan.js closedParts). */
function closeBookParts(parts: readonly BookPart[]): BookPart[] {
  const have = new Set<BookPart>(parts);
  if (have.has('cheatSheet') && !SHEET_FROM.some((id) => have.has(id))) {
    have.add('terms');
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...have]) {
      for (const need of PART_NEEDS[id] ?? []) {
        if (!have.has(need)) {
          have.add(need);
          grew = true;
        }
      }
    }
  }
  return BOOK_PARTS.filter((id) => have.has(id));
}

/** Remove a book part along with any parts that depend on it (mirrors lib/custom-plan.js partsWithout). */
function removeBookPart(parts: readonly BookPart[], target: BookPart): BookPart[] {
  let kept = parts.filter((part) => part !== target);
  let again = true;
  while (again) {
    const next = kept.filter(
      (part) =>
        (PART_NEEDS[part] ?? []).every((need) => kept.includes(need)) &&
        (part !== 'cheatSheet' || SHEET_FROM.some((from) => kept.includes(from))),
    );
    again = next.length !== kept.length;
    kept = next;
  }
  return BOOK_PARTS.filter((part) => kept.includes(part));
}

/** Parts currently required by another ticked part. */
function lockedBookParts(parts: readonly BookPart[]): Set<BookPart> {
  const locked = new Set<BookPart>();
  for (const id of parts) {
    for (const need of PART_NEEDS[id] ?? []) {
      if (parts.includes(need)) locked.add(need);
    }
  }
  return locked;
}

function clampMinutes(val: number | undefined): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return DEFAULT_MINUTES_PER_DAY;
  return Math.max(MIN_MINUTES_PER_DAY, Math.min(960, Math.round(val)));
}

function normalizeCustomDraft(raw?: Partial<CustomPlanConfig> | null): CustomPlanConfig {
  const base = FALLBACK_CUSTOM_PLAN;
  const purpose = CUSTOM_PURPOSES.includes(raw?.purpose as CustomPurpose) ? (raw!.purpose as CustomPurpose) : base.purpose;
  const rawScope = raw?.scope;
  const rawKind = rawScope?.kind;
  let scope: CustomPlanConfig['scope'];
  if (rawKind === 'chapters' && Array.isArray(rawScope?.chapters) && rawScope.chapters.length > 0) {
    scope = {
      kind: 'chapters',
      chapters: [...rawScope.chapters],
      ...(Array.isArray(rawScope.titles) ? { titles: [...rawScope.titles] } : {}),
      ...(rawScope.note ? { note: rawScope.note } : {}),
    };
  } else if (rawKind === 'exam') {
    scope = {
      kind: 'exam',
      ...(Array.isArray(rawScope?.resolvedChapters) && rawScope.resolvedChapters.length > 0
        ? { resolvedChapters: [...rawScope.resolvedChapters] }
        : {}),
      ...(Array.isArray(rawScope?.titles) ? { titles: [...rawScope.titles] } : {}),
      ...(rawScope?.note ? { note: rawScope.note } : {}),
    };
  } else {
    scope = {
      kind: 'all',
      ...(rawScope?.note ? { note: rawScope.note } : {}),
    };
  }

  const rawParts = Array.isArray(raw?.book?.parts)
    ? raw!.book!.parts.filter((p): p is BookPart => BOOK_PARTS.includes(p as BookPart))
    : base.book.parts;
  const parts = closeBookParts(rawParts);
  const coverage = raw?.book?.coverage === 'brief' || raw?.book?.coverage === 'standard' || raw?.book?.coverage === 'full'
    ? raw.book.coverage
    : base.book.coverage;
  const bookMake = parts.length > 0 ? Boolean(raw?.book?.make ?? true) : false;

  const strength = STRENGTH_LEVELS.includes(raw?.questions?.strength as QuestionStrength)
    ? (raw!.questions!.strength as QuestionStrength)
    : base.questions.strength;
  const kinds = Array.isArray(raw?.questions?.kinds) && raw!.questions!.kinds.length > 0
    ? [...raw!.questions!.kinds]
    : [...base.questions.kinds];
  const qMake = Boolean(raw?.questions?.make ?? true);
  const variants = typeof raw?.questions?.variants === 'boolean' ? raw.questions.variants : base.questions.variants;

  const by = raw?.plan?.by === 'weekly' ? 'weekly' : 'exam';
  const planMake = Boolean(raw?.plan?.make ?? true);
  const chaptersPerWeek =
    by === 'weekly'
      ? Math.max(1, Math.min(10, Math.round(raw?.plan?.chaptersPerWeek ?? 1)))
      : undefined;
  const minutesPerDay = clampMinutes(raw?.plan?.minutesPerDay);

  return {
    version: 1,
    purpose,
    scope,
    book: { make: bookMake, coverage, parts },
    questions: { make: qMake, kinds, strength, variants },
    plan: {
      make: planMake,
      by,
      ...(by === 'weekly' ? { chaptersPerWeek } : {}),
      minutesPerDay,
    },
    sampleFirst: typeof raw?.sampleFirst === 'boolean' ? raw.sampleFirst : true,
  };
}

function purposeMeta(purpose: CustomPurpose, lang: 'zh' | 'en'): { label: string; desc: string } {
  switch (purpose) {
    case 'preview':
      return {
        label: t(lang, '课前预习', 'Preview'),
        desc: t(lang, '精简讲解+基础题，按周轻量化预习', 'Brief book + lean questions, weekly light pace'),
      };
    case 'follow':
      return {
        label: t(lang, '同步跟课', 'Follow'),
        desc: t(lang, '标准全书+全题型+错题变式，按周跟进', 'Standard book + all kinds + variants, weekly pace'),
      };
    case 'review':
      return {
        label: t(lang, '期末复习', 'Review'),
        desc: t(lang, '全书+术语/公式/易混/锦囊，倒推考期排期', 'Full review parts + exam-date backward schedule'),
      };
    case 'openbook':
      return {
        label: t(lang, '开卷速查', 'Open-book'),
        desc: t(lang, '精简正文+全套索引与速查表，重点配开卷题', 'Brief prose + full lookup & cheat sheet'),
      };
  }
}

function scopeLabel(scope: CustomPlanConfig['scope'], lang: 'zh' | 'en'): string {
  if (scope.kind === 'exam') return t(lang, '考纲范围', 'Exam Scope');
  if (scope.kind === 'chapters') {
    return t(lang, `指定章节 (${scope.chapters?.length ?? 0}章)`, `Chapters (${scope.chapters?.length ?? 0})`);
  }
  return t(lang, '全部章节', 'All Chapters');
}

function strengthLabel(strength: QuestionStrength, lang: 'zh' | 'en'): string {
  switch (strength) {
    case 'lean':
      return t(lang, '精简 (lean)', 'Lean');
    case 'standard':
      return t(lang, '标准 (std)', 'Standard');
    case 'full':
      return t(lang, '完整 (full)', 'Full');
  }
}

function bookPartMeta(part: BookPart, lang: 'zh' | 'en'): { label: string; dep: string; desc: string } {
  switch (part) {
    case 'explain':
      return {
        label: t(lang, '全书讲解', 'Explanations'),
        dep: t(lang, '基础正文', 'Base text'),
        desc: t(lang, '各知识点核心讲解与例题 (术语/公式/索引依赖此项)', 'Knowledge point explanations (required by terms/formulas/index)'),
      };
    case 'terms':
      return {
        label: t(lang, '术语卡', 'Term Cards'),
        dep: t(lang, '需:讲解', 'Req:explain'),
        desc: t(lang, '从讲解提炼核心术语卡 (自动开启全书讲解)', 'Core term cards extracted from explanations (auto-enables explain)'),
      };
    case 'formulas':
      return {
        label: t(lang, '公式页', 'Formulas'),
        dep: t(lang, '需:讲解', 'Req:explain'),
        desc: t(lang, '汇总公式与推导要点 (自动开启全书讲解)', 'Formula summary page (auto-enables explain)'),
      };
    case 'index':
      return {
        label: t(lang, '索引页', 'A-Z Index'),
        dep: t(lang, '需:讲解', 'Req:explain'),
        desc: t(lang, '按字母与章节整理的速查索引 (自动开启全书讲解)', 'A-Z glossary & chapter index (auto-enables explain)'),
      };
    case 'confusables':
      return {
        label: t(lang, '易混对比', 'Confusables'),
        dep: t(lang, '需:术语', 'Req:terms'),
        desc: t(lang, '易混/对立概念对比表 (自动开启术语卡与讲解)', 'Confusable concept pairs (auto-enables terms & explain)'),
      };
    case 'answerKit':
      return {
        label: t(lang, '答题锦囊', 'Answer Kit'),
        dep: t(lang, '独立/真题', 'From papers'),
        desc: t(lang, '基于历年真题/样卷提炼的高频答题模板', 'Exam answering templates from sample papers'),
      };
    case 'cheatSheet':
      return {
        label: t(lang, '速查表', 'Cheat Sheet'),
        dep: t(lang, '需:任一查表项', 'Req:lookup'),
        desc: t(lang, '可打印浓缩速查表 (无术语/公式/锦囊/易混时自动开启术语卡)', 'Printable cheat sheet (auto-enables terms if no lookup parts ticked)'),
      };
  }
}

function summarizeApplyResult(res: CustomApplyResponse, lang: 'zh' | 'en'): { text: string; tone: 'success' | 'warning' | 'info' } {
  if (res.status === 'no-course') {
    return { text: t(lang, '请先选择课程', 'Select a course first'), tone: 'warning' };
  }
  if (res.status === 'no-plan') {
    return { text: t(lang, '尚未保存定制方案，请先按 [s] 保存', 'No saved custom plan; press [s] to save first'), tone: 'warning' };
  }
  const startedCount = res.started?.length ?? 0;
  const waitingCount = res.waiting?.length ?? 0;
  const doneCount = res.done?.length ?? 0;
  const counts: string[] = [];
  if (startedCount > 0) counts.push(t(lang, `已启动 ${startedCount}`, `Started ${startedCount}`));
  if (waitingCount > 0) counts.push(t(lang, `待处理 ${waitingCount}`, `Waiting ${waitingCount}`));
  if (doneCount > 0) counts.push(t(lang, `已完成 ${doneCount}`, `Done ${doneCount}`));

  const firstDetail =
    res.started?.[0]?.what ||
    res.waiting?.[0]?.what ||
    res.done?.[0]?.what ||
    res.recorded?.[0]?.what ||
    '';

  const header = counts.length > 0 ? counts.join(' / ') : t(lang, '定制方案已检查', 'Custom plan checked');
  const text = firstDetail ? `${header}: ${firstDetail}` : header;
  const tone = startedCount > 0 ? 'success' : waitingCount > 0 ? 'warning' : 'info';
  return { text, tone };
}

export const StudyPlanModal = memo(function StudyPlanModal({
  host,
  course,
  width,
  height,
  isActive,
  onClose,
  onUpdated,
}: StudyPlanModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  // Hold input capture for the modal lifetime even while ConfirmDialog mounts on top.
  useInputCapture(isActive);

  const [tab, setTab] = useState<ModalTab>('plan');
  const [planLoading, setPlanLoading] = useState(true);
  const [readinessLoading, setReadinessLoading] = useState(true);
  const [customLoading, setCustomLoading] = useState(false);
  const [customPreviewBusy, setCustomPreviewBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  const [planData, setPlanData] = useState<CoursePlanResponse | null>(null);
  const [readinessData, setReadinessData] = useState<CustomReadinessResponse | null>(null);
  const [previewData, setPreviewData] = useState<CustomPreviewResponse | null>(null);
  const [customPreviewData, setCustomPreviewData] = useState<CustomPreviewResponse | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomPlanConfig | null>(null);

  const [dayIdx, setDayIdx] = useState(0);
  const [chapterIdx, setChapterIdx] = useState(0);
  const [customRowIdx, setCustomRowIdx] = useState(0);
  const [confirmFill, setConfirmFill] = useState<CustomFillResponse | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const planSeqRef = useRef(0);
  const readinessSeqRef = useRef(0);
  const customSeqRef = useRef(0);
  const readinessLoadedRef = useRef(false);
  const customLoadedRef = useRef(false);
  const lastPreviewKeyRef = useRef('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const courseArgs = useMemo(() => (course ? { course } : {}), [course]);

  const loadPlan = useCallback(async () => {
    const seq = ++planSeqRef.current;
    setPlanError(null);
    const res = await tryAction<CoursePlanResponse>(host, 'course.plan', courseArgs);
    if (!mountedRef.current || seq !== planSeqRef.current) return;
    if (res.ok && res.value) {
      setPlanData(res.value);
    } else {
      setPlanError(res.error?.message || t(lang, '加载备考计划失败', 'Failed to load study plan'));
    }
    setPlanLoading(false);
  }, [host, courseArgs, lang]);

  const loadReadiness = useCallback(async () => {
    const seq = ++readinessSeqRef.current;
    setReadinessError(null);
    const [rRes, pRes] = await Promise.all([
      tryAction<CustomReadinessResponse>(host, 'course.custom.readiness', courseArgs),
      tryAction<CustomPreviewResponse>(host, 'course.custom.preview', courseArgs),
    ]);
    if (!mountedRef.current || seq !== readinessSeqRef.current) return;
    readinessLoadedRef.current = true;
    if (rRes.ok && rRes.value) setReadinessData(rRes.value);
    else setReadinessError(rRes.error?.message || t(lang, '加载章节就绪度失败', 'Failed to load readiness'));
    if (pRes.ok && pRes.value) setPreviewData(pRes.value);
    else if (!rRes.ok) {
      setReadinessError(rRes.error?.message || pRes.error?.message || t(lang, '加载章节就绪度失败', 'Failed to load readiness'));
    }
    setReadinessLoading(false);
  }, [host, courseArgs, lang]);

  const loadCustomPreview = useCallback(async () => {
    const seq = ++customSeqRef.current;
    setCustomError(null);
    const res = await tryAction<CustomPreviewResponse>(host, 'course.custom.preview', {
      ...courseArgs,
      language: lang,
    });
    if (!mountedRef.current || seq !== customSeqRef.current) return;
    customLoadedRef.current = true;
    if (res.ok && res.value) {
      setPreviewData(res.value);
      setCustomPreviewData(res.value);
      const initial = normalizeCustomDraft(res.value.saved ?? res.value.filled);
      lastPreviewKeyRef.current = JSON.stringify(initial);
      setCustomDraft(initial);
    } else {
      setCustomError(res.error?.message || t(lang, '加载深度定制配置失败', 'Failed to load custom plan'));
    }
    setCustomLoading(false);
  }, [host, courseArgs, lang]);

  useEffect(() => {
    setPlanLoading(true);
    setReadinessLoading(true);
    setCustomLoading(false);
    readinessLoadedRef.current = false;
    customLoadedRef.current = false;
    lastPreviewKeyRef.current = '';
    setCustomDraft(null);
    setCustomPreviewData(null);
    setConfirmFill(null);
    setConfirmApply(false);
    void loadPlan();
  }, [loadPlan]);

  useEffect(() => {
    if (tab === 'readiness' && !readinessLoadedRef.current) {
      setReadinessLoading(true);
      void loadReadiness();
    } else if (tab === 'custom' && !customLoadedRef.current) {
      setCustomLoading(true);
      void loadCustomPreview();
    }
  }, [tab, loadReadiness, loadCustomPreview]);

  const effectiveCourse =
    planData?.course ?? readinessData?.course ?? customPreviewData?.course ?? previewData?.course ?? course ?? '';

  // Debounced (180ms) live zero-cost estimate on Tab 3 edits
  useEffect(() => {
    if (tab !== 'custom' || !customDraft || !customLoadedRef.current) return;
    if (customPreviewData?.status === 'no-course' && !effectiveCourse) return;
    const key = JSON.stringify(customDraft);
    if (key === lastPreviewKeyRef.current) return;

    const timer = setTimeout(() => {
      const seq = ++customSeqRef.current;
      setCustomPreviewBusy(true);
      void tryAction<CustomPreviewResponse>(host, 'course.custom.preview', {
        ...(effectiveCourse ? { course: effectiveCourse } : {}),
        custom: customDraft,
        language: lang,
      }).then((res) => {
        if (!mountedRef.current || seq !== customSeqRef.current) return;
        setCustomPreviewBusy(false);
        if (res.ok && res.value) {
          lastPreviewKeyRef.current = key;
          setCustomPreviewData(res.value);
          setCustomError(null);
        }
      });
    }, 180);

    return () => {
      clearTimeout(timer);
    };
  }, [tab, customDraft, customPreviewData?.status, effectiveCourse, host, lang]);

  const upcomingDays = useMemo<CoursePlanDay[]>(() => planScheduleDays(planData), [planData]);

  const pointMap = useMemo(() => {
    const map = new Map<string, CoursePlanPoint>();
    for (const pt of planData?.points ?? []) {
      map.set(pt.id, pt);
    }
    return map;
  }, [planData?.points]);

  const chapters = readinessData?.chapters ?? [];

  useEffect(() => {
    if (upcomingDays.length > 0 && dayIdx >= upcomingDays.length) {
      setDayIdx(upcomingDays.length - 1);
    }
  }, [upcomingDays.length, dayIdx]);

  useEffect(() => {
    if (chapters.length > 0 && chapterIdx >= chapters.length) {
      setChapterIdx(chapters.length - 1);
    }
  }, [chapters.length, chapterIdx]);

  const savedCustomNormalized = useMemo(() => {
    const saved = customPreviewData?.saved ?? previewData?.saved;
    return saved ? normalizeCustomDraft(saved) : null;
  }, [customPreviewData?.saved, previewData?.saved]);

  const isCustomDirty = useMemo(() => {
    if (!customDraft) return false;
    if (!savedCustomNormalized) return true;
    return JSON.stringify(customDraft) !== JSON.stringify(savedCustomNormalized);
  }, [customDraft, savedCustomNormalized]);

  const customRows = useMemo<CustomOptionRow[]>(() => {
    if (!customDraft) return [];
    const pMeta = purposeMeta(customDraft.purpose, lang);
    const locked = lockedBookParts(customDraft.book.parts);
    const examScopeInfo = customPreviewData?.examScope;
    const scopeNote =
      customDraft.scope.kind === 'exam' && examScopeInfo
        ? examScopeInfo.confirmed
          ? t(lang, `已确认 ${examScopeInfo.resolvedChapters?.length ?? 0} 章`, `${examScopeInfo.resolvedChapters?.length ?? 0} ch confirmed`)
          : t(lang, `匹配 ${examScopeInfo.matchedChapters?.length ?? 0} 章 (待确认)`, `${examScopeInfo.matchedChapters?.length ?? 0} matched (unconfirmed)`)
        : t(lang, 'all / exam', 'all / exam');

    const rows: CustomOptionRow[] = [
      {
        id: 'purpose',
        label: t(lang, '学习目的', 'Purpose'),
        value: pMeta.label,
        note: t(lang, '预习/跟课/复习/开卷', 'preview/follow/review/open'),
        detail: `${t(lang, '学习目的', 'Purpose')}: ${pMeta.desc}`,
      },
      {
        id: 'scope',
        label: t(lang, '覆盖范围', 'Scope'),
        value: scopeLabel(customDraft.scope, lang),
        note: scopeNote,
        detail:
          customDraft.scope.kind === 'exam'
            ? t(
                lang,
                `考纲范围${examScopeInfo?.coverageNote ? `: ${examScopeInfo.coverageNote}` : ' (应用前需在课程大纲中确认匹配章节)'}`,
                `Exam scope${examScopeInfo?.coverageNote ? `: ${examScopeInfo.coverageNote}` : ' (requires confirmed exam chapters before generation)'}`,
              )
            : t(lang, '覆盖当前课程全部可学习章节', 'Covers all teachable chapters in this course'),
      },
    ];

    for (const part of BOOK_PARTS) {
      const enabled = customDraft.book.parts.includes(part);
      const isLocked = enabled && locked.has(part);
      const meta = bookPartMeta(part, lang);
      rows.push({
        id: `part:${part}`,
        label: meta.label,
        value: enabled ? t(lang, '已启用', 'ON') : t(lang, '未启用', 'OFF'),
        note: isLocked ? `${meta.dep} *` : meta.dep,
        detail: meta.desc,
        enabled,
        locked: isLocked,
      });
    }

    rows.push({
      id: 'strength',
      label: t(lang, '出题强度', 'Q Strength'),
      value: strengthLabel(customDraft.questions.strength, lang),
      note: 'lean/std/full',
      detail: t(
        lang,
        '出题覆盖强度: lean(精简~60%) / standard(标准) / full(完整覆盖每节)',
        'Question density: lean (~60% weighted) / standard / full (every leaf section)',
      ),
    });

    const mins = clampMinutes(customDraft.plan.minutesPerDay);
    rows.push({
      id: 'minutes',
      label: t(lang, '每日时长', 'Min / Day'),
      value: `${mins}${t(lang, '分/天', 'm/d')}`,
      note: '15-240 (+/-)',
      detail: t(
        lang,
        '每日计划学习分钟数 (15-240 分钟, 步进 15; 支持 +/- 或左右键调整)',
        'Daily study capacity (15-240 min, step 15; adjust with +/- or Left/Right)',
      ),
    });

    return rows;
  }, [customDraft, customPreviewData?.examScope, lang]);

  useEffect(() => {
    if (customRows.length > 0 && customRowIdx >= customRows.length) {
      setCustomRowIdx(customRows.length - 1);
    }
  }, [customRows.length, customRowIdx]);

  const adjustCustomRow = useCallback(
    (rowId: CustomRowId, direction: 1 | -1) => {
      setCustomDraft((prev) => {
        if (!prev) return prev;
        if (rowId === 'purpose') {
          const idx = CUSTOM_PURPOSES.indexOf(prev.purpose);
          const nextPurpose = CUSTOM_PURPOSES[(idx + direction + CUSTOM_PURPOSES.length) % CUSTOM_PURPOSES.length];
          const preset = (customPreviewData?.defaults ?? previewData?.defaults)?.[nextPurpose];
          if (preset) {
            const normalizedPreset = normalizeCustomDraft(preset);
            return {
              ...normalizedPreset,
              scope: prev.scope.kind === 'chapters' && !prev.scope.chapters?.length ? { kind: 'all' } : prev.scope,
              plan: {
                ...normalizedPreset.plan,
                minutesPerDay: clampMinutes(prev.plan.minutesPerDay),
              },
            };
          }
          return { ...prev, purpose: nextPurpose };
        }
        if (rowId === 'scope') {
          const nextKind: 'all' | 'exam' = prev.scope.kind === 'exam' ? 'all' : 'exam';
          const savedExamScope =
            nextKind === 'exam' && savedCustomNormalized?.scope.kind === 'exam'
              ? savedCustomNormalized.scope
              : null;
          return {
            ...prev,
            scope: savedExamScope ?? { kind: nextKind },
          };
        }
        if (rowId.startsWith('part:')) {
          const part = rowId.slice(5) as BookPart;
          const has = prev.book.parts.includes(part);
          const nextParts = has
            ? removeBookPart(prev.book.parts, part)
            : closeBookParts([...prev.book.parts, part]);
          return {
            ...prev,
            book: {
              ...prev.book,
              make: nextParts.length > 0,
              parts: nextParts,
            },
          };
        }
        if (rowId === 'strength') {
          const idx = STRENGTH_LEVELS.indexOf(prev.questions.strength);
          const nextStrength = STRENGTH_LEVELS[(idx + direction + STRENGTH_LEVELS.length) % STRENGTH_LEVELS.length];
          return {
            ...prev,
            questions: {
              ...prev.questions,
              make: true,
              strength: nextStrength,
            },
          };
        }
        if (rowId === 'minutes') {
          const curr = clampMinutes(prev.plan.minutesPerDay);
          const snapped = Math.round(curr / STEP_MINUTES_PER_DAY) * STEP_MINUTES_PER_DAY;
          const next = Math.max(
            MIN_MINUTES_PER_DAY,
            Math.min(MAX_MINUTES_PER_DAY, snapped + direction * STEP_MINUTES_PER_DAY),
          );
          return {
            ...prev,
            plan: {
              ...prev.plan,
              make: true,
              minutesPerDay: next,
            },
          };
        }
        return prev;
      });
    },
    [customPreviewData?.defaults, previewData?.defaults, savedCustomNormalized],
  );

  const handleSaveCustom = useCallback(async () => {
    if (busyRef.current || !customDraft) return;
    const targetCourse = effectiveCourse || course;
    if (!targetCourse) {
      notify(t(lang, '请先选择课程', 'Select a course first'), 'warning');
      return;
    }
    busyRef.current = true;
    setBusyLabel(t(lang, '正在保存定制方案...', 'Saving custom plan...'));
    try {
      const got = await tryAction<CourseRecordView>(host, 'course.get', { name: targetCourse });
      if (!mountedRef.current) return;
      const record = got.ok && got.value ? got.value : null;
      const normalized = normalizeCustomDraft(customDraft);
      const saved = await tryAction<CourseRecordView>(host, 'course.save', {
        ...(record?.id && !record?.virtual ? { id: record.id } : {}),
        name: record?.name || targetCourse,
        ...(record?.exam !== undefined ? { exam: record.exam } : {}),
        ...(record?.plan !== undefined ? { plan: record.plan } : {}),
        ...(record?.focusTopics !== undefined ? { focusTopics: record.focusTopics } : {}),
        ...(record?.guidanceSourceIds !== undefined ? { guidanceSourceIds: record.guidanceSourceIds } : {}),
        custom: normalized,
      });
      if (!mountedRef.current) return;
      if (!saved.ok) {
        notify(saved.error?.message || t(lang, '保存定制方案失败', 'Failed to save custom plan'), 'error');
        return;
      }
      notify(t(lang, `已保存「${targetCourse}」深度定制方案`, `Saved custom plan for "${targetCourse}"`), 'success');
      await Promise.all([loadCustomPreview(), loadReadiness(), loadPlan()]);
      onUpdated?.();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [customDraft, effectiveCourse, course, host, lang, notify, loadCustomPreview, loadReadiness, loadPlan, onUpdated]);

  const handleRequestApply = useCallback(() => {
    if (busyRef.current) return;
    const targetCourse = effectiveCourse || course;
    if (!targetCourse) {
      notify(t(lang, '请先选择课程', 'Select a course first'), 'warning');
      return;
    }
    if (!savedCustomNormalized) {
      notify(t(lang, '尚未保存定制方案，请先按 [s] 保存', 'No saved custom plan yet; press [s] to save first'), 'warning');
      return;
    }
    setConfirmApply(true);
  }, [effectiveCourse, course, savedCustomNormalized, notify, lang]);

  const handleConfirmApply = useCallback(async () => {
    if (busyRef.current) return;
    setConfirmApply(false);
    const targetCourse = effectiveCourse || course;
    if (!targetCourse) return;
    busyRef.current = true;
    setBusyLabel(t(lang, '正在应用定制方案...', 'Applying custom plan...'));
    try {
      const res = await tryAction<CustomApplyResponse>(host, 'course.custom.apply', {
        course: targetCourse,
        confirm: true,
        language: lang,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '应用定制方案失败', 'Failed to apply custom plan'), 'error');
        return;
      }
      const summary = summarizeApplyResult(res.value, lang);
      notify(summary.text, summary.tone);
      await Promise.all([loadCustomPreview(), loadReadiness(), loadPlan()]);
      onUpdated?.();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [effectiveCourse, course, host, lang, notify, loadCustomPreview, loadReadiness, loadPlan, onUpdated]);

  const handleRequestFill = useCallback(async () => {
    if (busyRef.current || busyLabel) return;
    busyRef.current = true;
    setBusyLabel(t(lang, `正在估算待补齐任务${ell}`, `Estimating missing work${ell}`));
    try {
      const res = await tryAction<CustomFillResponse>(host, 'course.custom.fill', {
        ...(effectiveCourse ? { course: effectiveCourse } : {}),
        estimate: true,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '估算补齐任务失败', 'Failed to estimate fill'), 'error');
        return;
      }
      const v = res.value;
      if (v.status === 'nothing') {
        notify(t(lang, '当前章节已全部补齐，暂无待启动任务', 'Nothing missing to fill right now'), 'info');
        return;
      }
      if (v.status !== 'ok') {
        const msgMap: Record<string, string> = {
          'no-course': t(lang, '请先选择课程', 'Select a course first'),
          'no-book': t(lang, '尚未生成复习全书，请先前往「复习全书」按 [g] 生成', 'No review book yet; build it in Book view [7] first'),
          'no-outline': t(lang, '尚未生成课程总纲，请先生成总纲后再补齐', 'No course outline yet; build outline first'),
          'exam-scope-unconfirmed': t(lang, '考试范围章节尚未确认，请先确认后再补齐', 'Exam scope chapters are unconfirmed'),
        };
        notify(msgMap[v.status] || t(lang, `当前状态不可补齐: ${v.status}`, `Cannot fill (${v.status})`), 'warning');
        return;
      }
      setConfirmFill(v);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [busyLabel, host, effectiveCourse, lang, notify]);

  const handleConfirmFill = useCallback(async () => {
    if (busyRef.current) return;
    setConfirmFill(null);
    busyRef.current = true;
    setBusyLabel(t(lang, `正在启动补齐任务${ell}`, `Starting fill jobs${ell}`));
    try {
      const res = await tryAction<CustomFillResponse>(
        host,
        'course.custom.fill',
        effectiveCourse ? { course: effectiveCourse } : {},
      );
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '启动补齐任务失败', 'Failed to start fill jobs'), 'error');
        return;
      }
      const summary = res.value.started
        ? summarizeStartedFill(res.value.started, lang)
        : { text: t(lang, '已检查补齐任务', 'Fill checked'), tone: 'success' as const };
      notify(summary.text, summary.tone);
      setReadinessLoading(true);
      await Promise.all([loadReadiness(), loadPlan()]);
      onUpdated?.();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyLabel(null);
    }
  }, [host, effectiveCourse, lang, notify, loadReadiness, loadPlan, onUpdated]);

  const modalActive = isActive && confirmFill === null && !confirmApply;

  useInput(
    (input, key) => {
      if (input === '1') {
        setTab('plan');
        return;
      }
      if (input === '2') {
        setTab('readiness');
        return;
      }
      if (input === '3') {
        setTab('custom');
        return;
      }
      if (key.tab) {
        const order: ModalTab[] = ['plan', 'readiness', 'custom'];
        setTab((prev) => order[(order.indexOf(prev) + (key.shift ? order.length - 1 : 1)) % order.length]);
        return;
      }
      if (input === 'r' && !busyLabel && !busyRef.current) {
        if (tab === 'plan') {
          setPlanLoading(true);
          void loadPlan();
        } else if (tab === 'readiness') {
          setReadinessLoading(true);
          void loadReadiness();
        } else {
          setCustomLoading(true);
          void loadCustomPreview();
        }
        return;
      }
      if (input === 'f' && tab === 'readiness' && !readinessLoading && !busyLabel && !busyRef.current) {
        void handleRequestFill();
        return;
      }
      if (tab === 'custom' && !customLoading && !busyLabel && !busyRef.current && customRows.length > 0) {
        const activeRow = customRows[Math.min(customRowIdx, customRows.length - 1)];
        if (input === ' ') {
          adjustCustomRow(activeRow.id, 1);
          return;
        }
        if (key.rightArrow) {
          adjustCustomRow(activeRow.id, 1);
          return;
        }
        if (key.leftArrow) {
          adjustCustomRow(activeRow.id, -1);
          return;
        }
        if (input === '+' || input === '=') {
          adjustCustomRow('minutes', 1);
          return;
        }
        if (input === '-' || input === '_') {
          adjustCustomRow('minutes', -1);
          return;
        }
        if (input === 's') {
          void handleSaveCustom();
          return;
        }
        if (input === 'a') {
          handleRequestApply();
        }
      }
    },
    { isActive: modalActive },
  );

  // Modal geometry: Modal reserves 5 rows of chrome (top border, title, divider, hints, bottom border).
  const frameW = Math.max(48, Math.min(96, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);
  const tabBodyH = Math.max(6, bodyH - 2);

  const hints = useMemo<KeyHint[]>(() => {
    const compact = innerW < 68;
    const out: KeyHint[] = [
      { key: compact ? '1-3' : '1/2/3/Tab', label: compact ? t(lang, '切', 'Tab') : t(lang, '切换', 'Tab') },
      { key: 'j/k', label: compact ? t(lang, '移', 'Mv') : t(lang, '移动', 'Move') },
    ];
    if (tab === 'readiness') {
      out.push({ key: 'f', label: t(lang, '补齐缺失', 'Fill Missing') });
    } else if (tab === 'custom') {
      out.push({
        key: compact ? 'Space' : asciiMode ? 'Space/<->' : 'Space/←/→',
        label: compact ? t(lang, '调', 'Ed') : t(lang, '调整', 'Adjust'),
      });
      out.push({ key: 's', label: compact ? t(lang, '存', 'Sv') : t(lang, '保存', 'Save') });
      out.push({ key: 'a', label: compact ? t(lang, '用', 'Go') : t(lang, '应用', 'Apply') });
    }
    out.push({ key: 'r', label: compact ? t(lang, '刷', 'Rf') : t(lang, '刷新', 'Refresh') });
    out.push({ key: 'Esc', label: compact ? t(lang, '关', 'X') : t(lang, '关闭', 'Close') });
    return out;
  }, [tab, lang, asciiMode, innerW]);

  const sep = asciiMode ? '-' : '·';
  const arrow = asciiMode ? '->' : '→';

  const renderScheduleRow = useCallback(
    (day: CoursePlanDay, ctx: VirtualListRenderContext) => {
      const mode = dayModeMeta(day, lang);
      const dayLabel = day.offset === 0 ? t(lang, '今日', 'Today') : day.date.slice(5);
      const prefix = `[${dayLabel} ${mode.label}]`;
      const phaseTag = day.phase ? `${truncateDisplay(day.phase, 10, ell)} ` : '';
      const minTag = day.minutes > 0 ? ` ${day.minutes}m` : '';
      const doneTag = day.points.length > 0 && day.done.length > 0 ? ` ${day.done.length}/${day.points.length}` : '';
      const rightMeta = `${doneTag}${minTag}`;
      const reason = formatPlanDayReason(day, lang);
      const midAvail = Math.max(6, ctx.width - displayWidth(prefix) - displayWidth(phaseTag) - displayWidth(rightMeta) - 2);
      const midText = padDisplay(truncateDisplay(reason, midAvail, ell), midAvail);
      const fg = ctx.selected ? theme.selectionFg : theme.text;
      const prefixColor = ctx.selected
        ? theme.selectionFg
        : mode.tone === 'warning'
          ? theme.warning
          : mode.tone === 'accent'
            ? theme.accent
            : mode.tone === 'primary'
              ? theme.primary
              : theme.muted;

      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={prefixColor}>{prefix}</Text>
          {phaseTag ? <Text color={ctx.selected ? theme.selectionFg : theme.dim}>{` ${phaseTag}`}</Text> : ' '}
          {midText}
          {rightMeta ? <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{rightMeta}</Text> : null}
        </Text>
      );
    },
    [lang, ell, theme],
  );

  const renderChapterRow = useCallback(
    (ch: CustomReadinessChapter, ctx: VirtualListRenderContext) => {
      const wide = ctx.width >= 78;
      const barW = wide ? 16 : 12;
      const statsStr = wide
        ? ` ${t(lang, '讲', 'E')}:${fmtCount(ch.explained)} ${t(lang, '问', 'A')}:${fmtCount(ch.asked)} ${t(lang, '练', 'P')}:${fmtCount(ch.practised)} ${t(lang, '稳', 'S')}:${fmtCount(ch.solid)} ${t(lang, '弱', 'W')}:${fmtCount(ch.weak)}`
        : ` ${t(lang, '稳', 'S')}:${fmtCount(ch.solid)}/${ch.points} ${t(lang, '弱', 'W')}:${fmtCount(ch.weak)}`;
      const nullPct = ch.readiness === null ? '  --%' : '';
      const titleBudget = Math.max(8, ctx.width - barW - displayWidth(nullPct) - displayWidth(statsStr) - 2);
      const titleText = padDisplay(truncateDisplay(ch.title || ch.id, titleBudget, ell), titleBudget);
      const fg = ctx.selected ? theme.selectionFg : !ch.built ? theme.dim : theme.text;
      const weakHighlight = !ctx.selected && (ch.weak ?? 0) > 0;

      return (
        <Text color={fg} bold={ctx.selected}>
          {titleText}
          {' '}
          {ch.readiness !== null ? (
            <ProgressBar ratio={ch.readiness} width={barW} style="line" showPercent />
          ) : (
            <>
              <ProgressBar ratio={0} width={Math.max(4, barW - 5)} style="line" showPercent={false} />
              <Text color={ctx.selected ? theme.selectionFg : theme.dim}>{nullPct}</Text>
            </>
          )}
          <Text color={weakHighlight ? theme.warning : ctx.selected ? theme.selectionFg : theme.muted}>{statsStr}</Text>
        </Text>
      );
    },
    [lang, ell, theme],
  );

  const renderPlanTab = () => {
    if (planLoading && !planData) {
      return (
        <Box height={tabBodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在加载备考计划${ell}`, `Loading study plan${ell}`)} active={isActive} />
        </Box>
      );
    }
    if (planError && !planData) {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '✕'}
          title={t(lang, '加载备考计划失败', 'Failed to load study plan')}
          hint={planError}
          actions={[{ key: 'r', label: t(lang, '重试', 'Retry') }]}
          width={innerW}
          height={tabBodyH}
        />
      );
    }

    const st = planData?.status ?? 'no-plan';
    const stMeta = planStatusMeta(st, lang);
    const examDate = planData?.examDate ?? planData?.schedule?.examDate ?? null;
    const daysLeft = planData?.daysLeft ?? planData?.schedule?.daysLeft ?? null;

    const countdownBadge =
      typeof daysLeft === 'number'
        ? daysLeft === 0
          ? { label: t(lang, `今日考试 (${examDate ?? ''})`, `Exam Today (${examDate ?? ''})`), tone: 'error' as const }
          : daysLeft > 0
            ? {
                label: `${t(lang, '距考', 'D-')}${daysLeft}${t(lang, '天', 'd')}${examDate ? ` (${examDate.slice(5)})` : ''}`,
                tone: (daysLeft <= 7 ? 'error' : 'warning') as 'error' | 'warning',
              }
            : { label: `${t(lang, '已过', 'Past')} (${examDate ?? ''})`, tone: 'error' as const }
        : planData?.schedule?.weekly
          ? { label: t(lang, '按周排期', 'Weekly Plan'), tone: 'accent' as const }
          : null;

    if (st !== 'ok' || !planData?.schedule) {
      const emptyCopy: Record<string, { title: string; hint: string }> = {
        'no-course': {
          title: t(lang, '尚未选择课程', 'No course selected'),
          hint: t(lang, '按 [Esc] 返回后按 [c] 选择一门课程。', 'Press [Esc], then [c] to select a course.'),
        },
        'no-plan': {
          title: t(lang, '该课程尚未制定备考计划', 'No study plan configured yet'),
          hint: t(
            lang,
            '可在主对话让 AI 规划并保存备考计划；按 [2] 可先查看章节就绪度。',
            'Ask AI in chat to draft and save a study plan; press [2] for chapter readiness.',
          ),
        },
        'no-book': {
          title: t(lang, '尚未生成课程复习全书', 'No review book built yet'),
          hint: t(
            lang,
            '备考计划基于全书知识点排期：按 [Esc] 返回后前往 [7] 复习全书按 [g] 生成。',
            'Schedule requires a Review Book: press [Esc], open [7] Book, then [g] to build.',
          ),
        },
        'no-exam': {
          title: t(lang, '尚未设置本课程考试日期', 'No exam date set for this course'),
          hint: t(
            lang,
            '按 [Esc] 返回后按 [C] 打开课程设置 -> 标签 2 -> [d] 设置考试日期。',
            'Press [Esc], then [C] Course Settings -> Tab 2 -> [d] Set Exam Date.',
          ),
        },
        past: {
          title: t(lang, `考试日期 (${examDate ?? ''}) 已过`, `Exam date (${examDate ?? ''}) has passed`),
          hint: t(
            lang,
            '可在课程设置 [C] 中更新考试日期，或按 [2] 查看章节就绪度。',
            'Update exam date in Course Settings [C], or press [2] for readiness.',
          ),
        },
      };
      const copy = emptyCopy[st] ?? {
        title: t(lang, `备考计划暂不可用 (${st})`, `Study plan unavailable (${st})`),
        hint: t(lang, '按 [r] 刷新，或按 [2] 查看章节就绪度。', 'Press [r] to retry or [2] for readiness.'),
      };
      return (
        <Box flexDirection="column" height={tabBodyH} overflow="hidden">
          <Box height={1} gap={1} overflow="hidden">
            <Badge label={stMeta.label} tone={stMeta.tone} variant="soft" />
            {countdownBadge ? <Badge label={countdownBadge.label} tone={countdownBadge.tone} variant="outline" /> : null}
          </Box>
          <EmptyState
            icon={asciiMode ? '!' : '◷'}
            title={copy.title}
            hint={copy.hint}
            actions={[
              { key: '2', label: t(lang, '章节就绪度', 'Readiness') },
              { key: 'r', label: t(lang, '刷新', 'Refresh') },
            ]}
            width={innerW}
            height={Math.max(4, tabBodyH - 1)}
          />
        </Box>
      );
    }

    const sched = planData.schedule;
    const progress = sched.progress ?? { learnt: 0, total: 0, elapsedDays: 0, totalDays: 0 };
    const coverage = sched.coverage ?? { total: 0, scheduled: 0, unplaced: [] };
    const phases = sched.phases ?? [];
    const todayStr = planData.today ?? '';
    const activePhase = phases.find((p) => p.from <= todayStr && todayStr <= p.until) ?? phases[0] ?? null;

    // Show full multi-row phase block only when viewport has comfortable vertical room.
    const showPhaseBlock = tabBodyH >= 18 && phases.length > 0;
    const shownPhases = showPhaseBlock ? phases.slice(0, 3) : [];
    const phaseRowsUsed = showPhaseBlock ? 1 + shownPhases.length : 1;
    // Fixed rows: status(1) + progress(1) + phaseRowsUsed + scheduleDivider(1) + detailDivider(1) + detail(1)
    const fixedRows = 5 + phaseRowsUsed;
    const listH = Math.max(3, tabBodyH - fixedRows);

    const selectedDay = upcomingDays[Math.min(dayIdx, Math.max(0, upcomingDays.length - 1))] ?? null;
    const selectedPhaseObj = selectedDay?.phase ? phases.find((p) => p.name === selectedDay.phase) : null;
    const selectedPointTitles = (selectedDay?.points ?? [])
      .slice(0, 3)
      .map((pid) => pointMap.get(pid)?.title || pid)
      .join(', ');

    const learntRatio = progress.total > 0 ? progress.learnt / progress.total : 0;
    const barW = Math.max(14, Math.min(34, Math.floor(innerW * 0.42)));
    const planPaused = planData.plan?.status === 'paused';

    const capText = sched.capacity ? `${sched.capacity}m/${t(lang, '天', 'd')}` : '';
    const cycleText = sched.reviewCycleDays && sched.reviewCycleDays >= 2 ? `${t(lang, '每', 'Rev/')}${sched.reviewCycleDays}${t(lang, '天复习', 'd')}` : '';
    const weeklyText = sched.weekly
      ? `${t(lang, '第', 'Wk')}${sched.weekly.thisWeek ?? '-'}${t(lang, '周', '')}${sched.weekly.behind ? ` ${t(lang, '欠', 'behind:')}${sched.weekly.behind}` : ''}`
      : '';

    return (
      <Box flexDirection="column" height={tabBodyH} overflow="hidden">
        {/* Row 1: status, countdown, rhythm */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Box gap={1} overflow="hidden">
            <Badge
              label={planPaused ? t(lang, '已暂停', 'Paused') : stMeta.label}
              tone={planPaused ? 'warning' : stMeta.tone}
              variant="soft"
            />
            {countdownBadge ? <Badge label={countdownBadge.label} tone={countdownBadge.tone} variant="outline" /> : null}
          </Box>
          <Text color={theme.muted} wrap="truncate-end">
            {[capText, cycleText, weeklyText].filter(Boolean).join(` ${sep} `)}
          </Text>
        </Box>

        {/* Row 2: progress + coverage */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <ProgressBar
            ratio={learntRatio}
            width={barW}
            style="block"
            label={t(lang, `已学 ${progress.learnt}/${progress.total}`, `Learnt ${progress.learnt}/${progress.total}`)}
          />
          <Text color={theme.muted} wrap="truncate-end">
            {`${t(lang, '已排', 'Sched')} ${coverage.scheduled}/${coverage.total}`}
            {coverage.unplaced.length > 0 ? ` (${t(lang, '未排', 'Unplaced')} ${coverage.unplaced.length})` : ''}
            {progress.totalDays > 0 ? ` ${sep} ${t(lang, '第', 'D')}${progress.elapsedDays}/${progress.totalDays}${t(lang, '天', '')}` : ''}
          </Text>
        </Box>

        {/* Phases */}
        {showPhaseBlock ? (
          <>
            <Divider width={innerW} label={t(lang, `阶段规划 (${phases.length})`, `Phases (${phases.length})`)} />
            {shownPhases.map((ph, idx) => {
              const isCurrent = ph.from <= todayStr && todayStr <= ph.until;
              const marker = isCurrent ? (asciiMode ? '*' : '▶') : (asciiMode ? '-' : '•');
              const range = `${ph.from.slice(5)}${arrow}${ph.until.slice(5)}`;
              const goalPart = ph.goal ? ` ${sep} ${ph.goal}` : '';
              return (
                <Box key={`${ph.name}:${idx}`} height={1} overflow="hidden">
                  <Text color={isCurrent ? theme.primary : theme.muted} bold={isCurrent} wrap="truncate-end">
                    {truncateDisplay(`${marker} ${ph.name} (${range})${goalPart}`, innerW, ell)}
                  </Text>
                </Box>
              );
            })}
          </>
        ) : (
          <Box height={1} overflow="hidden">
            <Text color={activePhase ? theme.accent : theme.muted} wrap="truncate-end">
              {activePhase
                ? truncateDisplay(
                    `${t(lang, '当前阶段', 'Phase')}: ${activePhase.name} (${activePhase.from.slice(5)}${arrow}${activePhase.until.slice(5)})${activePhase.goal ? ` ${sep} ${activePhase.goal}` : ''}`,
                    innerW,
                    ell,
                  )
                : t(lang, '阶段: 默认备考期', 'Phase: Default')}
            </Text>
          </Box>
        )}

        {/* Upcoming schedule VirtualList */}
        <Divider width={innerW} label={t(lang, `近期日程 (${upcomingDays.length})`, `Upcoming Schedule (${upcomingDays.length})`)} />
        <VirtualList
          items={upcomingDays}
          width={innerW}
          height={listH}
          selectedIndex={dayIdx}
          onChange={(idx) => setDayIdx(idx)}
          isActive={modalActive && tab === 'plan' && !busyLabel}
          keyExtractor={(item) => item.date}
          emptyText={t(lang, '暂无近期排期条目', 'No upcoming days scheduled')}
          renderItem={renderScheduleRow}
        />

        {/* Selected day detail */}
        <Divider width={innerW} />
        <Box height={1} overflow="hidden">
          <Text color={theme.text} wrap="truncate-end">
            {selectedDay
              ? truncateDisplay(
                  `${selectedDay.date}${selectedDay.phase ? ` [${selectedDay.phase}${selectedPhaseObj?.goal ? `: ${selectedPhaseObj.goal}` : ''}]` : ''} ${sep} ${selectedPointTitles || formatPlanDayReason(selectedDay, lang)}`,
                  innerW,
                  ell,
                )
              : t(lang, '使用 j/k 或方向键浏览每日安排', 'Use j/k or arrows to inspect daily schedule')}
          </Text>
        </Box>
      </Box>
    );
  };

  const renderReadinessTab = () => {
    if (readinessLoading && !readinessData && !previewData) {
      return (
        <Box height={tabBodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在分析章节就绪度与估算${ell}`, `Loading chapter readiness & estimate${ell}`)} active={isActive} />
        </Box>
      );
    }
    if (readinessError && !readinessData && !previewData) {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '✕'}
          title={t(lang, '加载章节就绪度失败', 'Failed to load readiness')}
          hint={readinessError}
          actions={[{ key: 'r', label: t(lang, '重试', 'Retry') }]}
          width={innerW}
          height={tabBodyH}
        />
      );
    }

    if (readinessData?.status === 'no-course' && previewData?.status === 'no-course') {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '◷'}
          title={t(lang, '尚未选择课程', 'No course selected')}
          hint={t(lang, '按 [Esc] 返回后按 [c] 选择一门课程。', 'Press [Esc], then [c] to select a course.')}
          width={innerW}
          height={tabBodyH}
        />
      );
    }

    const total = readinessData?.total;
    const est = previewData?.estimate;
    const basis = readinessData?.basis ?? previewData?.skeleton?.basis ?? 'outline';
    const basisLabel =
      readinessData?.status === 'no-book'
        ? t(lang, '未建全书', 'No Book')
        : basis === 'outline'
          ? t(lang, '总纲章节', 'Outline')
          : t(lang, '资料章节', 'Documents');

    // Fixed rows: total summary(1) + estimate(1) + divider(1) + detailDivider(1) + detail(1) = 5
    const listH = Math.max(3, tabBodyH - 5);
    const selectedChapter = chapters[Math.min(chapterIdx, Math.max(0, chapters.length - 1))] ?? null;

    return (
      <Box flexDirection="column" height={tabBodyH} overflow="hidden">
        {/* Row 1: Total readiness summary */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Box gap={1} overflow="hidden">
            <Badge label={basisLabel} tone={readinessData?.status === 'ok' ? 'accent' : 'warning'} variant="soft" />
            {total && total.readiness !== null ? (
              <ProgressBar
                ratio={total.readiness}
                width={Math.max(14, Math.min(26, Math.floor(innerW * 0.34)))}
                style="block"
                label={t(lang, '总就绪', 'Ready')}
              />
            ) : (
              <Text color={theme.dim}>{t(lang, '总就绪度: --', 'Readiness: --')}</Text>
            )}
          </Box>
          {total ? (
            <Text color={theme.muted} wrap="truncate-end">
              {`${t(lang, '点', 'Pts')}:${total.points} ${t(lang, '讲', 'E')}:${fmtCount(total.explained)} ${t(lang, '问', 'A')}:${fmtCount(total.asked)} ${t(lang, '练', 'P')}:${fmtCount(total.practised)} ${t(lang, '稳', 'S')}:${fmtCount(total.solid)}`}
            </Text>
          ) : null}
        </Box>

        {/* Row 2: Rough token / call estimate */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Text color={theme.info} wrap="truncate-end">
            {est?.total && est.total.calls > 0
              ? truncateDisplay(
                  t(
                    lang,
                    `粗估消耗(非计费): 约 ${est.total.calls} 次调用 · 读入 ${fmtTokenRange(est.total.readTokens)} tokens (全书 ${est.book?.calls ?? 0} / 出题 ${est.questions?.calls ?? 0})`,
                    `Rough est.(no price): ~${est.total.calls} calls · ${fmtTokenRange(est.total.readTokens)} read tok (Book ${est.book?.calls ?? 0} / Qs ${est.questions?.calls ?? 0})`,
                  ),
                  innerW - 14,
                  ell,
                )
              : t(lang, '粗估消耗: 暂无待估算调用', 'Rough est.: 0 model calls')}
          </Text>
          <Text color={theme.accent} bold>
            {t(lang, '[f] 补齐缺失', '[f] Fill')}
          </Text>
        </Box>

        {/* Chapters list */}
        <Divider width={innerW} label={t(lang, `章节就绪度 (${chapters.length})`, `Chapter Readiness (${chapters.length})`)} />
        {chapters.length === 0 ? (
          <EmptyState
            icon={asciiMode ? '*' : '▣'}
            title={
              readinessData?.status === 'no-book'
                ? t(lang, '尚未生成总纲或定制范围', 'No outline or custom plan yet')
                : t(lang, '暂无可统计章节', 'No chapters to measure')
            }
            hint={t(
              lang,
              '按 [Esc] 返回后前往 [7] 复习全书按 [g] 生成总纲与全书，即可统计章节就绪度。',
              'Press [Esc], open [7] Book and press [g] to build outline & review book.',
            )}
            width={innerW}
            height={listH + 2}
          />
        ) : (
          <>
            <VirtualList
              items={chapters}
              width={innerW}
              height={listH}
              selectedIndex={chapterIdx}
              onChange={(idx) => setChapterIdx(idx)}
              isActive={modalActive && tab === 'readiness' && !busyLabel}
              keyExtractor={(ch) => ch.id}
              renderItem={renderChapterRow}
            />
            <Divider width={innerW} />
            <Box height={1} overflow="hidden">
              <Text color={theme.text} wrap="truncate-end">
                {selectedChapter
                  ? truncateDisplay(
                      `${t(lang, '讲解', 'Expl')}:${fmtCount(selectedChapter.explained)}/${selectedChapter.points} ${sep} ${t(lang, '出题', 'Ask')}:${fmtCount(selectedChapter.asked)} ${sep} ${t(lang, '已练', 'Prac')}:${fmtCount(selectedChapter.practised)} ${sep} ${t(lang, '稳固', 'Solid')}:${fmtCount(selectedChapter.solid)} ${sep} ${t(lang, '薄弱', 'Weak')}:${fmtCount(selectedChapter.weak)} ${sep} ${t(lang, '就绪', 'Ready')}:${selectedChapter.readiness !== null ? `${Math.round(selectedChapter.readiness * 100)}%` : '--'}${selectedChapter.gapHint ? ` ${sep} ${selectedChapter.gapHint}` : ''}`,
                      innerW,
                      ell,
                    )
                  : t(lang, '按 [f] 预览并补齐缺失讲解/题目', 'Press [f] to preview & fill missing items')}
              </Text>
            </Box>
          </>
        )}
      </Box>
    );
  };

  const renderCustomRow = useCallback(
    (row: CustomOptionRow, ctx: VirtualListRenderContext) => {
      const isPart = row.id.startsWith('part:');
      const checkStr = isPart ? (row.enabled ? (asciiMode ? '[x] ' : '[✓] ') : '[ ] ') : '    ';
      const labelBudget = Math.max(16, Math.min(26, Math.floor(ctx.width * 0.36)));
      const labelText = padDisplay(truncateDisplay(`${checkStr}${row.label}`, labelBudget, ell), labelBudget);

      const valDisplay = isPart
        ? row.value
        : asciiMode
          ? `< ${row.value} >`
          : `‹ ${row.value} ›`;
      const valBudget = Math.max(10, Math.min(24, ctx.width - labelBudget - 2));
      const valText = padDisplay(truncateDisplay(valDisplay, valBudget, ell), valBudget);

      const noteAvail = Math.max(0, ctx.width - labelBudget - valBudget - 2);
      const noteText = noteAvail >= 4 ? ` ${truncateDisplay(row.note, noteAvail - 1, ell)}` : '';

      const fg = ctx.selected ? theme.selectionFg : theme.text;
      const valColor = ctx.selected
        ? theme.selectionFg
        : isPart
          ? row.enabled
            ? theme.success
            : theme.dim
          : theme.primary;
      const noteColor = ctx.selected ? theme.selectionFg : row.locked ? theme.warning : theme.muted;

      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={ctx.selected ? theme.selectionFg : isPart && !row.enabled ? theme.muted : theme.text}>
            {labelText}
          </Text>
          <Text color={valColor} bold={ctx.selected || !isPart || Boolean(row.enabled)}>
            {` ${valText}`}
          </Text>
          {noteText ? <Text color={noteColor}>{noteText}</Text> : null}
        </Text>
      );
    },
    [asciiMode, ell, theme],
  );

  const renderCustomTab = () => {
    if (customLoading && !customDraft) {
      return (
        <Box height={tabBodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在加载深度定制配置${ell}`, `Loading custom plan${ell}`)} active={isActive} />
        </Box>
      );
    }
    if (customError && !customDraft) {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '✕'}
          title={t(lang, '加载深度定制失败', 'Failed to load custom plan')}
          hint={customError}
          actions={[{ key: 'r', label: t(lang, '重试', 'Retry') }]}
          width={innerW}
          height={tabBodyH}
        />
      );
    }
    if (customPreviewData?.status === 'no-course' || !effectiveCourse) {
      return (
        <EmptyState
          icon={asciiMode ? '!' : '◷'}
          title={t(lang, '尚未选择课程', 'No course selected')}
          hint={t(lang, '按 [Esc] 返回后按 [c] 选择一门课程。', 'Press [Esc], then [c] to select a course.')}
          width={innerW}
          height={tabBodyH}
        />
      );
    }
    if (!customDraft) {
      return (
        <Box height={tabBodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在初始化向导${ell}`, `Initializing wizard${ell}`)} active={isActive} />
        </Box>
      );
    }

    const est = customPreviewData?.estimate;
    const listH = Math.max(3, tabBodyH - 5);
    const activeRow = customRows[Math.min(customRowIdx, Math.max(0, customRows.length - 1))] ?? null;
    const lrHint = asciiMode ? 'Space/<->' : 'Space/←/→';
    const estSummary =
      est?.total && est.total.calls > 0
        ? innerW < 64
          ? t(
              lang,
              `粗估: ~${est.total.calls}次 ${sep} ${fmtTokenRange(est.total.readTokens)} tok (书${est.book?.calls ?? 0}/题${est.questions?.calls ?? 0})`,
              `Est: ~${est.total.calls} calls ${sep} ${fmtTokenRange(est.total.readTokens)} tok (B:${est.book?.calls ?? 0}/Q:${est.questions?.calls ?? 0})`,
            )
          : t(
              lang,
              `粗估(非计费): 约 ${est.total.calls} 次调用 ${sep} 读入 ${fmtTokenRange(est.total.readTokens)} tok (全书 ${est.book?.calls ?? 0} / 出题 ${est.questions?.calls ?? 0})`,
              `Rough est.(no price): ~${est.total.calls} calls ${sep} ${fmtTokenRange(est.total.readTokens)} read tok (Book ${est.book?.calls ?? 0} / Qs ${est.questions?.calls ?? 0})`,
            )
        : t(lang, '粗估(非计费): 0 次调用 (未勾选生成项)', 'Rough est.(no price): 0 calls (no generation selected)');
    const estRight =
      est && ((est.book?.points ?? 0) > 0 || (est.questions?.count ?? 0) > 0)
        ? ` ${t(lang, '点', 'Pts')}:${est.book?.points ?? 0} ${t(lang, '题', 'Qs')}:${est.questions?.count ?? 0}`
        : '';

    return (
      <Box flexDirection="column" height={tabBodyH} overflow="hidden">
        {/* Row 1: Saved status & quick actions */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Box gap={1} overflow="hidden">
            {savedCustomNormalized && !isCustomDirty ? (
              <Badge label={t(lang, '已保存', 'Saved')} tone="success" variant="soft" />
            ) : savedCustomNormalized ? (
              <Badge label={t(lang, '已修改(未存)', 'Modified')} tone="warning" variant="soft" />
            ) : (
              <Badge label={t(lang, '草稿(未存)', 'Draft')} tone="accent" variant="soft" />
            )}
            <Badge
              label={
                customDraft.plan.by === 'weekly'
                  ? t(lang, `按周(${customDraft.plan.chaptersPerWeek ?? 1}章/周)`, `Weekly(${customDraft.plan.chaptersPerWeek ?? 1}/wk)`)
                  : t(lang, '按考期排期', 'By Exam')
              }
              tone="muted"
              variant="outline"
            />
          </Box>
          <Text color={theme.accent} bold>
            {t(lang, '[s] 保存  [a] 应用', '[s] Save  [a] Apply')}
          </Text>
        </Box>

        {/* Row 2: Live zero-cost estimate */}
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Text color={customPreviewBusy ? theme.warning : theme.info} wrap="truncate-end">
            {customPreviewBusy
              ? truncateDisplay(t(lang, `正在重算零成本估算${ell}`, `Updating zero-cost estimate${ell}`), innerW, ell)
              : truncateDisplay(estSummary, Math.max(12, innerW - displayWidth(estRight) - 1), ell)}
          </Text>
          {!customPreviewBusy && estRight ? <Text color={theme.muted}>{estRight}</Text> : null}
        </Box>

        {/* Rows list */}
        <Divider width={innerW} label={t(lang, `深度定制向导 (${lrHint} 调整)`, `Custom Plan Wizard (${lrHint})`)} />
        <VirtualList
          items={customRows}
          width={innerW}
          height={listH}
          selectedIndex={customRowIdx}
          onChange={(idx) => setCustomRowIdx(idx)}
          onSelect={(row) => adjustCustomRow(row.id, 1)}
          isActive={modalActive && tab === 'custom' && !busyLabel}
          keyExtractor={(row) => row.id}
          renderItem={renderCustomRow}
        />
        <Divider width={innerW} />
        <Box height={1} overflow="hidden">
          <Text color={theme.text} wrap="truncate-end">
            {activeRow
              ? truncateDisplay(activeRow.detail, innerW, ell)
              : t(lang, `使用 ${lrHint} 调整参数，[s] 保存，[a] 应用`, `Use ${lrHint} to edit, [s] Save, [a] Apply`)}
          </Text>
        </Box>
      </Box>
    );
  };

  const courseBadgeText = truncateDisplay(
    effectiveCourse || t(lang, '未选课程', 'No Course'),
    Math.max(8, Math.min(22, innerW - (lang === 'zh' ? 44 : 46))),
    ell,
  );

  return (
    <>
      <Modal
        title={t(lang, '课程备考计划 & 章节就绪度', 'Study Plan & Chapter Readiness')}
        icon={asciiMode ? '*' : '◷'}
        tone="primary"
        subtitle={effectiveCourse || undefined}
        width={frameW}
        height={frameH}
        onClose={onClose}
        isActive={modalActive}
        hints={hints}
      >
        {/* Top Modal Tab Switcher (1 row) */}
        <Box height={1} justifyContent="space-between" overflow="hidden" flexShrink={0}>
          <Box gap={1} overflow="hidden">
            <Text
              backgroundColor={tab === 'plan' ? theme.primary : theme.surface}
              color={tab === 'plan' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={tab === 'plan'}
            >
              {` 1:${t(lang, '备考计划', 'Study Plan')} `}
            </Text>
            <Text
              backgroundColor={tab === 'readiness' ? theme.primary : theme.surface}
              color={tab === 'readiness' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={tab === 'readiness'}
            >
              {` 2:${t(lang, '章节就绪度', 'Readiness')}${chapters.length > 0 ? ` (${chapters.length})` : ''} `}
            </Text>
            <Text
              backgroundColor={tab === 'custom' ? theme.primary : theme.surface}
              color={tab === 'custom' ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
              bold={tab === 'custom'}
            >
              {` 3:${t(lang, '深度定制', 'Custom')} `}
            </Text>
          </Box>
          <Box gap={1} overflow="hidden">
            {busyLabel ? <Spinner label={truncateDisplay(busyLabel, 18, ell)} active={isActive} /> : null}
            <Badge label={courseBadgeText} tone="accent" variant="soft" />
          </Box>
        </Box>

        <Divider width={innerW} />

        {tab === 'plan' ? renderPlanTab() : tab === 'readiness' ? renderReadinessTab() : renderCustomTab()}
      </Modal>

      {confirmFill ? (
        <ConfirmDialog
          title={t(lang, '确认补齐缺失内容', 'Confirm Fill Missing')}
          width={Math.min(64, Math.max(40, width - 8))}
          confirmLabel={t(lang, '开始补齐', 'Start Fill')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onCancel={() => setConfirmFill(null)}
          onConfirm={() => void handleConfirmFill()}
          message={
            <Box flexDirection="column">
              <Text color={theme.text} bold>
                {t(
                  lang,
                  `将为「${confirmFill.course || effectiveCourse}」启动以下补齐任务：`,
                  `Start missing fill jobs for "${confirmFill.course || effectiveCourse}":`,
                )}
              </Text>
              {confirmFill.book ? (
                <Text color={theme.text}>
                  {`${asciiMode ? '-' : '•'} ${t(lang, `补写全书讲解: ${confirmFill.book.points} 个知识点 (${confirmFill.book.chapters.length} 章)`, `Book explanations: ${confirmFill.book.points} pts (${confirmFill.book.chapters.length} ch)`)}`}
                </Text>
              ) : null}
              {confirmFill.questions ? (
                <Text color={theme.text}>
                  {`${asciiMode ? '-' : '•'} ${t(lang, `补齐题目草稿: ${confirmFill.questions.points} 个知识点 (${confirmFill.questions.chapters} 章)`, `Question drafts: ${confirmFill.questions.points} pts (${confirmFill.questions.chapters} ch)`)}`}
                </Text>
              ) : null}
              {confirmFill.variants ? (
                <Text color={theme.text}>
                  {`${asciiMode ? '-' : '•'} ${t(lang, `生成薄弱变式题: ${confirmFill.variants.cards} 题 (${confirmFill.variants.points} 知识点)`, `Weak variants: ${confirmFill.variants.cards} cards (${confirmFill.variants.points} pts)`)}`}
                </Text>
              ) : null}
              <Text color={theme.muted}>
                {t(
                  lang,
                  `粗估调用次数(非计费): ${confirmFill.calls ? `${fmtCallRange(confirmFill.calls)} 次` : '部分步骤暂不可估'}`,
                  `Rough call estimate (no price): ${confirmFill.calls ? `${fmtCallRange(confirmFill.calls)} calls` : 'unavailable for some steps'}`,
                )}
              </Text>
            </Box>
          }
        />
      ) : null}

      {confirmApply && savedCustomNormalized ? (
        <ConfirmDialog
          title={t(lang, '确认应用深度定制方案', 'Confirm Apply Custom Plan')}
          width={Math.min(64, Math.max(40, width - 8))}
          confirmLabel={t(lang, '开始应用', 'Apply Now')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onCancel={() => setConfirmApply(false)}
          onConfirm={() => void handleConfirmApply()}
          message={
            <Box flexDirection="column">
              <Text color={theme.text} bold>
                {t(
                  lang,
                  `将按已保存方案为「${effectiveCourse}」启动构建与出题任务：`,
                  `Apply saved custom plan for "${effectiveCourse}":`,
                )}
              </Text>
              <Text color={theme.text}>
                {`${asciiMode ? '-' : '•'} ${t(lang, '目的', 'Purpose')}: ${purposeMeta(savedCustomNormalized.purpose, lang).label} ${sep} ${scopeLabel(savedCustomNormalized.scope, lang)}`}
              </Text>
              <Text color={theme.text}>
                {`${asciiMode ? '-' : '•'} ${t(lang, '全书部件', 'Book parts')}: ${savedCustomNormalized.book.parts.length > 0 ? savedCustomNormalized.book.parts.join(', ') : t(lang, '无', 'none')}`}
              </Text>
              <Text color={theme.text}>
                {`${asciiMode ? '-' : '•'} ${t(lang, '出题强度', 'Strength')}: ${strengthLabel(savedCustomNormalized.questions.strength, lang)} ${sep} ${clampMinutes(savedCustomNormalized.plan.minutesPerDay)}m/${t(lang, '天', 'd')}`}
              </Text>
              {isCustomDirty ? (
                <Text color={theme.warning}>
                  {t(
                    lang,
                    '! 当前有未保存改动，应用将使用上次保存的方案（取消后按 [s] 可保存新改动）',
                    '! Unsaved edits present; this applies the last saved plan (cancel & press [s] to save)',
                  )}
                </Text>
              ) : null}
            </Box>
          }
        />
      ) : null}
    </>
  );
});
