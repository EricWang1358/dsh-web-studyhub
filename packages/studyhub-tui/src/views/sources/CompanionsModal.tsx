import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pathToFileURL } from 'node:url';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useStreamingBuffer } from '../../components/useStreamingBuffer.js';
import { currentCourse } from '../../shell/data.js';
import { truncateDisplay } from '../../render/cjk.js';
import { cleanPathInput, errorMessage, tryAction } from '../../host/sample-actions.js';
import { completeFsPath, expandHomePath } from './path-complete.js';
import { groupSourcesFromSnapshot } from './source-helpers.js';

export interface CompanionsModalProps {
  host: HostClient;
  defaultCourse?: string | null;
  isActive: boolean;
  onChanged?: () => Promise<void> | void;
  onOpenTasks?: (jobId?: string) => void;
  onClose: () => void;
}

interface CompanionSummary {
  id: string;
  title: string;
  course: string;
  courseId?: string;
  mode?: string;
  lessonMode?: string;
  slideCount?: number;
  linkedPath?: string;
  linkedRoot?: string;
  workspacePath?: string;
  sourceId?: string;
  grounded?: boolean;
  bytes?: number;
  progress?: {
    slide?: number;
    slideTotal?: number;
    completed?: boolean;
    checksPassed?: number;
    checksTotal?: number;
  };
  updatedAt?: string;
}

interface ProjectedTerm {
  term: string;
  definition: string;
}

interface ProjectedRelatedCard {
  deckId?: string;
  deckTitle?: string;
  cardId?: string;
  kind?: string;
  topic?: string;
  prompt?: string;
  linkedToCompanion?: boolean;
  isCatchup?: boolean;
  slide?: number;
  level?: string;
}

interface CompanionDetail {
  companion: CompanionSummary;
  file?: string;
  changedOnDisk?: boolean;
  lesson?: {
    id?: string;
    title?: string;
    lead?: string;
    language?: string;
    template?: string;
    mode?: string;
    slideCount?: number;
    slides?: Array<{ title?: string; beat?: string }>;
    needs?: string[];
    after?: string[];
    terms?: ProjectedTerm[];
  } | null;
  savedStats: {
    doubtCount: number;
    checksPassed: number;
    checksTotal: number;
  };
  catchupCount: number;
  relatedCards: ProjectedRelatedCard[];
}

interface FeedbackSyncItem {
  id: string;
  lessonId: string;
  slide: number;
  slideTitle: string;
  tag: string;
  note: string;
  status: string;
}

interface FeedbackSyncSummary {
  companionId: string;
  total: number;
  open: number;
  items: FeedbackSyncItem[];
}

interface BuildEstimateState {
  steps: number;
  grounded: boolean;
  callsText: string;
  tokensText: string;
}

interface BuildJobResult {
  jobId: string;
  status: string;
  steps: number;
  grounded: boolean;
  alreadyRunning: boolean;
}

interface SuggestedCatchupCard {
  prompt: string;
  answer: string;
  misconception: string;
}

type CompanionSubMode = 'browse' | 'attach' | 'ask' | 'ask-view' | 'build' | 'catchup';
type AttachField = 'path' | 'course';
type BuildField = 'course' | 'topic' | 'sources' | 'archetype' | 'mountMode';
type CatchupField = 'prompt' | 'answer' | 'misconception';

const ARCHETYPES = ['auto', 'sandbox', 'dialectic', 'mechanism', 'empirical'] as const;
const MOUNT_MODES = ['auto', 'enrich-existing', 'full-pack', 'companion-only'] as const;
const BUILD_FIELD_ORDER: readonly BuildField[] = ['course', 'topic', 'sources', 'archetype', 'mountMode'];

function formatEstimateRange(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value)).toLocaleString();
  }
  if (value && typeof value === 'object') {
    const obj = value as { low?: unknown; high?: unknown };
    const low = Number(obj.low);
    const high = Number(obj.high);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      const rLow = Math.max(0, Math.round(low));
      const rHigh = Math.max(rLow, Math.round(high));
      return rHigh > rLow ? `${rLow.toLocaleString()}-${rHigh.toLocaleString()}` : rHigh.toLocaleString();
    }
    if (Number.isFinite(high)) return Math.max(0, Math.round(high)).toLocaleString();
    if (Number.isFinite(low)) return Math.max(0, Math.round(low)).toLocaleString();
  }
  return '';
}

function resolveTokensEstimateText(est: Record<string, unknown> | undefined): string {
  if (!est) return '';
  if (est.totalTokens !== undefined && est.totalTokens !== null) {
    return formatEstimateRange(est.totalTokens);
  }
  const inp = est.inputTokens as { low?: unknown; high?: unknown } | number | undefined;
  const out = est.outputTokens as { low?: unknown; high?: unknown } | number | undefined;
  if (inp && typeof inp === 'object' && out && typeof out === 'object') {
    return formatEstimateRange({
      low: (Number(inp.low) || 0) + (Number(out.low) || 0),
      high: (Number(inp.high) || 0) + (Number(out.high) || 0),
    });
  }
  const total = (Number(inp) || 0) + (Number(out) || 0);
  return total > 0 ? total.toLocaleString() : '';
}

function archetypeLabel(arch: (typeof ARCHETYPES)[number], lang: UiLanguage): string {
  switch (arch) {
    case 'sandbox':
      return t(lang, 'sandbox (参数沙盒)', 'sandbox');
    case 'dialectic':
      return t(lang, 'dialectic (思辨矩阵)', 'dialectic');
    case 'mechanism':
      return t(lang, 'mechanism (矢量机理)', 'mechanism');
    case 'empirical':
      return t(lang, 'empirical (实证泳道)', 'empirical');
    default:
      return t(lang, 'auto (智能匹配)', 'auto');
  }
}

function mountModeLabel(mode: (typeof MOUNT_MODES)[number], lang: UiLanguage): string {
  switch (mode) {
    case 'enrich-existing':
      return t(lang, 'enrich-existing (增强挂卡)', 'enrich-existing');
    case 'full-pack':
      return t(lang, 'full-pack (全量导题)', 'full-pack');
    case 'companion-only':
      return t(lang, 'companion-only (仅伴学页)', 'companion-only');
    default:
      return t(lang, 'auto (智能联动)', 'auto');
  }
}

function isCatchupDeckMeta(deck: Record<string, unknown>): boolean {
  const id = String(deck.id ?? '');
  const title = String(deck.title ?? '').trim();
  return (
    deck.companionCatchup === true ||
    id.startsWith('deck-catchup-') ||
    title === '伴学拾遗' ||
    title === 'Companion Catch-ups'
  );
}

/**
 * Project ONLY compact metadata, concepts, and card counts from `companion.get`.
 * Never stores raw `html` or full `savedState` blobs in React state.
 */
function projectCompanionDetail(raw: Record<string, unknown>): CompanionDetail {
  const rawComp = (raw.companion && typeof raw.companion === 'object' ? raw.companion : {}) as Record<string, unknown>;
  const rawLesson = raw.lesson && typeof raw.lesson === 'object' ? (raw.lesson as Record<string, unknown>) : null;
  const rawSaved = raw.savedState && typeof raw.savedState === 'object' ? (raw.savedState as Record<string, unknown>) : null;
  const rawRelated = Array.isArray(raw.relatedCards) ? raw.relatedCards : [];

  const checkMap = rawSaved?.checkResults && typeof rawSaved.checkResults === 'object'
    ? Object.values(rawSaved.checkResults as Record<string, unknown>).filter((v) => typeof v === 'boolean')
    : [];
  const checksPassed = checkMap.filter((v) => v === true).length;
  const doubtCount = Array.isArray(rawSaved?.doubts) ? rawSaved.doubts.length : 0;

  const companion: CompanionSummary = {
    id: String(rawComp.id ?? ''),
    title: String(rawComp.title ?? rawComp.id ?? ''),
    course: String(rawComp.course ?? ''),
    ...(typeof rawComp.courseId === 'string' ? { courseId: rawComp.courseId } : {}),
    ...(typeof rawComp.mode === 'string' ? { mode: rawComp.mode } : {}),
    ...(typeof rawComp.lessonMode === 'string' ? { lessonMode: rawComp.lessonMode } : {}),
    ...(typeof rawComp.slideCount === 'number' ? { slideCount: rawComp.slideCount } : {}),
    ...(typeof rawComp.linkedPath === 'string' ? { linkedPath: rawComp.linkedPath } : {}),
    ...(typeof rawComp.linkedRoot === 'string' ? { linkedRoot: rawComp.linkedRoot } : {}),
    ...(typeof rawComp.workspacePath === 'string' ? { workspacePath: rawComp.workspacePath } : {}),
    ...(typeof rawComp.sourceId === 'string' ? { sourceId: rawComp.sourceId } : {}),
    ...(typeof rawComp.grounded === 'boolean' ? { grounded: rawComp.grounded } : {}),
    ...(typeof rawComp.bytes === 'number' ? { bytes: rawComp.bytes } : {}),
    ...(rawComp.progress && typeof rawComp.progress === 'object'
      ? { progress: rawComp.progress as CompanionSummary['progress'] }
      : {}),
    ...(typeof rawComp.updatedAt === 'string' ? { updatedAt: rawComp.updatedAt } : {}),
  };

  let lesson: CompanionDetail['lesson'] = null;
  if (rawLesson) {
    const rawSlides = Array.isArray(rawLesson.slides) ? rawLesson.slides : [];
    const rawTerms = rawLesson.terms && typeof rawLesson.terms === 'object'
      ? Object.entries(rawLesson.terms as Record<string, unknown>).slice(0, 24)
      : [];
    lesson = {
      ...(typeof rawLesson.id === 'string' ? { id: rawLesson.id } : {}),
      ...(typeof rawLesson.title === 'string' ? { title: rawLesson.title.slice(0, 160) } : {}),
      ...(typeof rawLesson.lead === 'string' ? { lead: rawLesson.lead.slice(0, 600) } : {}),
      ...(typeof rawLesson.language === 'string' ? { language: rawLesson.language } : {}),
      ...(typeof rawLesson.template === 'string' ? { template: rawLesson.template } : {}),
      ...(typeof rawLesson.mode === 'string' ? { mode: rawLesson.mode } : {}),
      slideCount: typeof rawLesson.slideCount === 'number' ? rawLesson.slideCount : rawSlides.length,
      slides: rawSlides.slice(0, 48).map((sl) => {
        const sObj = (sl && typeof sl === 'object' ? sl : {}) as Record<string, unknown>;
        return {
          title: String(sObj.title ?? '').slice(0, 140),
          beat: String(sObj.beat ?? '').slice(0, 40),
        };
      }),
      needs: Array.isArray(rawLesson.needs)
        ? rawLesson.needs.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).slice(0, 12)
        : [],
      after: Array.isArray(rawLesson.after)
        ? rawLesson.after.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).slice(0, 12)
        : [],
      terms: rawTerms.map(([term, val]) => ({
        term: String(term).slice(0, 80),
        definition: typeof val === 'string' ? val.replace(/\s+/g, ' ').trim().slice(0, 180) : '',
      })),
    };
  }

  let catchupCount = 0;
  const relatedCards: ProjectedRelatedCard[] = [];
  for (const item of rawRelated) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const ref = c.companionRef && typeof c.companionRef === 'object' ? (c.companionRef as Record<string, unknown>) : null;
    const deckId = typeof c.deckId === 'string' ? c.deckId : undefined;
    const deckTitle = typeof c.deckTitle === 'string' ? c.deckTitle : undefined;
    const isCatchup = Boolean(
      ref?.manual === true ||
      (deckId && deckId.startsWith('deck-catchup-')) ||
      deckTitle === '伴学拾遗' ||
      deckTitle === 'Companion Catch-ups',
    );
    if (isCatchup) catchupCount += 1;
    if (relatedCards.length < 60) {
      relatedCards.push({
        ...(deckId ? { deckId } : {}),
        ...(deckTitle ? { deckTitle } : {}),
        ...(typeof c.cardId === 'string' ? { cardId: c.cardId } : {}),
        ...(typeof c.kind === 'string' ? { kind: c.kind } : {}),
        ...(typeof c.topic === 'string' ? { topic: c.topic.slice(0, 80) } : {}),
        ...(typeof c.prompt === 'string' ? { prompt: c.prompt.replace(/\s+/g, ' ').slice(0, 140) } : {}),
        linkedToCompanion: Boolean(c.linkedToCompanion),
        isCatchup,
        ...(typeof c.slide === 'number' ? { slide: c.slide } : {}),
        ...(typeof c.level === 'string' ? { level: c.level } : {}),
      });
    }
  }

  return {
    companion,
    ...(typeof raw.file === 'string' ? { file: raw.file } : {}),
    changedOnDisk: Boolean(raw.changedOnDisk),
    lesson,
    savedStats: {
      doubtCount,
      checksPassed,
      checksTotal: checkMap.length,
    },
    catchupCount,
    relatedCards,
  };
}

function buildCompanionMarkdown(
  detail: CompanionDetail,
  lang: UiLanguage,
  opts: {
    asciiMode: boolean;
    courseCatchupDeckCount: number;
    feedback?: FeedbackSyncSummary | null;
  },
): string {
  const { asciiMode, courseCatchupDeckCount, feedback } = opts;
  const dot = asciiMode ? '-' : '·';
  const okMark = asciiMode ? '[OK]' : '✓';
  const comp = detail.companion;
  const lesson = detail.lesson;
  const title = lesson?.title || comp.title || comp.id;
  const archetype = lesson?.template || 'interactive';
  const lessonMode = comp.lessonMode || lesson?.mode;
  const slides = Array.isArray(lesson?.slides) ? lesson.slides : [];
  const slideCount = lesson?.slideCount ?? comp.slideCount ?? slides.length;
  const related = detail.relatedCards;
  const linkedCards = related.filter((c) => c.linkedToCompanion);
  const catchupCards = related.filter((c) => c.isCatchup);
  const shownCards = (linkedCards.length > 0 ? linkedCards : related).slice(0, 12);

  const lines: string[] = [`# ${title}`, ''];
  lines.push(`- **${t(lang, '所属课程', 'Course')}**: ${comp.course || '-'}`);
  lines.push(
    `- **${t(lang, '交互母版', 'Archetype')}**: \`${archetype}\`${lessonMode ? ` (${lessonMode})` : ''} ${dot} **${t(lang, '存储模式', 'Mode')}**: ${comp.mode || 'managed'}${comp.grounded === false ? ` ${dot} ${t(lang, 'AI 自由推演', 'Free-topic AI')}` : ''}`,
  );
  lines.push(`- **${t(lang, '交互页数', 'Slides')}**: ${slideCount}`);

  if (comp.progress && typeof comp.progress.slide === 'number') {
    const prog = comp.progress;
    const checksTot = prog.checksTotal ?? detail.savedStats.checksTotal;
    const checksPass = prog.checksPassed ?? detail.savedStats.checksPassed;
    const checkStr =
      typeof checksTot === 'number' && checksTot > 0
        ? ` ${dot} ${t(lang, '检查点', 'Checks')}: ${checksPass ?? 0}/${checksTot}`
        : '';
    lines.push(
      `- **${t(lang, '学习进度', 'Progress')}**: ${prog.slide}/${prog.slideTotal ?? slideCount}${prog.completed ? ` ${okMark} ${t(lang, '已完成', 'Completed')}` : ''}${checkStr}`,
    );
  } else if (detail.savedStats.checksTotal > 0) {
    lines.push(
      `- **${t(lang, '互动检查点', 'Checks')}**: ${detail.savedStats.checksPassed}/${detail.savedStats.checksTotal}`,
    );
  }

  const catchupTotalText =
    courseCatchupDeckCount > 0
      ? `${detail.catchupCount} ${t(lang, '本课关联', 'for lesson')} / ${courseCatchupDeckCount} ${t(lang, '课程拾遗总卡数', 'in catch-up deck')}`
      : `${detail.catchupCount}`;
  lines.push(
    `- **${t(lang, '伴学拾遗 / 题卡', 'Catch-Up & Cards')}**: ${catchupTotalText} ${dot} ${t(lang, '直连题卡', 'Linked')} ${linkedCards.length}/${related.length}${detail.savedStats.doubtCount > 0 ? ` ${dot} ${t(lang, '本地疑问', 'Doubts')}: ${detail.savedStats.doubtCount}` : ''}`,
  );

  const filePath = detail.file || comp.linkedPath || comp.workspacePath || '';
  if (filePath) {
    lines.push(`- **${t(lang, '本地路径', 'File Path')}**: \`${filePath}\``);
  }
  if (detail.changedOnDisk) {
    lines.push(`- **${t(lang, '磁盘状态', 'Disk')}**: ${t(lang, '检测到磁盘更新（按 [s] 同步）', 'Updated on disk (press [s] to sync)')}`);
  }

  if (feedback) {
    lines.push(
      '',
      `## ${t(lang, '疑问反馈台账', 'Feedback Ledger')} (${feedback.open} ${t(lang, '待解决', 'open')} / ${feedback.total} ${t(lang, '总计', 'total')})`,
      '',
    );
    const openItems = feedback.items.filter((it) => it.status !== 'resolved').slice(0, 8);
    if (openItems.length === 0) {
      lines.push(t(lang, '（当前无未解决的目录疑问条目）', '(No open feedback items)'));
    } else {
      for (const it of openItems) {
        const slideTag = `Slide ${it.slide}`;
        const noteText = it.note || it.slideTitle || it.id;
        lines.push(`- **[${it.tag}]** (${slideTag}) ${noteText}`);
      }
    }
  } else if (comp.linkedRoot) {
    lines.push(
      `- **${t(lang, '目录反馈台账', 'Pack Feedback')}**: ${t(lang, '按 [f] 同步 feedback/questions.json', 'Press [f] to sync feedback/questions.json')}`,
    );
  }

  if (lesson?.lead) {
    lines.push('', `## ${t(lang, '课程导读', 'Overview')}`, '', lesson.lead);
  }

  const terms = lesson?.terms ?? [];
  if (terms.length > 0) {
    lines.push('', `## ${t(lang, '核心学习概念', 'Key Concepts')}`, '');
    for (const item of terms.slice(0, 12)) {
      lines.push(item.definition ? `- **\`${item.term}\`**: ${item.definition}` : `- \`${item.term}\``);
    }
  }

  const needs = Array.isArray(lesson?.needs) ? lesson.needs.filter(Boolean) : [];
  if (needs.length > 0) {
    lines.push('', `## ${t(lang, '前置基础', 'Prerequisites')}`, '');
    for (const item of needs) lines.push(`- ${item}`);
  }

  const after = Array.isArray(lesson?.after) ? lesson.after.filter(Boolean) : [];
  if (after.length > 0) {
    lines.push('', `## ${t(lang, '学习目标', 'Learning Outcomes')}`, '');
    for (const item of after) lines.push(`- ${item}`);
  }

  if (slides.length > 0) {
    lines.push('', `## ${t(lang, '页面与章节目录', 'Slides & Sections')}`, '');
    slides.forEach((sl, idx) => {
      const beat = sl.beat ? `[${sl.beat}] ` : '';
      lines.push(`${idx + 1}. ${beat}${sl.title || `Slide ${idx + 1}`}`);
    });
  }

  if (catchupCards.length > 0) {
    lines.push('', `## ${t(lang, '拾遗防混卡', 'Catch-Up Cards')} (${catchupCards.length})`, '');
    for (const card of catchupCards.slice(0, 6)) {
      const slideTag = card.slide ? `[Slide ${card.slide}] ` : '';
      lines.push(`- ${slideTag}${card.prompt || card.topic || card.cardId || '-'}`);
    }
  }

  lines.push(
    '',
    `## ${t(lang, '关联题卡', 'Linked Cards')} (${linkedCards.length} ${t(lang, '直连', 'linked')} / ${related.length} ${t(lang, '课程相关', 'course')})`,
    '',
  );
  if (shownCards.length === 0) {
    lines.push(t(lang, '（暂无关联题卡，可按 [c] 添加拾遗防混卡）', '(No linked cards yet — press [c] to save a catch-up card)'));
  } else {
    for (const card of shownCards) {
      const slideTag = card.slide ? `[Slide ${card.slide}] ` : '';
      const topicTag = card.topic ? `**${card.topic}** - ` : '';
      const lvl = card.level ? ` (${card.level})` : '';
      lines.push(`- ${slideTag}${topicTag}${String(card.prompt || '').slice(0, 100)}${lvl}`);
    }
  }

  return lines.join('\n');
}

export const CompanionsModal = memo(function CompanionsModal({
  host,
  defaultCourse,
  isActive,
  onChanged,
  onOpenTasks,
  onClose,
}: CompanionsModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { columns, rows: termRows } = useStableWindowSize();

  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  const [subMode, setSubMode] = useState<CompanionSubMode>('browse');
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [courseFilterOn, setCourseFilterOn] = useState(Boolean(defaultCourse));
  const [actionBusy, setActionBusy] = useState(false);

  const [companions, setCompanions] = useState<CompanionSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailRefreshTick, setDetailRefreshTick] = useState(0);

  // Cache ONLY compact projected detail for the currently inspected companion (NEVER raw HTML)
  const [detail, setDetail] = useState<CompanionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [pathNotice, setPathNotice] = useState<string | null>(null);
  const [feedbackSummary, setFeedbackSummary] = useState<FeedbackSyncSummary | null>(null);

  // Ask AI state
  const [askInput, setAskInput] = useState('');
  const {
    text: askAnswer,
    push: pushAskAnswer,
    set: setAskAnswer,
    finish: finishAskAnswer,
    reset: resetAskAnswer,
  } = useStreamingBuffer(24);
  const [askSuggestedCard, setAskSuggestedCard] = useState<SuggestedCatchupCard | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Attach state
  const [attachField, setAttachField] = useState<AttachField>('path');
  const [attachPath, setAttachPath] = useState('');
  const [attachCourse, setAttachCourse] = useState(defaultCourse || '');
  const [attachMatches, setAttachMatches] = useState<string[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const cachedCompletionRef = useRef<{ input: string; completed: string } | null>(null);

  // Build New Companion state (`generation.companion.build`)
  const [buildField, setBuildField] = useState<BuildField>('topic');
  const [buildCourse, setBuildCourse] = useState(() => defaultCourse || currentCourse(snapshot) || '');
  const [buildTopic, setBuildTopic] = useState('');
  const [buildSourceIds, setBuildSourceIds] = useState<string[]>([]);
  const [buildSourceCursor, setBuildSourceCursor] = useState(0);
  const [buildArchetypeIdx, setBuildArchetypeIdx] = useState(0);
  const [buildMountIdx, setBuildMountIdx] = useState(0);
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildErr, setBuildErr] = useState<string | null>(null);
  const [buildEstimate, setBuildEstimate] = useState<BuildEstimateState | null>(null);
  const [buildResult, setBuildResult] = useState<BuildJobResult | null>(null);

  // Manual Catch-Up card form state (`companion.catchup.save`)
  const [catchupField, setCatchupField] = useState<CatchupField>('prompt');
  const [catchupPrompt, setCatchupPrompt] = useState('');
  const [catchupAnswer, setCatchupAnswer] = useState('');
  const [catchupMisconception, setCatchupMisconception] = useState('');
  const [catchupBusy, setCatchupBusy] = useState(false);
  const [catchupErr, setCatchupErr] = useState<string | null>(null);

  const abortInFlight = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
      abortInFlight();
      resetAskAnswer();
      setDetail(null);
      setAskSuggestedCard(null);
      setFeedbackSummary(null);
    };
  }, [abortInFlight, resetAskAnswer]);

  const availableSourceGroups = useMemo(() => {
    const rawSources = (snapshot?.sources ?? []).filter((s) => {
      if (!s || s.archived) return false;
      const rec = s as Record<string, unknown>;
      if (rec.companionId || rec.blueprint || rec.courseOutline || rec.courseInventory) return false;
      if (typeof s.id === 'string' && s.id.startsWith('src-companion-')) return false;
      return true;
    });
    const groups = groupSourcesFromSnapshot(snapshot ? { ...snapshot, sources: rawSources } : null).filter(
      (g) => !g.archived && g.sourceIds.length > 0,
    );
    const targetCourse = buildCourse.trim().toLowerCase();
    if (!targetCourse) return groups;
    return [...groups].sort((a, b) => {
      const aMatch = a.courses.some((c) => c.trim().toLowerCase() === targetCourse) ? 0 : 1;
      const bMatch = b.courses.some((c) => c.trim().toLowerCase() === targetCourse) ? 0 : 1;
      return aMatch - bMatch;
    });
  }, [buildCourse, snapshot]);

  useEffect(() => {
    if (buildSourceCursor >= availableSourceGroups.length) {
      setBuildSourceCursor(Math.max(0, availableSourceGroups.length - 1));
    }
  }, [availableSourceGroups.length, buildSourceCursor]);

  const loadList = useCallback(
    async (preferId?: string) => {
      setListLoading(true);
      setListErr(null);
      const targetCourse = courseFilterOn && defaultCourse ? defaultCourse : '*';
      const res = await tryAction<{ companions?: CompanionSummary[] }>(host, 'companion.list', {
        course: targetCourse,
      });
      if (!mountedRef.current) return;
      setListLoading(false);
      if (!res.ok || !res.value) {
        setListErr(res.error?.message || t(lang, '读取伴学列表失败', 'Failed to list companions'));
        setCompanions([]);
        return;
      }
      const list = Array.isArray(res.value.companions) ? res.value.companions : [];
      setCompanions(list);
      if (preferId) {
        const idx = list.findIndex((c) => c.id === preferId);
        if (idx >= 0) setSelectedIndex(idx);
      }
    },
    [courseFilterOn, defaultCourse, host, lang],
  );

  useEffect(() => {
    if (!isActive) return;
    void loadList();
  }, [isActive, loadList]);

  useEffect(() => {
    if (selectedIndex >= companions.length) {
      setSelectedIndex(Math.max(0, companions.length - 1));
    }
  }, [companions.length, selectedIndex]);

  const selectedCompanion = companions[selectedIndex];

  useEffect(() => {
    abortInFlight();
    resetAskAnswer();
    setAskSuggestedCard(null);
    setAskBusy(false);
  }, [abortInFlight, isActive, resetAskAnswer, selectedCompanion?.id]);

  useEffect(() => {
    setPathNotice(null);
    if (!isActive || !selectedCompanion) {
      setDetail(null);
      setDetailErr(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailErr(null);
    void tryAction<Record<string, unknown>>(host, 'companion.get', {
      id: selectedCompanion.id,
      ...(selectedCompanion.course ? { course: selectedCompanion.course } : {}),
    }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      setDetailLoading(false);
      if (res.ok && res.value) {
        setDetail(projectCompanionDetail(res.value));
      } else {
        setDetail(null);
        setDetailErr(res.error?.message || t(lang, '无法读取伴学页详情', 'Failed to load companion details'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [host, isActive, lang, selectedCompanion, detailRefreshTick]);

  // Pre-fetch path completions for [i] Attach modal
  useEffect(() => {
    if (!isActive || subMode !== 'attach' || attachField !== 'path') return;
    let cancelled = false;
    const cleaned = cleanPathInput(attachPath);
    void completeFsPath(cleaned, { extensions: ['.html', '.htm', '.json'] }).then((res) => {
      if (cancelled || !mountedRef.current) return;
      cachedCompletionRef.current = { input: attachPath, completed: res.completed };
      setAttachMatches(res.matches.slice(0, 6));
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, subMode, attachField, attachPath]);

  const handleAttachTabComplete = useCallback((val: string) => {
    const cached = cachedCompletionRef.current;
    if (cached && cached.input === val && cached.completed && cached.completed !== val) {
      return cached.completed;
    }
    const cleaned = cleanPathInput(val);
    void completeFsPath(cleaned, { extensions: ['.html', '.htm', '.json'] }).then((res) => {
      if (!mountedRef.current) return;
      cachedCompletionRef.current = { input: res.completed, completed: res.completed };
      setAttachMatches(res.matches.slice(0, 6));
      if (res.completed && res.completed !== val) setAttachPath(res.completed);
    });
    return undefined;
  }, []);

  const submitAttach = useCallback(async () => {
    if (busyRef.current || attachBusy) return;
    const expanded = expandHomePath(cleanPathInput(attachPath));
    if (!expanded) {
      setAttachErr(
        t(
          lang,
          '请输入 HTML / .lesson.json 文件或伴学目录路径',
          'Please enter a local HTML / .lesson.json file or pack directory path',
        ),
      );
      return;
    }
    busyRef.current = true;
    setAttachBusy(true);
    setAttachErr(null);
    try {
      const res = await tryAction<Record<string, unknown>>(host, 'companion.attach', {
        path: expanded,
        ...(attachCourse.trim() ? { course: attachCourse.trim() } : {}),
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setAttachErr(res.error?.message || t(lang, '挂载伴学页失败', 'Failed to attach companion'));
        return;
      }
      const val = res.value;
      let createdId: string | undefined;
      if (val.kind === 'directory') {
        notify(
          t(
            lang,
            `已挂载目录：新增 ${Number(val.attached ?? 0)} 页，更新 ${Number(val.updated ?? 0)} 页`,
            `Attached pack: ${Number(val.attached ?? 0)} added, ${Number(val.updated ?? 0)} updated`,
          ),
          'success',
        );
      } else {
        const comp = val.companion as { id?: string; title?: string } | undefined;
        createdId = comp?.id;
        notify(
          t(lang, `已挂载伴学页：${comp?.title || expanded}`, `Attached companion: ${comp?.title || expanded}`),
          'success',
        );
      }
      await loadList(createdId);
      await onChanged?.();
      if (!mountedRef.current) return;
      setAttachPath('');
      setSubMode('browse');
    } catch (error) {
      if (mountedRef.current) setAttachErr(errorMessage(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setAttachBusy(false);
    }
  }, [attachBusy, attachCourse, attachPath, host, lang, loadList, notify, onChanged]);

  const handleSyncDisk = useCallback(async () => {
    if (busyRef.current || !selectedCompanion) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      const res = await tryAction<Record<string, unknown>>(host, 'companion.sync', {
        id: selectedCompanion.id,
        ...(selectedCompanion.course ? { course: selectedCompanion.course } : {}),
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '从磁盘同步伴学页失败', 'Failed to sync companion from disk'), 'warning');
        return;
      }
      const syncInfo = (res.value.sync && typeof res.value.sync === 'object' ? res.value.sync : null) as
        | { cardsAdded?: number; cardsLinked?: number }
        | null;
      const changed = Boolean(res.value.changed);
      const compTitle =
        ((res.value.companion as { title?: string } | undefined)?.title || selectedCompanion.title || selectedCompanion.id);
      const cardParts: string[] = [];
      if (syncInfo && Number(syncInfo.cardsAdded) > 0) {
        cardParts.push(t(lang, `新增 ${Number(syncInfo.cardsAdded)} 卡`, `${Number(syncInfo.cardsAdded)} added`));
      }
      if (syncInfo && Number(syncInfo.cardsLinked) > 0) {
        cardParts.push(t(lang, `关联 ${Number(syncInfo.cardsLinked)} 卡`, `${Number(syncInfo.cardsLinked)} linked`));
      }
      const suffix = cardParts.length > 0 ? ` (${cardParts.join(', ')})` : '';
      notify(
        changed
          ? t(lang, `已从磁盘同步更新：${compTitle}${suffix}`, `Synced disk update: ${compTitle}${suffix}`)
          : t(lang, `磁盘伴学内容已是最新：${compTitle}${suffix}`, `Companion up to date on disk: ${compTitle}${suffix}`),
        'success',
      );
      await loadList(selectedCompanion.id);
      setDetailRefreshTick((n) => n + 1);
      await onChanged?.();
    } catch (error) {
      if (mountedRef.current) notify(errorMessage(error), 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setActionBusy(false);
    }
  }, [host, lang, loadList, notify, onChanged, selectedCompanion]);

  const handleFeedbackSync = useCallback(async () => {
    if (busyRef.current || !selectedCompanion) return;
    busyRef.current = true;
    setActionBusy(true);
    try {
      const res = await tryAction<Record<string, unknown>>(host, 'companion.feedback.sync', {
        id: selectedCompanion.id,
        ...(selectedCompanion.course ? { course: selectedCompanion.course } : {}),
        language: lang,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        notify(
          res.error?.message || t(lang, '同步目录疑问台账失败', 'Failed to sync feedback ledger'),
          'info',
        );
        return;
      }
      const total = Number(res.value.total) || 0;
      const open = Number(res.value.open) || 0;
      const rawItems = Array.isArray(res.value.items) ? res.value.items : [];
      const items: FeedbackSyncItem[] = rawItems.slice(0, 15).map((raw) => {
        const it = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        return {
          id: String(it.id ?? ''),
          lessonId: String(it.lessonId ?? ''),
          slide: Number(it.slide) || 1,
          slideTitle: String(it.slideTitle ?? '').slice(0, 80),
          tag: String(it.tag ?? 'unclear'),
          note: String(it.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
          status: String(it.status ?? 'open'),
        };
      });
      setFeedbackSummary({
        companionId: selectedCompanion.id,
        total,
        open,
        items,
      });
      notify(
        t(lang, `已同步疑问台账：待解决 ${open} / 共 ${total} 条`, `Feedback synced: ${open} open / ${total} total`),
        'success',
      );
    } catch (error) {
      if (mountedRef.current) notify(errorMessage(error), 'error');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setActionBusy(false);
    }
  }, [host, lang, notify, selectedCompanion]);

  const runBuildEstimate = useCallback(async () => {
    if (busyRef.current) return;
    const courseName = buildCourse.trim();
    const topicText = buildTopic.trim();
    if (!courseName) {
      setBuildErr(t(lang, '请先输入所属课程名称', 'Please enter a course name first'));
      return;
    }
    if (!topicText && buildSourceIds.length === 0) {
      setBuildErr(
        t(lang, '请输入伴学主题，或至少勾选一份参考资料', 'Enter a topic/prompt or select at least one source'),
      );
      return;
    }
    busyRef.current = true;
    setBuildBusy(true);
    setBuildErr(null);
    try {
      const res = await tryAction<Record<string, unknown>>(host, 'generation.companion.build', {
        course: courseName,
        ...(topicText ? { topic: topicText } : {}),
        ...(buildSourceIds.length > 0 ? { sourceIds: buildSourceIds } : {}),
        archetype: ARCHETYPES[buildArchetypeIdx] ?? 'auto',
        mountMode: MOUNT_MODES[buildMountIdx] ?? 'auto',
        language: lang,
        estimate: true,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setBuildErr(res.error?.message || t(lang, '预估伴学生成方案失败', 'Failed to estimate companion build'));
        return;
      }
      const est = (res.value.estimate && typeof res.value.estimate === 'object'
        ? res.value.estimate
        : undefined) as Record<string, unknown> | undefined;
      setBuildEstimate({
        steps: Number(res.value.steps) || 4,
        grounded: Boolean(res.value.grounded),
        callsText: formatEstimateRange(est?.calls ?? { low: 3, high: 4 }) || '3-4',
        tokensText: resolveTokensEstimateText(est) || '-',
      });
    } catch (error) {
      if (mountedRef.current) setBuildErr(errorMessage(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBuildBusy(false);
    }
  }, [buildArchetypeIdx, buildCourse, buildMountIdx, buildSourceIds, buildTopic, host, lang]);

  const runBuildStart = useCallback(async () => {
    if (busyRef.current) return;
    const courseName = buildCourse.trim();
    const topicText = buildTopic.trim();
    if (!courseName || (!topicText && buildSourceIds.length === 0)) return;
    busyRef.current = true;
    setBuildBusy(true);
    setBuildErr(null);
    try {
      const res = await tryAction<Record<string, unknown>>(host, 'generation.companion.build', {
        course: courseName,
        ...(topicText ? { topic: topicText } : {}),
        ...(buildSourceIds.length > 0 ? { sourceIds: buildSourceIds } : {}),
        archetype: ARCHETYPES[buildArchetypeIdx] ?? 'auto',
        mountMode: MOUNT_MODES[buildMountIdx] ?? 'auto',
        language: lang,
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setBuildErr(res.error?.message || t(lang, '启动伴学构建任务失败', 'Failed to start companion build'));
        return;
      }
      const jobId = String(res.value.jobId ?? '');
      const alreadyRunning = Boolean(res.value.alreadyRunning);
      const steps = Number(res.value.steps) || buildEstimate?.steps || 4;
      const grounded = res.value.grounded !== undefined ? Boolean(res.value.grounded) : Boolean(buildEstimate?.grounded);
      setBuildResult({
        jobId,
        status: String(res.value.status ?? 'running'),
        steps,
        grounded,
        alreadyRunning,
      });
      notify(
        alreadyRunning
          ? t(lang, `相同伴学构建任务已在运行: ${jobId}`, `Companion build already running: ${jobId}`)
          : t(lang, `已启动 ${steps} 阶段伴学构建任务: ${jobId}`, `Started ${steps}-stage companion build: ${jobId}`),
        'success',
      );
      await onChanged?.();
    } catch (error) {
      if (mountedRef.current) setBuildErr(errorMessage(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBuildBusy(false);
    }
  }, [buildArchetypeIdx, buildCourse, buildEstimate, buildMountIdx, buildSourceIds, buildTopic, host, lang, notify, onChanged]);

  const saveCatchupPayload = useCallback(
    async (payload: { prompt: string; answer: string; misconception?: string }) => {
      if (busyRef.current || !selectedCompanion) return false;
      busyRef.current = true;
      setCatchupBusy(true);
      setCatchupErr(null);
      try {
        const firstSlide = detail?.lesson?.slides?.[0];
        const res = await tryAction<Record<string, unknown>>(host, 'companion.catchup.save', {
          companionId: selectedCompanion.id,
          ...(selectedCompanion.course ? { course: selectedCompanion.course } : {}),
          slide: 1,
          slideTitle: firstSlide?.title || selectedCompanion.title,
          prompt: payload.prompt.trim(),
          answer: payload.answer.trim(),
          ...(payload.misconception?.trim() ? { misconception: payload.misconception.trim() } : {}),
          syncFeedback: Boolean(selectedCompanion.linkedRoot || detail?.companion?.linkedRoot),
          language: lang,
        });
        if (!mountedRef.current) return false;
        if (!res.ok || !res.value) {
          const msg = res.error?.message || t(lang, '保存伴学拾遗卡失败', 'Failed to save catch-up card');
          setCatchupErr(msg);
          notify(msg, 'error');
          return false;
        }
        const deckTitle = String(res.value.deckTitle || t(lang, '伴学拾遗', 'Companion Catch-ups'));
        const synced = Boolean(res.value.feedbackSynced);
        notify(
          synced
            ? t(lang, `已存入「${deckTitle}」并同步目录反馈`, `Saved to "${deckTitle}" & synced feedback`)
            : t(lang, `已存入「${deckTitle}」（排入次日复习）`, `Saved to "${deckTitle}" for next-day review`),
          'success',
        );
        setDetailRefreshTick((n) => n + 1);
        await onChanged?.();
        return true;
      } catch (error) {
        if (mountedRef.current) {
          const msg = errorMessage(error);
          setCatchupErr(msg);
          notify(msg, 'error');
        }
        return false;
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setCatchupBusy(false);
      }
    },
    [detail?.companion?.linkedRoot, detail?.lesson?.slides, host, lang, notify, onChanged, selectedCompanion],
  );

  const submitCatchup = useCallback(async () => {
    if (!catchupPrompt.trim() || !catchupAnswer.trim()) {
      setCatchupErr(t(lang, '请填写问题与解答', 'Please enter both prompt and answer'));
      return;
    }
    const ok = await saveCatchupPayload({
      prompt: catchupPrompt,
      answer: catchupAnswer,
      misconception: catchupMisconception,
    });
    if (ok && mountedRef.current) {
      setCatchupPrompt('');
      setCatchupAnswer('');
      setCatchupMisconception('');
      setSubMode('browse');
    }
  }, [catchupAnswer, catchupMisconception, catchupPrompt, lang, saveCatchupPayload]);

  const runAsk = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !selectedCompanion) return;
      abortInFlight();
      const ac = new AbortController();
      abortRef.current = ac;
      setSubMode('ask-view');
      setAskBusy(true);
      resetAskAnswer();
      setAskSuggestedCard(null);

      const compTitle = detail?.lesson?.title || selectedCompanion.title;
      const firstSlide = detail?.lesson?.slides?.[0];
      const summaryContext = detail
        ? buildCompanionMarkdown(detail, lang, {
            asciiMode,
            courseCatchupDeckCount: 0,
            feedback: null,
          }).slice(0, 8000)
        : compTitle;

      try {
        const res = await tryAction<{
          answerMarkdown?: string;
          suggestedCard?: { prompt?: string; answer?: string; misconception?: string } | null;
        }>(host, 'companion.ask', {
          id: selectedCompanion.id,
          ...(selectedCompanion.course ? { course: selectedCompanion.course } : {}),
          language: lang,
          question: q,
          context: {
            lessonTitle: compTitle,
            slide: 1,
            slideTitle: firstSlide?.title || compTitle,
            beat: firstSlide?.beat || '',
            codeSlice: summaryContext.slice(0, 1200),
          },
        });

        if (ac.signal.aborted || !mountedRef.current) return;

        if (res.ok && res.value?.answerMarkdown) {
          let md = res.value.answerMarkdown;
          const card = res.value.suggestedCard;
          if (card && (card.prompt || card.answer)) {
            setAskSuggestedCard({
              prompt: card.prompt || q,
              answer: card.answer || res.value.answerMarkdown,
              misconception: card.misconception || '',
            });
            md += `\n\n---\n\n### ${t(lang, '建议防混闪卡 (按 [c] 存入伴学拾遗)', 'Suggested Catch-Up Card (press [c] to save)')}\n\n- **Q**: ${card.prompt || q}\n- **A**: ${card.answer || ''}${card.misconception ? `\n- **${t(lang, '易混点', 'Misconception')}**: ${card.misconception}` : ''}`;
          }
          setAskAnswer(md);
          finishAskAnswer();
        } else if (typeof host.streamComplete === 'function') {
          const system = t(
            lang,
            '你是 StudyHub 交互伴学导师。请基于伴学课内容与结构简洁回答学习者的困惑，使用 Markdown 与 LaTeX 数学公式。',
            'You are the StudyHub Interactive Companion tutor. Answer the learner question concisely in Markdown using the companion context.',
          );
          const prompt = `Companion: ${compTitle}\n\n${summaryContext}\n\nLearner Question: ${q}`;
          const final = await host.streamComplete({
            system,
            prompt,
            signal: ac.signal,
            onChunk: (delta) => {
              if (ac.signal.aborted || !mountedRef.current) return;
              pushAskAnswer(delta);
            },
          });
          if (!ac.signal.aborted && mountedRef.current) {
            if (final) setAskAnswer(final);
            finishAskAnswer();
          }
        } else {
          const mark = asciiMode ? 'x' : '✕';
          setAskAnswer(`${mark} ${res.error?.message || t(lang, 'AI 模型不可用，请先在设置中配置模型', 'AI model unavailable')}`);
          finishAskAnswer();
        }
      } catch (error) {
        if (!ac.signal.aborted && mountedRef.current) {
          const mark = asciiMode ? 'x' : '✕';
          setAskAnswer(`${mark} ${errorMessage(error)}`);
          finishAskAnswer();
        }
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
          if (!ac.signal.aborted && mountedRef.current) {
            finishAskAnswer();
            setAskBusy(false);
          }
        }
      }
    },
    [abortInFlight, asciiMode, detail, finishAskAnswer, host, lang, pushAskAnswer, resetAskAnswer, selectedCompanion, setAskAnswer],
  );

  const handleOpenExternal = useCallback(async () => {
    if (busyRef.current) return;
    const rawPath = detail?.file || selectedCompanion?.linkedPath || selectedCompanion?.workspacePath || '';
    if (!rawPath) {
      notify(t(lang, '该伴学页暂无本地 HTML 路径', 'No HTML file path available for this companion'), 'warning');
      return;
    }
    busyRef.current = true;
    try {
      let openTarget = rawPath;
      if (!/^https?:\/\//i.test(rawPath)) {
        try {
          openTarget = pathToFileURL(rawPath).href;
        } catch {
          openTarget = rawPath;
        }
      }
      const res = await tryAction(host, 'app.open', { url: openTarget, path: rawPath });
      if (!mountedRef.current) return;
      if (res.ok) {
        notify(t(lang, `已请求外部打开: ${rawPath}`, `Opened externally: ${rawPath}`), 'success');
        setPathNotice(null);
      } else {
        setPathNotice(rawPath);
        notify(
          t(lang, `终端模式请用浏览器打开: ${rawPath}`, `Open HTML in browser: ${rawPath}`),
          'info',
        );
      }
    } finally {
      busyRef.current = false;
    }
  }, [detail?.file, host, lang, notify, selectedCompanion]);

  const jumpToTasks = useCallback(
    (jobId?: string) => {
      onClose();
      if (onOpenTasks) {
        onOpenTasks(jobId);
      } else {
        navigate('tasks', jobId ? { jobId } : {});
      }
    },
    [navigate, onClose, onOpenTasks],
  );

  const openBuildModal = useCallback(() => {
    const fallbackCourse = defaultCourse || currentCourse(snapshot) || '';
    setBuildCourse((prev) => prev || fallbackCourse);
    setBuildTopic('');
    setBuildSourceIds([]);
    setBuildSourceCursor(0);
    setBuildArchetypeIdx(0);
    setBuildMountIdx(0);
    setBuildErr(null);
    setBuildEstimate(null);
    setBuildResult(null);
    setBuildField((defaultCourse || currentCourse(snapshot)) ? 'topic' : 'course');
    setSubMode('build');
  }, [defaultCourse, snapshot]);

  const toggleSourceAtCursor = useCallback(() => {
    const grp = availableSourceGroups[buildSourceCursor];
    if (!grp) return;
    setBuildSourceIds((prev) => {
      const set = new Set(prev);
      const allSelected = grp.sourceIds.every((id) => set.has(id));
      if (allSelected) {
        for (const id of grp.sourceIds) set.delete(id);
      } else {
        for (const id of grp.sourceIds) set.add(id);
      }
      return [...set];
    });
  }, [availableSourceGroups, buildSourceCursor]);

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (subMode === 'attach') {
        if (attachBusy) return;
        if (key.ctrl && input === 's') {
          void submitAttach();
          return;
        }
        if (key.downArrow || key.upArrow || (key.ctrl && (input === 'n' || input === 'p'))) {
          setAttachField((f) => (f === 'path' ? 'course' : 'path'));
        }
        return;
      }

      if (subMode === 'catchup') {
        if (catchupBusy) return;
        if (key.ctrl && input === 's') {
          void submitCatchup();
          return;
        }
        if (key.downArrow || key.tab || (key.ctrl && input === 'n')) {
          setCatchupField((f) => (f === 'prompt' ? 'answer' : f === 'answer' ? 'misconception' : 'prompt'));
        } else if (key.upArrow || (key.ctrl && input === 'p')) {
          setCatchupField((f) => (f === 'prompt' ? 'misconception' : f === 'answer' ? 'prompt' : 'answer'));
        }
        return;
      }

      if (subMode === 'ask-view') {
        if (input === 'c' && askSuggestedCard && !askBusy && !catchupBusy) {
          void saveCatchupPayload({
            prompt: askSuggestedCard.prompt,
            answer: askSuggestedCard.answer || askAnswer,
            misconception: askSuggestedCard.misconception,
          });
        }
        return;
      }

      if (subMode === 'build') {
        if (buildBusy) return;
        if (buildResult) {
          if (input === 't' || key.return) {
            jumpToTasks(buildResult.jobId);
          } else if (input === 'n') {
            setBuildResult(null);
            setBuildEstimate(null);
            setBuildErr(null);
          }
          return;
        }
        if (buildEstimate) {
          if (input === 'y' || input === 'Y' || key.return) {
            void runBuildStart();
          } else if (input === 'e' || input === 'n' || input === 'N') {
            setBuildEstimate(null);
            setBuildErr(null);
          }
          return;
        }
        if (key.ctrl && input === 's') {
          void runBuildEstimate();
          return;
        }
        if (key.downArrow || key.tab || (key.ctrl && input === 'n')) {
          setBuildField((cur) => {
            const idx = BUILD_FIELD_ORDER.indexOf(cur);
            return BUILD_FIELD_ORDER[(idx + 1) % BUILD_FIELD_ORDER.length];
          });
          return;
        }
        if (key.upArrow || (key.ctrl && input === 'p')) {
          setBuildField((cur) => {
            const idx = BUILD_FIELD_ORDER.indexOf(cur);
            return BUILD_FIELD_ORDER[(idx - 1 + BUILD_FIELD_ORDER.length) % BUILD_FIELD_ORDER.length];
          });
          return;
        }
        if (buildField === 'sources') {
          if (key.leftArrow) {
            setBuildSourceCursor((c) => Math.max(0, c - 1));
          } else if (key.rightArrow) {
            setBuildSourceCursor((c) => Math.min(Math.max(0, availableSourceGroups.length - 1), c + 1));
          } else if (input === ' ') {
            toggleSourceAtCursor();
          } else if (input === 'a') {
            if (buildSourceIds.length > 0) {
              setBuildSourceIds([]);
            } else {
              const allIds = availableSourceGroups.slice(0, 4).flatMap((g) => g.sourceIds);
              setBuildSourceIds([...new Set(allIds)]);
            }
          } else if (key.return) {
            void runBuildEstimate();
          }
        } else if (buildField === 'archetype') {
          if (key.rightArrow || input === ' ') {
            setBuildArchetypeIdx((i) => (i + 1) % ARCHETYPES.length);
          } else if (key.leftArrow) {
            setBuildArchetypeIdx((i) => (i - 1 + ARCHETYPES.length) % ARCHETYPES.length);
          } else if (key.return) {
            void runBuildEstimate();
          }
        } else if (buildField === 'mountMode') {
          if (key.rightArrow || input === ' ') {
            setBuildMountIdx((i) => (i + 1) % MOUNT_MODES.length);
          } else if (key.leftArrow) {
            setBuildMountIdx((i) => (i - 1 + MOUNT_MODES.length) % MOUNT_MODES.length);
          } else if (key.return) {
            void runBuildEstimate();
          }
        }
        return;
      }

      if (subMode !== 'browse') return;

      if (key.tab) {
        setActivePane((p) => (p === 'left' ? 'right' : 'left'));
      } else if (key.rightArrow && activePane === 'left') {
        setActivePane('right');
      } else if (key.leftArrow && activePane === 'right') {
        setActivePane('left');
      } else if (input === 'b' && !actionBusy) {
        openBuildModal();
      } else if (input === 's' && selectedCompanion && !actionBusy) {
        void handleSyncDisk();
      } else if (input === 'f' && selectedCompanion && !actionBusy) {
        void handleFeedbackSync();
      } else if (input === 'i') {
        setAttachErr(null);
        setSubMode('attach');
      } else if (input === 'v' && defaultCourse) {
        setCourseFilterOn((v) => !v);
      } else if (input === 'a' && selectedCompanion) {
        abortInFlight();
        resetAskAnswer();
        setAskInput('');
        setAskSuggestedCard(null);
        setAskBusy(false);
        setSubMode('ask');
      } else if (input === 'c' && selectedCompanion) {
        setCatchupErr(null);
        setCatchupPrompt('');
        setCatchupAnswer('');
        setCatchupMisconception('');
        setCatchupField('prompt');
        setSubMode('catchup');
      } else if (input === 'o' && selectedCompanion) {
        void handleOpenExternal();
      }
    },
    { isActive },
  );

  const hints: KeyHint[] = useMemo(() => {
    const upDown = asciiMode ? 'Up/Dn' : '↑/↓';
    const leftRight = asciiMode ? '<-/->' : '←/→';
    if (subMode === 'attach') {
      return [
        { key: 'Tab', label: t(lang, '补全路径', 'Complete') },
        { key: upDown, label: t(lang, '切字段', 'Field') },
        { key: 'Enter', label: t(lang, '挂载', 'Attach') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (subMode === 'build') {
      if (buildResult) {
        return [
          { key: 't/Enter', label: t(lang, '任务监控', 'Tasks') },
          { key: 'n', label: t(lang, '再建一节', 'Another') },
          { key: 'Esc', label: t(lang, '返回', 'Back') },
        ];
      }
      if (buildEstimate) {
        return [
          { key: 'y/Enter', label: t(lang, '确认启动', 'Start') },
          { key: 'e/Esc', label: t(lang, '改参数', 'Edit') },
        ];
      }
      return [
        { key: `${upDown}/Tab`, label: t(lang, '切字段', 'Field') },
        { key: `Space/${leftRight}`, label: t(lang, '切换选项', 'Select') },
        { key: 'Enter', label: t(lang, '预估启动', 'Estimate') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (subMode === 'catchup') {
      return [
        { key: `${upDown}/Tab`, label: t(lang, '切字段', 'Field') },
        { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (subMode === 'ask') {
      return [
        { key: 'Enter', label: t(lang, '提问', 'Ask') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (subMode === 'ask-view') {
      return [
        { key: upDown, label: t(lang, '滚动', 'Scroll') },
        ...(askSuggestedCard ? [{ key: 'c', label: t(lang, '存拾遗卡', 'Save Catch-Up') }] : []),
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    return [
      { key: 'Tab', label: t(lang, '切窗', 'Pane') },
      { key: 'b', label: t(lang, '生成', 'Build') },
      { key: 's', label: t(lang, '同步', 'Sync') },
      { key: 'f', label: t(lang, '反馈', 'Feedback') },
      { key: 'a', label: t(lang, '提问', 'Ask') },
      { key: 'c', label: t(lang, '拾遗', 'Catch-up') },
      { key: 'i', label: t(lang, '挂载', 'Attach') },
      { key: 'o', label: t(lang, '打开', 'Open') },
      ...(defaultCourse ? [{ key: 'v', label: t(lang, '范围', 'Scope') }] : []),
    ];
  }, [asciiMode, askSuggestedCard, buildEstimate, buildResult, defaultCourse, lang, subMode]);

  const maxModalW = columns >= 132 ? 104 : columns >= 100 ? Math.max(54, columns - 28) : columns - 4;
  const frameWidth = Math.max(54, Math.min(maxModalW, columns - 4));
  const frameHeight = Math.max(16, Math.min(34, termRows - 2));
  const innerW = modalContentWidth(frameWidth);
  const innerH = Math.max(8, frameHeight - 5);
  const inputWidth = Math.max(20, innerW - 4);
  const noticeH = pathNotice ? 2 : 0;
  const headerH = 1;
  const splitH = Math.max(6, innerH - headerH - noticeH);

  const ell = asciiMode ? '...' : '…';
  const sep = asciiMode ? '-' : '·';
  const errMark = asciiMode ? 'x' : '✕';
  const okMark = asciiMode ? '+' : '✓';
  const promptGlyph = asciiMode ? '>' : '›';

  const courseCatchupDeckCount = useMemo(() => {
    const courseName = selectedCompanion?.course?.trim().toLowerCase() || '';
    let total = 0;
    for (const d of snapshot?.decks ?? []) {
      if (!d || d.archived) continue;
      const rawDeck = d as Record<string, unknown>;
      if (!isCatchupDeckMeta(rawDeck)) continue;
      const deckCourse = String(d.course || rawDeck.folder || '').trim().toLowerCase();
      if (!courseName || !deckCourse || deckCourse === courseName) {
        total += Number(rawDeck.total ?? d.cardCount ?? 0);
      }
    }
    return total;
  }, [selectedCompanion?.course, snapshot?.decks]);

  const activeFeedback =
    selectedCompanion && feedbackSummary?.companionId === selectedCompanion.id ? feedbackSummary : null;

  const detailMarkdown = useMemo(() => {
    if (!detail) return '';
    return buildCompanionMarkdown(detail, lang, {
      asciiMode,
      courseCatchupDeckCount,
      feedback: activeFeedback,
    });
  }, [activeFeedback, asciiMode, courseCatchupDeckCount, detail, lang]);

  const handleModalClose = useCallback(() => {
    if (subMode === 'browse') {
      abortInFlight();
      resetAskAnswer();
      setAskSuggestedCard(null);
      setAskBusy(false);
      onClose();
      return;
    }
    if (subMode === 'build' && buildEstimate && !buildResult) {
      setBuildEstimate(null);
      setBuildErr(null);
      return;
    }
    abortInFlight();
    resetAskAnswer();
    setAskSuggestedCard(null);
    setAskBusy(false);
    setSubMode('browse');
  }, [abortInFlight, buildEstimate, buildResult, onClose, resetAskAnswer, subMode]);

  const activeSourceGroup = availableSourceGroups[buildSourceCursor];
  const selectedSourceGroupsCount = availableSourceGroups.filter((g) =>
    g.sourceIds.every((id) => buildSourceIds.includes(id)),
  ).length;
  const isCurrentGroupSelected = Boolean(
    activeSourceGroup && activeSourceGroup.sourceIds.every((id) => buildSourceIds.includes(id)),
  );

  return (
    <Modal
      title={t(lang, '交互伴学页 (Companions)', 'Interactive Companions')}
      subtitle={
        courseFilterOn && defaultCourse
          ? `${defaultCourse} (${companions.length})`
          : `${t(lang, '全部课程', 'All')} (${companions.length})`
      }
      icon={asciiMode ? '*' : '✦'}
      width={frameWidth}
      height={frameHeight}
      isActive={isActive}
      onClose={handleModalClose}
      hints={hints}
    >
      {subMode === 'attach' ? (
        <Box flexDirection="column" height={innerH} width={innerW} paddingY={1}>
          <Text color={theme.primary} bold wrap="truncate-end">
            {truncateDisplay(
              t(lang, '挂载本地伴学 HTML / .lesson.json / 目录', 'Attach Local HTML / .lesson.json / Pack'),
              innerW,
              ell,
            )}
          </Text>
          <Box marginTop={1}>
            <Text color={attachField === 'path' ? theme.primary : theme.muted} bold={attachField === 'path'} wrap="truncate-end">
              {truncateDisplay(
                t(lang, '文件或目录路径 (支持 ~ 及 Tab 补全):', 'Path (~, /, \\ & Tab completion):'),
                innerW,
                ell,
              )}
            </Text>
          </Box>
          <TextInput
            value={attachPath}
            onChange={setAttachPath}
            onTab={handleAttachTabComplete}
            onSubmit={() => void submitAttach()}
            onCancel={() => setSubMode('browse')}
            placeholder={process.platform === 'win32' ? 'C:\\Users\\...\\lesson.html' : '~/companions/lesson.html'}
            width={inputWidth}
            isActive={isActive && !attachBusy && subMode === 'attach' && attachField === 'path'}
            prompt={promptGlyph}
          />
          {attachMatches.length > 0 && attachField === 'path' ? (
            <Box marginTop={0}>
              <Text color={theme.dim} wrap="truncate-end">
                {truncateDisplay(`${t(lang, 'Tab 候选:', 'Matches:')} ${attachMatches.join('  ')}`, innerW, ell)}
              </Text>
            </Box>
          ) : null}

          <Box marginTop={1}>
            <Text color={attachField === 'course' ? theme.primary : theme.muted} bold={attachField === 'course'}>
              {t(lang, '所属课程 (可选，留空自动识别):', 'Course (optional):')}
            </Text>
          </Box>
          <TextInput
            value={attachCourse}
            onChange={setAttachCourse}
            onSubmit={() => void submitAttach()}
            onCancel={() => setSubMode('browse')}
            placeholder={t(lang, '例如：操作系统', 'e.g. Operating Systems')}
            width={inputWidth}
            isActive={isActive && !attachBusy && subMode === 'attach' && attachField === 'course'}
            prompt={promptGlyph}
          />

          {attachBusy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在挂载伴学页${ell}`, `Attaching companion${ell}`)} />
            </Box>
          ) : null}
          {attachErr ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">
                {`${errMark} ${attachErr}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : subMode === 'build' ? (
        <Box flexDirection="column" height={innerH} width={innerW} overflow="hidden">
          <Box height={1} flexDirection="row" alignItems="center" width={innerW}>
            <Badge label={t(lang, '4 阶段构建', '4-Stage Build')} tone="ai" />
            <Text> </Text>
            <Text color={theme.primary} bold wrap="truncate-end">
              {truncateDisplay(
                t(lang, '生成交互式 HTML 伴学课', 'Build Interactive Companion Lesson'),
                Math.max(12, innerW - 18),
                ell,
              )}
            </Text>
          </Box>

          {buildResult ? (
            <Box
              marginTop={1}
              flexDirection="column"
              borderStyle={asciiMode ? 'classic' : 'round'}
              borderColor={theme.success}
              paddingX={1}
              width={innerW}
            >
              <Box flexDirection="row" alignItems="center">
                <Badge label={`${okMark} ${t(lang, '已启动', 'Started')}`} tone="success" variant="solid" />
                <Text> </Text>
                <Text color={theme.text} bold wrap="truncate-end">
                  {truncateDisplay(`Job: ${buildResult.jobId || '-'}`, Math.max(12, innerW - 18), ell)}
                </Text>
              </Box>
              <Box marginTop={1}>
                <Text color={theme.muted} wrap="truncate-end">
                  {truncateDisplay(
                    `${buildResult.steps} ${t(lang, '阶段', 'stages')} ${sep} ${buildResult.grounded ? t(lang, '锚定讲义原文', 'Grounded in sources') : t(lang, '自由命题推演', 'Free-topic mode')} ${sep} ${buildResult.status}`,
                    Math.max(16, innerW - 4),
                    ell,
                  )}
                </Text>
              </Box>
              <Box marginTop={1} flexDirection="row" flexWrap="wrap">
                <Text color={theme.accent} bold>
                  {t(lang, '[t / Enter] 前往后台任务查看进度', '[t / Enter] Open Tasks View')}
                </Text>
                <Text color={theme.dim}>   </Text>
                <Text color={theme.muted}>{t(lang, '[n] 再生成一节', '[n] Build another')}</Text>
              </Box>
            </Box>
          ) : buildEstimate ? (
            <Box
              marginTop={1}
              flexDirection="column"
              borderStyle={asciiMode ? 'classic' : 'round'}
              borderColor={theme.primary}
              paddingX={1}
              width={innerW}
            >
              <Box flexDirection="row" alignItems="center" width={Math.max(12, innerW - 4)}>
                <Badge label={t(lang, '用量预估', 'Estimate')} tone="info" variant="soft" />
                <Text> </Text>
                <Text color={theme.text} bold wrap="truncate-end">
                  {truncateDisplay(
                    `${buildCourse.trim()} ${sep} ${buildTopic.trim() || t(lang, '基于所选资料', 'From selected sources')}`,
                    Math.max(14, innerW - 18),
                    ell,
                  )}
                </Text>
              </Box>
              <Box marginTop={1}>
                <Text color={theme.muted} wrap="truncate-end">
                  {truncateDisplay(
                    `${t(lang, '阶段', 'Steps')}: ${buildEstimate.steps} ${sep} ${t(lang, '调用', 'Calls')}: ~${buildEstimate.callsText} ${sep} Tokens: ~${buildEstimate.tokensText}`,
                    Math.max(16, innerW - 4),
                    ell,
                  )}
                </Text>
              </Box>
              <Box>
                <Text color={theme.dim} wrap="truncate-end">
                  {truncateDisplay(
                    `${t(lang, '模式', 'Mode')}: ${buildEstimate.grounded ? t(lang, '讲义锚定', 'Grounded') : t(lang, '自由推演', 'Free-topic')} ${sep} ${archetypeLabel(ARCHETYPES[buildArchetypeIdx], lang)} ${sep} ${mountModeLabel(MOUNT_MODES[buildMountIdx], lang)}`,
                    Math.max(16, innerW - 4),
                    ell,
                  )}
                </Text>
              </Box>
              {buildBusy ? (
                <Box marginTop={1}>
                  <Spinner label={t(lang, `正在提交后台生成任务${ell}`, `Launching build job${ell}`)} />
                </Box>
              ) : buildErr ? (
                <Box marginTop={1}>
                  <Text color={theme.error} wrap="wrap">
                    {`${errMark} ${buildErr}`}
                  </Text>
                </Box>
              ) : (
                <Box marginTop={1} flexDirection="row">
                  <Text color={theme.success} bold>
                    {t(lang, '[y / Enter] 确认启动后台任务', '[y / Enter] Confirm & Start Build')}
                  </Text>
                  <Box flexGrow={1} />
                  <Text color={theme.dim}>{t(lang, '[e / Esc] 修改', '[e / Esc] Edit')}</Text>
                </Box>
              )}
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1} width={innerW}>
              <Text color={buildField === 'course' ? theme.primary : theme.muted} bold={buildField === 'course'}>
                {t(lang, '1. 所属课程 (必填):', '1. Course (required):')}
              </Text>
              <TextInput
                value={buildCourse}
                onChange={setBuildCourse}
                onSubmit={() => void runBuildEstimate()}
                onCancel={() => setSubMode('browse')}
                placeholder={t(lang, '例如：操作系统 / 数学分析', 'e.g. Operating Systems')}
                width={inputWidth}
                isActive={isActive && !buildBusy && subMode === 'build' && buildField === 'course'}
                prompt={promptGlyph}
              />

              <Text color={buildField === 'topic' ? theme.primary : theme.muted} bold={buildField === 'topic'}>
                {t(lang, '2. 核心主题或困惑 (无资料时必填):', '2. Topic / Question (required if no sources):')}
              </Text>
              <TextInput
                value={buildTopic}
                onChange={setBuildTopic}
                onSubmit={() => void runBuildEstimate()}
                onCancel={() => setSubMode('browse')}
                placeholder={t(lang, '例如：为什么无锁 CAS 会触发 ABA 问题？', 'e.g. Why CAS triggers ABA without version tags?')}
                width={inputWidth}
                isActive={isActive && !buildBusy && subMode === 'build' && buildField === 'topic'}
                prompt={promptGlyph}
              />

              <Box marginTop={1} flexDirection="row" width={innerW}>
                <Text color={buildField === 'sources' ? theme.primary : theme.muted} bold={buildField === 'sources'} wrap="truncate-end">
                  {truncateDisplay(
                    `${t(lang, '3. 参考资料', '3. Sources')} (${selectedSourceGroupsCount}/${availableSourceGroups.length}): ${
                      availableSourceGroups.length === 0
                        ? t(lang, '暂无可用资料 (自由出题)', 'None (free-topic)')
                        : `[${isCurrentGroupSelected ? (asciiMode ? 'x' : '✓') : ' '}] ${activeSourceGroup?.title || ''} (${buildSourceCursor + 1}/${availableSourceGroups.length})`
                    }`,
                    innerW,
                    ell,
                  )}
                </Text>
              </Box>
              <Box flexDirection="row" width={innerW}>
                <Text color={buildField === 'archetype' ? theme.primary : theme.muted} bold={buildField === 'archetype'} wrap="truncate-end">
                  {truncateDisplay(
                    `4. ${t(lang, '交互母版', 'Archetype')}: < ${archetypeLabel(ARCHETYPES[buildArchetypeIdx], lang)} >`,
                    innerW,
                    ell,
                  )}
                </Text>
              </Box>
              <Box flexDirection="row" width={innerW}>
                <Text color={buildField === 'mountMode' ? theme.primary : theme.muted} bold={buildField === 'mountMode'} wrap="truncate-end">
                  {truncateDisplay(
                    `5. ${t(lang, '题库联动', 'Mount')}: < ${mountModeLabel(MOUNT_MODES[buildMountIdx], lang)} >`,
                    innerW,
                    ell,
                  )}
                </Text>
              </Box>

              {buildBusy ? (
                <Box marginTop={1}>
                  <Spinner label={t(lang, `正在计算用量预估${ell}`, `Calculating build estimate${ell}`)} />
                </Box>
              ) : buildErr ? (
                <Box marginTop={1}>
                  <Text color={theme.error} wrap="wrap">
                    {`${errMark} ${buildErr}`}
                  </Text>
                </Box>
              ) : (
                <Box marginTop={1}>
                  <Text color={theme.dim} wrap="truncate-end">
                    {truncateDisplay(
                      t(
                        lang,
                        '按 [Enter] 预览预估并确认启动，[Space] 勾选资料/切选项',
                        'Press [Enter] for estimate & launch; [Space] toggles source/option',
                      ),
                      innerW,
                      ell,
                    )}
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      ) : subMode === 'catchup' ? (
        <Box flexDirection="column" height={innerH} width={innerW} paddingY={1} overflow="hidden">
          <Text color={theme.primary} bold wrap="truncate-end">
            {truncateDisplay(
              t(
                lang,
                `添加伴学拾遗卡：${selectedCompanion?.title || ''}`,
                `Save Catch-Up Card: ${selectedCompanion?.title || ''}`,
              ),
              innerW,
              ell,
            )}
          </Text>
          <Box marginTop={1}>
            <Text color={catchupField === 'prompt' ? theme.primary : theme.muted} bold={catchupField === 'prompt'}>
              {t(lang, '1. 易混问题 (必填):', '1. Prompt (required):')}
            </Text>
          </Box>
          <TextInput
            value={catchupPrompt}
            onChange={setCatchupPrompt}
            onSubmit={() => void submitCatchup()}
            onCancel={() => setSubMode('browse')}
            placeholder={t(lang, '例：为什么逐点收敛不能交换极限与积分？', 'e.g. Why pointwise convergence fails limit-integral swap?')}
            width={inputWidth}
            isActive={isActive && !catchupBusy && subMode === 'catchup' && catchupField === 'prompt'}
            prompt={promptGlyph}
          />
          <Box marginTop={1}>
            <Text color={catchupField === 'answer' ? theme.primary : theme.muted} bold={catchupField === 'answer'}>
              {t(lang, '2. 关键解答 (必填):', '2. Answer (required):')}
            </Text>
          </Box>
          <TextInput
            value={catchupAnswer}
            onChange={setCatchupAnswer}
            onSubmit={() => void submitCatchup()}
            onCancel={() => setSubMode('browse')}
            placeholder={t(lang, '清晰点破适用条件与反例边界…', 'State exact mechanism and boundary condition...')}
            width={inputWidth}
            isActive={isActive && !catchupBusy && subMode === 'catchup' && catchupField === 'answer'}
            prompt={promptGlyph}
          />
          <Box marginTop={1}>
            <Text color={catchupField === 'misconception' ? theme.primary : theme.muted} bold={catchupField === 'misconception'}>
              {t(lang, '3. 易错点 / 误区 (可选):', '3. Misconception (optional):')}
            </Text>
          </Box>
          <TextInput
            value={catchupMisconception}
            onChange={setCatchupMisconception}
            onSubmit={() => void submitCatchup()}
            onCancel={() => setSubMode('browse')}
            placeholder={t(lang, '记录当时混淆的直觉误区…', 'Misconception encountered during study...')}
            width={inputWidth}
            isActive={isActive && !catchupBusy && subMode === 'catchup' && catchupField === 'misconception'}
            prompt={promptGlyph}
          />
          {catchupBusy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在保存拾遗闪卡${ell}`, `Saving catch-up card${ell}`)} />
            </Box>
          ) : catchupErr ? (
            <Box marginTop={1}>
              <Text color={theme.error} wrap="wrap">
                {`${errMark} ${catchupErr}`}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : subMode === 'ask' ? (
        <Box flexDirection="column" height={innerH} width={innerW} paddingY={1}>
          <Text color={theme.primary} bold wrap="truncate-end">
            {truncateDisplay(
              t(lang, `向伴学导师提问：${selectedCompanion?.title || ''}`, `Ask about: ${selectedCompanion?.title || ''}`),
              innerW,
              ell,
            )}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={askInput}
              onChange={setAskInput}
              onSubmit={(val) => void runAsk(val)}
              onCancel={() => setSubMode('browse')}
              placeholder={t(lang, `输入你在该伴学页上卡壳的概念或公式${ell}`, `Ask about any concept, slide or formula${ell}`)}
              width={inputWidth}
              isActive={isActive && subMode === 'ask'}
              prompt={promptGlyph}
            />
          </Box>
        </Box>
      ) : subMode === 'ask-view' ? (
        <Box flexDirection="column" height={innerH} width={innerW}>
          <Box height={1} flexDirection="row">
            <Badge label={t(lang, 'AI 伴学解答', 'Companion AI')} tone="ai" />
            <Text> </Text>
            <Text color={theme.muted} wrap="truncate-end">
              {truncateDisplay(askInput, Math.max(12, innerW - 18), ell)}
            </Text>
            <Box flexGrow={1} />
            {askBusy || catchupBusy ? <Spinner label={t(lang, '处理中', 'Working')} /> : null}
          </Box>
          <Box height={Math.max(4, innerH - 1)} width={innerW}>
            <MarkdownView
              markdown={askAnswer || (askBusy ? t(lang, `正在生成讲解${ell}`, `Generating explanation${ell}`) : '')}
              width={innerW}
              height={Math.max(4, innerH - 1)}
              isActive={isActive && subMode === 'ask-view'}
              follow={askBusy}
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" height={innerH} width={innerW}>
          <Box height={headerH} flexDirection="row" alignItems="center" width={innerW}>
            <Badge
              label={
                courseFilterOn && defaultCourse
                  ? truncateDisplay(defaultCourse, 22, ell)
                  : t(lang, '全部课程', 'All Courses')
              }
              tone={courseFilterOn && defaultCourse ? 'accent' : 'muted'}
              variant="outline"
            />
            {selectedCompanion && (detail?.catchupCount || courseCatchupDeckCount > 0) ? (
              <>
                <Text> </Text>
                <Badge
                  label={`${t(lang, '拾遗', 'Catch-up')} ${detail?.catchupCount ?? 0}${courseCatchupDeckCount > 0 ? `/${courseCatchupDeckCount}` : ''}`}
                  tone="info"
                  variant="soft"
                />
              </>
            ) : null}
            {activeFeedback ? (
              <>
                <Text> </Text>
                <Badge
                  label={`${t(lang, '反馈', 'FB')} ${activeFeedback.open}/${activeFeedback.total}`}
                  tone={activeFeedback.open > 0 ? 'warning' : 'success'}
                  variant="soft"
                />
              </>
            ) : null}
            {actionBusy ? (
              <>
                <Text> </Text>
                <Spinner label={t(lang, '同步中', 'Syncing')} />
              </>
            ) : null}
            <Box flexGrow={1} />
            <Box flexShrink={0}>
              <Text color={theme.dim}>
                {activePane === 'left'
                  ? t(lang, `列表 ${sep} Tab切详情`, `List ${sep} Tab=Detail`)
                  : t(lang, `详情 ${sep} Tab切列表`, `Detail ${sep} Tab=List`)}
              </Text>
            </Box>
          </Box>

          {pathNotice ? (
            <Box height={noticeH} flexDirection="column" width={innerW}>
              <Text color={theme.warning} wrap="truncate-end">
                {t(lang, 'HTML 路径（请在浏览器中打开）:', 'HTML Path (open in browser):')}
              </Text>
              <Text color={theme.text} wrap="truncate-end">
                {truncateDisplay(pathNotice, innerW, ell)}
              </Text>
            </Box>
          ) : null}

          <Box height={splitH} width={innerW}>
            <SplitPane
              width={innerW}
              height={splitH}
              leftWidth={0.38}
              minLeft={20}
              minRight={28}
              activePane={activePane}
              leftLabel={t(lang, '伴学列表', 'Companions')}
              rightLabel={t(lang, '课程详情', 'Details')}
              left={({ width: lw, height: lh }) => (
                <Panel
                  title={t(lang, '伴学页', 'Companions')}
                  badge={companions.length}
                  width={lw}
                  height={lh}
                  focused={activePane === 'left'}
                >
                  {listLoading ? (
                    <Spinner label={t(lang, `加载中${ell}`, `Loading${ell}`)} />
                  ) : listErr ? (
                    <Text color={theme.error} wrap="wrap">
                      {`${errMark} ${listErr}`}
                    </Text>
                  ) : companions.length === 0 ? (
                    <EmptyState
                      title={t(lang, '暂无交互伴学页', 'No companions yet')}
                      hint={t(lang, '按 [b] AI 生成或 [i] 挂载本地 HTML', 'Press [b] to build or [i] to attach')}
                      width={Math.max(12, lw - 4)}
                      height={Math.max(4, lh - 2)}
                    />
                  ) : (
                    <VirtualList
                      items={companions}
                      height={Math.max(1, lh - 2)}
                      width={Math.max(12, lw - 4)}
                      selectedIndex={selectedIndex}
                      onChange={(idx) => setSelectedIndex(idx)}
                      onSelect={() => setActivePane('right')}
                      isActive={isActive && subMode === 'browse' && activePane === 'left'}
                      keyExtractor={(item) => item.id}
                      renderItem={(item, ctx) => {
                        const slidesTag = item.slideCount ? `${item.slideCount}p` : '';
                        const doneTag = item.progress?.completed ? `${okMark} ` : '';
                        const modeTag = item.lessonMode === 'rescue' ? t(lang, '实验 ', 'Lab ') : '';
                        const maxTitle = Math.max(8, ctx.width - slidesTag.length - modeTag.length - doneTag.length - 4);
                        return (
                          <Box flexDirection="row" width={ctx.width}>
                            <Text color={ctx.selected ? theme.primary : theme.muted}>
                              {ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}
                            </Text>
                            {doneTag ? <Text color={theme.success}>{doneTag}</Text> : null}
                            {modeTag ? <Text color={theme.warning}>{modeTag}</Text> : null}
                            <Text color={theme.text} bold={ctx.selected}>
                              {truncateDisplay(item.title || item.id, maxTitle, ell)}
                            </Text>
                            <Box flexGrow={1} />
                            {slidesTag ? <Text color={theme.dim}>{slidesTag}</Text> : null}
                          </Box>
                        );
                      }}
                    />
                  )}
                </Panel>
              )}
              right={({ width: rw, height: rh }) => (
                <Panel
                  title={selectedCompanion ? selectedCompanion.title : t(lang, '伴学详情', 'Details')}
                  subtitle={selectedCompanion?.course}
                  width={rw}
                  height={rh}
                  focused={activePane === 'right'}
                >
                  {!selectedCompanion ? (
                    <EmptyState
                      title={t(lang, '选择一份伴学页查看详情', 'Select a companion')}
                      width={Math.max(12, rw - 4)}
                      height={Math.max(4, rh - 2)}
                    />
                  ) : detailLoading ? (
                    <Spinner label={t(lang, `读取伴学结构${ell}`, `Loading companion${ell}`)} />
                  ) : detailErr ? (
                    <Text color={theme.error} wrap="wrap">
                      {`${errMark} ${detailErr}`}
                    </Text>
                  ) : (
                    <MarkdownView
                      markdown={detailMarkdown}
                      width={Math.max(12, rw - 4)}
                      height={Math.max(3, rh - 2)}
                      isActive={isActive && subMode === 'browse' && activePane === 'right'}
                    />
                  )}
                </Panel>
              )}
            />
          </Box>
        </Box>
      )}
    </Modal>
  );
});
