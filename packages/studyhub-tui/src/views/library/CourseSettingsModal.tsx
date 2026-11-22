import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  Divider,
  EmptyState,
  Modal,
  SelectList,
  Spinner,
  StatusPill,
  TextInput,
  VirtualList,
  modalContentWidth,
  useTheme,
  type SelectOption,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/index.js';
import { listCourses, useShellActions } from '../../shell/index.js';
import { tryAction } from '../../host/index.js';

export interface CourseMethodStage {
  name: string;
  activity: 'publish' | 'practice' | 'review' | 'explain' | 'check' | 'project' | string;
  alternatives?: string[];
  level: 'loose' | 'medium' | 'strict' | string;
}

export interface CourseMethodData {
  version?: number;
  name: string;
  targetDate?: string | null;
  stageIndex?: number;
  skippedStages?: number[];
  selfReportedStages?: number[];
  stages: CourseMethodStage[];
}

export interface CourseMethodResponse {
  course: string;
  courseId?: string;
  own: boolean;
  method: CourseMethodData;
  progress?: {
    index: number;
    total: number;
    counts?: { materials?: number; cards?: number; answered?: number; right?: number };
  };
  gate?: {
    level?: string;
    counts?: 'answered' | 'right' | string;
    total: number;
    passed: number;
    selfReported?: number;
    checkPassed: boolean;
    ready: boolean;
    toReady: number;
    last: boolean;
    status: string;
    stages?: Array<{ index: number; total: number; passed: number; status: string }>;
  };
}

export interface CourseDetailResponse {
  id: string;
  name: string;
  aliases?: string[];
  decks?: number;
  drafts?: number;
  sources?: number;
  focusTopics?: string[];
  exam?: {
    format?: string;
    date?: string;
    sections?: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
  plan?: {
    notes?: string;
    [k: string]: unknown;
  };
}

export interface CourseTermItem {
  term: string;
  alt?: string;
  at?: string;
  from?: { deckId: string; cardId: string };
  card?: { deckId: string; cardId: string };
  state: 'known' | 'learned' | 'unknown' | string;
  fromPrompt?: string;
}

export interface CourseTermsResponse {
  course: string;
  items: CourseTermItem[];
}

export interface CourseSettingsModalProps {
  host: HostClient;
  course: string | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onUpdated?: () => void;
}

type SettingsTab = 'method' | 'info' | 'terms';
type SubMode = 'none' | 'pickCourse' | 'presets' | 'editNote' | 'editTargetDate' | 'rename' | 'confirmRename' | 'editExamDate' | 'searchTerms';

const TABS: readonly SettingsTab[] = ['method', 'info', 'terms'];

interface MethodPreset {
  id: string;
  labelZh: string;
  labelEn: string;
  hintZh: string;
  hintEn: string;
  build: (targetDate: string | null) => CourseMethodData | null;
}

const METHOD_PRESETS: readonly MethodPreset[] = [
  {
    id: 'default',
    labelZh: '课堂跟学 (默认)',
    labelEn: 'Classroom Follow-along (Default)',
    hintZh: '导入资料 -> 出题按批练 -> 到期复习',
    hintEn: 'Publish -> Practice in batches -> Review due',
    build: () => null,
  },
  {
    id: 'sprint',
    labelZh: '考前冲刺 (高频刷题)',
    labelEn: 'Exam Sprint (Intensive)',
    hintZh: '梳理考点 -> 严格刷题 -> 考前模拟复盘',
    hintEn: 'Focus points -> Strict practice -> Review',
    build: (targetDate) => ({
      version: 1,
      name: '考前冲刺',
      targetDate,
      stages: [
        { name: '梳理考点资料', activity: 'publish', alternatives: ['explain'], level: 'loose' },
        { name: '高频刷题巩固', activity: 'practice', alternatives: ['check'], level: 'strict' },
        { name: '考前模拟复盘', activity: 'review', alternatives: ['check'], level: 'strict' },
      ],
    }),
  },
  {
    id: 'feynman',
    labelZh: '深度理解 (费曼精学)',
    labelEn: 'Deep Mastery (Feynman)',
    hintZh: '资料精读 -> 概念复述 -> 练习检验 -> 复习',
    hintEn: 'Read -> Explain -> Practice -> Review',
    build: (targetDate) => ({
      version: 1,
      name: '深度理解',
      targetDate,
      stages: [
        { name: '资料精读拆解', activity: 'publish', alternatives: ['explain'], level: 'loose' },
        { name: '概念复述讲解', activity: 'explain', alternatives: ['practice'], level: 'medium' },
        { name: '综合练习检验', activity: 'practice', alternatives: ['check'], level: 'medium' },
        { name: '查漏间隔复习', activity: 'review', alternatives: ['check'], level: 'strict' },
      ],
    }),
  },
  {
    id: 'balanced',
    labelZh: '均衡稳步 (循序渐进)',
    labelEn: 'Steady Balanced',
    hintZh: '导入资料 -> 分批练习 -> 定期间隔复习',
    hintEn: 'Publish -> Steady practice -> Spaced review',
    build: (targetDate) => ({
      version: 1,
      name: '均衡稳步',
      targetDate,
      stages: [
        { name: '导入课程资料', activity: 'publish', alternatives: ['explain'], level: 'loose' },
        { name: '分批练习巩固', activity: 'practice', alternatives: ['explain', 'check'], level: 'medium' },
        { name: '定期间隔复习', activity: 'review', alternatives: ['check'], level: 'medium' },
      ],
    }),
  },
];

function activityLabel(activity: string, lang: 'zh' | 'en'): string {
  switch (activity) {
    case 'publish':
      return t(lang, '导入资料', 'Publish');
    case 'practice':
      return t(lang, '刷题练习', 'Practice');
    case 'review':
      return t(lang, '到期复习', 'Review');
    case 'explain':
      return t(lang, '讲解复述', 'Explain');
    case 'check':
      return t(lang, '过关检测', 'Check');
    case 'project':
      return t(lang, '综合实操', 'Project');
    default:
      return activity;
  }
}

function levelLabel(level: string, lang: 'zh' | 'en'): string {
  switch (level) {
    case 'loose':
      return t(lang, '宽松', 'Loose');
    case 'strict':
      return t(lang, '严格', 'Strict');
    default:
      return t(lang, '适中', 'Medium');
  }
}

function termStateBadge(state: string, lang: 'zh' | 'en'): { label: string; tone: 'success' | 'info' | 'warning' } {
  if (state === 'known') return { label: t(lang, '已掌握', 'Known'), tone: 'success' };
  if (state === 'learned') return { label: t(lang, '学习中', 'Learning'), tone: 'info' };
  return { label: t(lang, '待巩固', 'Unknown'), tone: 'warning' };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const CourseSettingsModal = memo(function CourseSettingsModal({
  host,
  course: initialCourse,
  isActive,
  width,
  height,
  onClose,
  onUpdated,
}: CourseSettingsModalProps) {
  const theme = useTheme();
  const actions = useShellActions();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);

  const availableCourses = useMemo(() => listCourses(snapshot), [snapshot]);
  const [selectedCourse, setSelectedCourse] = useState<string | null>(
    () => initialCourse || availableCourses[0]?.key || null,
  );
  const [tab, setTab] = useState<SettingsTab>('method');
  const [subMode, setSubMode] = useState<SubMode>(() => (initialCourse ? 'none' : availableCourses.length > 0 ? 'pickCourse' : 'none'));

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [methodData, setMethodData] = useState<CourseMethodResponse | null>(null);
  const [courseDetail, setCourseDetail] = useState<CourseDetailResponse | null>(null);
  const [termsData, setTermsData] = useState<CourseTermsResponse | null>(null);

  const [stageIndex, setStageIndex] = useState(0);
  const [termIndex, setTermIndex] = useState(0);
  const [termFilter, setTermFilter] = useState('');

  const [noteInput, setNoteInput] = useState('');
  const [dateInput, setDateInput] = useState('');
  const [renameInput, setRenameInput] = useState('');
  const [pendingRename, setPendingRename] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolvedCourseId = useMemo(() => {
    if (courseDetail?.id) return courseDetail.id;
    if (methodData?.courseId) return methodData.courseId;
    if (!selectedCourse) return undefined;
    const hit = (snapshot?.courses ?? []).find((c) => c.name === selectedCourse || c.title === selectedCourse);
    return typeof hit?.id === 'string' ? hit.id : undefined;
  }, [courseDetail?.id, methodData?.courseId, selectedCourse, snapshot?.courses]);

  // Load course method, course detail, and course terms for the active course (cancel-guarded)
  useEffect(() => {
    if (!selectedCourse) {
      setMethodData(null);
      setCourseDetail(null);
      setTermsData(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      const [mRes, cRes, tRes] = await Promise.all([
        tryAction<CourseMethodResponse>(host, 'course.method.get', { course: selectedCourse }),
        tryAction<CourseDetailResponse>(host, 'course.get', { name: selectedCourse }),
        tryAction<CourseTermsResponse>(host, 'course.terms.get', { course: selectedCourse }),
      ]);
      if (!alive) return;
      if (mRes.ok && mRes.value) setMethodData(mRes.value);
      else setMethodData(null);

      if (cRes.ok && cRes.value) {
        setCourseDetail(cRes.value);
        setRenameInput(cRes.value.name || selectedCourse);
      } else {
        setCourseDetail(null);
        setRenameInput(selectedCourse);
      }

      if (tRes.ok && tRes.value) setTermsData(tRes.value);
      else setTermsData({ course: selectedCourse, items: [] });

      if (!mRes.ok && !cRes.ok && !tRes.ok) {
        setError(mRes.error?.message || cRes.error?.message || t(lang, '加载课程设置失败', 'Failed to load course settings'));
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [host, selectedCourse, lang]);

  const stages = useMemo(() => methodData?.method?.stages ?? [], [methodData?.method?.stages]);
  const filteredTerms = useMemo(() => {
    const items = termsData?.items ?? [];
    const q = termFilter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.term.toLowerCase().includes(q) ||
        (item.alt ? item.alt.toLowerCase().includes(q) : false) ||
        (item.fromPrompt ? item.fromPrompt.toLowerCase().includes(q) : false),
    );
  }, [termsData?.items, termFilter]);

  useEffect(() => {
    if (stageIndex >= stages.length) setStageIndex(Math.max(0, stages.length - 1));
  }, [stages.length, stageIndex]);

  useEffect(() => {
    if (termIndex >= filteredTerms.length) setTermIndex(Math.max(0, filteredTerms.length - 1));
  }, [filteredTerms.length, termIndex]);

  const saveMethod = useCallback(
    async (nextMethod: CourseMethodData | null, successMsg: string) => {
      if (!selectedCourse || busy) return;
      setBusy(true);
      setError('');
      const res = await tryAction<CourseMethodResponse>(host, 'course.method.save', {
        ...(resolvedCourseId ? { id: resolvedCourseId } : {}),
        course: selectedCourse,
        method: nextMethod,
      });
      if (!mountedRef.current) return;
      setBusy(false);
      if (!res.ok || !res.value) {
        const msg = res.error?.message || t(lang, '保存学习方式失败', 'Failed to save learning method');
        setError(msg);
        notify(msg, 'error');
        return;
      }
      setMethodData(res.value);
      setSubMode('none');
      onUpdated?.();
      void actions.refresh();
      notify(successMsg, 'success');
    },
    [selectedCourse, busy, host, resolvedCourseId, lang, notify, onUpdated, actions],
  );

  const handleJumpStage = useCallback(
    async (idx: number) => {
      if (!selectedCourse || !methodData?.own || busy || stages.length <= 1) return;
      setBusy(true);
      const res = await tryAction<CourseMethodResponse>(host, 'course.method.save', {
        ...(resolvedCourseId ? { id: resolvedCourseId } : {}),
        course: selectedCourse,
        stageIndex: idx,
      });
      if (!mountedRef.current) return;
      setBusy(false);
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '切换阶段失败', 'Failed to switch stage'), 'error');
        return;
      }
      setMethodData(res.value);
      onUpdated?.();
      notify(t(lang, `已切换到阶段：${stages[idx]?.name ?? idx + 1}`, `Switched to stage: ${stages[idx]?.name ?? idx + 1}`), 'success');
    },
    [selectedCourse, methodData?.own, busy, stages, host, resolvedCourseId, notify, lang, onUpdated],
  );

  const handleRenameConfirmed = useCallback(async () => {
    const nextName = pendingRename.trim();
    const targetId = resolvedCourseId;
    if (!nextName || !targetId || busy) {
      setSubMode('none');
      return;
    }
    setBusy(true);
    setError('');
    const res = await tryAction<{ course?: CourseDetailResponse }>(host, 'course.rename', {
      id: targetId,
      name: nextName,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    setSubMode('none');
    if (!res.ok) {
      const msg = res.error?.message || t(lang, '课程重命名失败', 'Failed to rename course');
      setError(msg);
      notify(msg, 'error');
      return;
    }
    const finalName = res.value?.course?.name || nextName;
    setSelectedCourse(finalName);
    if (res.value?.course) setCourseDetail(res.value.course);
    setRenameInput(finalName);
    await actions.refresh();
    onUpdated?.();
    notify(t(lang, `已将课程重命名为「${finalName}」`, `Renamed course to "${finalName}"`), 'success');
  }, [pendingRename, resolvedCourseId, busy, host, lang, notify, actions, onUpdated]);

  const handleSaveExamDate = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed && !isValidIsoDate(trimmed)) {
        notify(t(lang, '日期格式需为 YYYY-MM-DD（留空可清除）', 'Date must be YYYY-MM-DD (or empty to clear)'), 'warning');
        return;
      }
      if (!selectedCourse || busy) {
        setSubMode('none');
        return;
      }
      setBusy(true);
      const prevExam = courseDetail?.exam;
      const nextExam = trimmed
        ? { format: prevExam?.format || 'other', sections: prevExam?.sections || [], ...prevExam, date: trimmed }
        : { format: prevExam?.format || 'other', sections: prevExam?.sections || [] };
      const res = await tryAction<CourseDetailResponse>(host, 'course.save', {
        ...(resolvedCourseId ? { id: resolvedCourseId } : {}),
        name: selectedCourse,
        exam: nextExam,
      });
      if (!mountedRef.current) return;
      setBusy(false);
      setSubMode('none');
      if (!res.ok || !res.value) {
        notify(res.error?.message || t(lang, '保存考试日期失败', 'Failed to save exam date'), 'error');
        return;
      }
      setCourseDetail(res.value);
      await actions.refresh();
      onUpdated?.();
      notify(
        trimmed
          ? t(lang, `已设置考试日期：${trimmed}`, `Exam date set to ${trimmed}`)
          : t(lang, '已清除考试日期', 'Exam date cleared'),
        'success',
      );
    },
    [selectedCourse, busy, courseDetail?.exam, host, resolvedCourseId, actions, onUpdated, notify, lang],
  );

  useInput(
    (input, key) => {
      if (loading || busy || subMode !== 'none') return;
      if (key.tab) {
        setTab((prev) => TABS[(TABS.indexOf(prev) + (key.shift ? TABS.length - 1 : 1)) % TABS.length]);
        return;
      }
      if (input === '1') {
        setTab('method');
        return;
      }
      if (input === '2') {
        setTab('info');
        return;
      }
      if (input === '3') {
        setTab('terms');
        return;
      }
      if (input === 'c' && availableCourses.length > 0) {
        setSubMode('pickCourse');
        return;
      }
      if (!selectedCourse) return;

      if (tab === 'method') {
        if (input === 'm') {
          setSubMode('presets');
        } else if (input === 'e') {
          setNoteInput(methodData?.method?.name || '');
          setSubMode('editNote');
        } else if (input === 't') {
          setDateInput(methodData?.method?.targetDate || '');
          setSubMode('editTargetDate');
        } else if (input === 'r') {
          void saveMethod(null, t(lang, '已恢复默认「课堂跟学」', 'Reset to default method'));
        }
        return;
      }

      if (tab === 'info') {
        if (input === 'n' || key.return) {
          setRenameInput(courseDetail?.name || selectedCourse);
          setSubMode('rename');
        } else if (input === 'd') {
          setDateInput(courseDetail?.exam?.date || '');
          setSubMode('editExamDate');
        }
        return;
      }

      if (tab === 'terms') {
        if (input === '/' || input === 'f') {
          setSubMode('searchTerms');
        } else if (input === 'x' && termFilter) {
          setTermFilter('');
        }
      }
    },
    { isActive: isActive && !loading && !busy && subMode === 'none' },
  );

  const frameW = Math.max(48, Math.min(98, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(9, frameH - 5);
  const tabBodyH = Math.max(6, bodyH - 2);

  const courseOptions = useMemo<SelectOption<string>[]>(
    () =>
      availableCourses.map((c) => ({
        value: c.key,
        label: c.label,
        hint: c.deckCount ? t(lang, `${c.deckCount} 个题组`, `${c.deckCount} decks`) : undefined,
        badge: c.dueCount > 0 ? c.dueCount : undefined,
        badgeTone: 'warning' as const,
      })),
    [availableCourses, lang],
  );

  const presetOptions = useMemo<SelectOption<string>[]>(
    () =>
      METHOD_PRESETS.map((p) => ({
        value: p.id,
        label: t(lang, p.labelZh, p.labelEn),
        hint: t(lang, p.hintZh, p.hintEn),
      })),
    [lang],
  );

  const hints = useMemo<KeyHint[]>(() => {
    if (subMode === 'pickCourse') {
      return [
        { key: 'Enter', label: t(lang, '选择课程', 'Select') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (subMode === 'presets') {
      return [
        { key: 'Enter/1-4', label: t(lang, '应用预设', 'Apply') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    if (subMode === 'editNote' || subMode === 'editTargetDate' || subMode === 'rename' || subMode === 'editExamDate' || subMode === 'searchTerms') {
      return [
        { key: 'Enter', label: t(lang, '确认', 'Confirm') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    const base: KeyHint[] = [{ key: '1-3/Tab', label: t(lang, '标签', 'Tabs') }];
    if (tab === 'method') {
      base.push({ key: 'm', label: t(lang, '预设模式', 'Presets') });
      base.push({ key: 'e', label: t(lang, '改名称/注', 'Edit Note') });
      base.push({ key: 't', label: t(lang, '目标日', 'Target') });
      if (methodData?.own) base.push({ key: 'r', label: t(lang, '默认', 'Reset') });
    } else if (tab === 'info') {
      base.push({ key: 'n', label: t(lang, '重命名', 'Rename') });
      base.push({ key: 'd', label: t(lang, '考试日', 'Exam Date') });
    } else {
      base.push({ key: '/', label: t(lang, '筛选', 'Filter') });
      if (termFilter) base.push({ key: 'x', label: t(lang, '清筛选', 'Clear') });
    }
    if (availableCourses.length > 1) base.push({ key: 'c', label: t(lang, '换课', 'Course') });
    base.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return base;
  }, [subMode, tab, lang, methodData?.own, termFilter, availableCourses.length]);

  const renderStageRow = useCallback(
    (stage: CourseMethodStage, ctx: VirtualListRenderContext) => {
      const idx = ctx.index;
      const isCurrent = methodData?.progress?.index === idx;
      const st = methodData?.gate?.stages?.[idx]?.status;
      const glyph = isCurrent
        ? asciiMode
          ? '>'
          : '▶'
        : st === 'verified'
          ? asciiMode
            ? '+'
            : '✔'
          : asciiMode
            ? 'o'
            : '○';
      const meta = ` [${activityLabel(stage.activity, lang)} · ${levelLabel(stage.level, lang)}]${isCurrent ? t(lang, ' · 当前', ' · Now') : ''}`;
      const num = `${idx + 1}. `;
      const avail = Math.max(6, ctx.width - 2 - displayWidth(num) - displayWidth(meta));
      const name = padDisplay(truncateDisplay(stage.name, avail), avail);
      const fg = ctx.selected ? theme.selectionFg : theme.text;
      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={ctx.selected ? theme.selectionFg : isCurrent ? theme.accent : st === 'verified' ? theme.success : theme.muted}>
            {glyph}{' '}
          </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{num}</Text>
          {name}
          <Text color={ctx.selected ? theme.selectionFg : isCurrent ? theme.accent : theme.muted}>{meta}</Text>
        </Text>
      );
    },
    [methodData?.progress?.index, methodData?.gate?.stages, asciiMode, lang, theme],
  );

  const renderTermRow = useCallback(
    (item: CourseTermItem, ctx: VirtualListRenderContext) => {
      const badge = termStateBadge(item.state, lang);
      const stateTag = `[${badge.label}]`;
      const altText = item.alt ? ` (${item.alt})` : '';
      const occ = (item as { occurrences?: number; count?: number }).occurrences ?? (item as { count?: number }).count;
      const occTag = typeof occ === 'number' && occ > 0 ? ` ×${occ}` : '';
      const cardTag = item.card
        ? asciiMode
          ? lang === 'en'
            ? ' [card]'
            : ' [卡]'
          : t(lang, ' ✓已建卡', ' ✓Card')
        : '';
      const prefixW = displayWidth(stateTag) + 1;
      const avail = Math.max(6, ctx.width - prefixW - displayWidth(occTag) - displayWidth(cardTag));
      const body = padDisplay(truncateDisplay(`${item.term}${altText}`, avail), avail);
      const fg = ctx.selected ? theme.selectionFg : theme.text;
      const tagColor = ctx.selected
        ? theme.selectionFg
        : badge.tone === 'success'
          ? theme.success
          : badge.tone === 'info'
            ? theme.info
            : theme.warning;
      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={tagColor}>{stateTag} </Text>
          {body}
          {occTag ? <Text color={ctx.selected ? theme.selectionFg : theme.dim}>{occTag}</Text> : null}
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{cardTag}</Text>
        </Text>
      );
    },
    [lang, asciiMode, theme],
  );

  const termCounts = useMemo(() => {
    const items = termsData?.items ?? [];
    let known = 0;
    let learned = 0;
    let unknown = 0;
    for (const item of items) {
      if (item.state === 'known') known += 1;
      else if (item.state === 'learned') learned += 1;
      else unknown += 1;
    }
    return { total: items.length, known, learned, unknown };
  }, [termsData?.items]);

  const selectedTerm = filteredTerms[termIndex] ?? null;
  const tabLabel = (id: SettingsTab, zh: string, en: string, num: number) => {
    const active = tab === id;
    return (
      <Badge
        key={id}
        label={`${num}:${t(lang, zh, en)}`}
        tone={active ? 'primary' : 'neutral'}
        variant={active ? 'solid' : 'outline'}
      />
    );
  };

  return (
    <>
      <Modal
        title={t(lang, '课程设置与学法', 'Course Settings')}
        icon={asciiMode ? '*' : '⚙'}
        tone="accent"
        subtitle={selectedCourse ?? t(lang, '未选课程', 'No course')}
        width={frameW}
        height={frameH}
        onClose={subMode === 'none' ? onClose : () => setSubMode('none')}
        isActive={isActive && subMode === 'none'}
        hints={hints}
      >
        {/* Tab Bar */}
        <Box height={1} flexDirection="row" gap={1} overflow="hidden" flexShrink={0}>
          {tabLabel('method', '学习方式', 'Method', 1)}
          {tabLabel('info', '重命名与目标', 'Info & Rename', 2)}
          {tabLabel('terms', '课程术语', 'Terms', 3)}
          {busy ? <Spinner label={t(lang, '保存中…', 'Saving…')} active={isActive} /> : null}
        </Box>
        <Divider width={innerW} />

        {/* Course Selector Overlay inside Modal */}
        {subMode === 'pickCourse' ? (
          <Box flexDirection="column" height={tabBodyH} overflow="hidden">
            <Text color={theme.accent} bold>
              {t(lang, '选择要配置的课程:', 'Select a course to configure:')}
            </Text>
            <Box marginTop={1}>
              <SelectList
                options={courseOptions}
                width={innerW}
                maxHeight={Math.max(3, tabBodyH - 2)}
                currentValue={selectedCourse ?? undefined}
                isActive={isActive && subMode === 'pickCourse'}
                onSelect={(opt) => {
                  setSelectedCourse(opt.value);
                  setSubMode('none');
                }}
              />
            </Box>
          </Box>
        ) : !selectedCourse ? (
          <EmptyState
            title={t(lang, '当前暂无课程', 'No courses yet')}
            hint={t(lang, '先载入示例课程或导入资料并指定课程', 'Load the sample course or import material with a course')}
            width={innerW}
            height={tabBodyH}
          />
        ) : loading ? (
          <Box height={tabBodyH} alignItems="center" justifyContent="center">
            <Spinner label={t(lang, '正在读取课程配置…', 'Loading course settings…')} active={isActive} />
          </Box>
        ) : error && !methodData && !courseDetail ? (
          <Box height={tabBodyH} flexDirection="column" paddingY={1}>
            <Text color={theme.error} bold>{error}</Text>
          </Box>
        ) : tab === 'method' ? (
          subMode === 'presets' ? (
            <Box flexDirection="column" height={tabBodyH} overflow="hidden">
              <Text color={theme.accent} bold>
                {t(lang, '选择预设学习模式 (保存至 course.method.save):', 'Choose a preset learning mode:')}
              </Text>
              <Box marginTop={1}>
                <SelectList
                  options={presetOptions}
                  width={innerW}
                  maxHeight={Math.max(4, tabBodyH - 2)}
                  isActive={isActive && subMode === 'presets' && !busy}
                  onSelect={(opt) => {
                    const preset = METHOD_PRESETS.find((p) => p.id === opt.value);
                    if (!preset) return;
                    const payload = preset.build(methodData?.method?.targetDate ?? null);
                    void saveMethod(
                      payload,
                      t(lang, `已切换学法为「${preset.labelZh}」`, `Applied preset: ${preset.labelEn}`),
                    );
                  }}
                />
              </Box>
            </Box>
          ) : subMode === 'editNote' ? (
            <Box flexDirection="column" height={tabBodyH} overflow="hidden">
              <Text color={theme.accent} bold>
                {t(lang, '编辑学习方式名称 / 策略简注 (1–40 字):', 'Edit method name / strategy note (1–40 chars):')}
              </Text>
              <Box borderStyle="round" borderColor={theme.borderActive} paddingX={1} marginTop={1}>
                <TextInput
                  value={noteInput}
                  onChange={setNoteInput}
                  maxLength={40}
                  width={Math.max(12, innerW - 6)}
                  placeholder={t(lang, '例如：考前冲刺 · 周末精练', 'e.g. Exam Sprint')}
                  isActive={isActive && subMode === 'editNote' && !busy}
                  onCancel={() => setSubMode('none')}
                  onSubmit={(val) => {
                    const trimmed = val.trim();
                    if (!trimmed) {
                      notify(t(lang, '名称/简注不能为空', 'Method name cannot be empty'), 'warning');
                      return;
                    }
                    const base = methodData?.method ?? {
                      version: 1,
                      name: trimmed,
                      targetDate: null,
                      stages: [{ name: t(lang, '分批练习巩固', 'Practice'), activity: 'practice', alternatives: [], level: 'medium' }],
                    };
                    void saveMethod(
                      { ...base, name: trimmed },
                      t(lang, `已保存学习方式「${trimmed}」`, `Saved method "${trimmed}"`),
                    );
                  }}
                />
              </Box>
            </Box>
          ) : subMode === 'editTargetDate' ? (
            <Box flexDirection="column" height={tabBodyH} overflow="hidden">
              <Text color={theme.accent} bold>
                {t(lang, '设置学法目标日期 (YYYY-MM-DD，留空清除):', 'Set method target date (YYYY-MM-DD, empty to clear):')}
              </Text>
              <Box borderStyle="round" borderColor={theme.borderActive} paddingX={1} marginTop={1}>
                <TextInput
                  value={dateInput}
                  onChange={setDateInput}
                  maxLength={10}
                  width={Math.max(12, innerW - 6)}
                  placeholder="2026-06-15"
                  isActive={isActive && subMode === 'editTargetDate' && !busy}
                  onCancel={() => setSubMode('none')}
                  onSubmit={(val) => {
                    const trimmed = val.trim();
                    if (trimmed && !isValidIsoDate(trimmed)) {
                      notify(t(lang, '日期格式需为 YYYY-MM-DD', 'Date must be YYYY-MM-DD'), 'warning');
                      return;
                    }
                    const base = methodData?.method;
                    if (!base) return;
                    void saveMethod(
                      { ...base, targetDate: trimmed || null },
                      trimmed
                        ? t(lang, `目标日期已设为 ${trimmed}`, `Target date set to ${trimmed}`)
                        : t(lang, '已清除目标日期', 'Target date cleared'),
                    );
                  }}
                />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" height={tabBodyH} overflow="hidden">
              <Box height={1} flexDirection="row" gap={1} overflow="hidden">
                <Text color={theme.text} bold>
                  {methodData?.method?.name || t(lang, '课堂跟学', 'Classroom')}
                </Text>
                <Badge
                  label={methodData?.own ? t(lang, '自定义', 'Custom') : t(lang, '默认', 'Default')}
                  tone={methodData?.own ? 'ai' : 'neutral'}
                  variant="soft"
                />
                {methodData?.method?.targetDate ? (
                  <StatusPill label={`${t(lang, '目标', 'Goal')} ${methodData.method.targetDate}`} status="idle" />
                ) : null}
              </Box>
              {courseDetail?.plan?.notes ? (
                <Box height={1} overflow="hidden">
                  <Text color={theme.muted} wrap="truncate-end">
                    {t(lang, '备注', 'Notes')}: {courseDetail.plan.notes}
                  </Text>
                </Box>
              ) : null}
              <VirtualList
                items={stages}
                height={Math.max(3, tabBodyH - (courseDetail?.plan?.notes ? 5 : 4))}
                width={innerW}
                selectedIndex={stageIndex}
                onChange={(idx) => setStageIndex(idx)}
                onSelect={(_stage, idx) => {
                  if (methodData?.own) {
                    void handleJumpStage(idx);
                  } else {
                    notify(
                      t(lang, '默认学法不支持跳阶段，按 [m] 选自定义预设后可切换', 'Default method cannot jump stages; press [m] for a custom preset'),
                      'info',
                    );
                  }
                }}
                isActive={isActive && subMode === 'none' && !busy}
                keyExtractor={(s, idx) => `${s.name}:${idx}`}
                renderItem={renderStageRow}
                emptyText={t(lang, '暂无阶段', 'No stages')}
              />
              <Divider width={innerW} />
              <Box height={2} flexDirection="column" overflow="hidden">
                <Text color={theme.muted} wrap="truncate-end">
                  {methodData?.gate
                    ? t(
                        lang,
                        `当前阶段检验：通过 ${methodData.gate.passed}/${methodData.gate.total} 题${methodData.gate.checkPassed ? ' (已过关)' : methodData.gate.toReady > 0 ? ` · 再答对 ${methodData.gate.toReady} 题可进下一阶段` : ''}`,
                        `Stage gate: ${methodData.gate.passed}/${methodData.gate.total} passed${methodData.gate.checkPassed ? ' (Passed)' : methodData.gate.toReady > 0 ? ` · ${methodData.gate.toReady} more to advance` : ''}`,
                      )
                    : t(lang, '按 [m] 选择学习模式预设，[e] 修改名称/策略简注', 'Press [m] for presets, [e] to edit method note')}
                </Text>
                <Text color={theme.accent} wrap="truncate-end">
                  {t(
                    lang,
                    '[m] 选预设模式  [e] 编辑简注  [t] 目标日期' + (methodData?.own ? '  [Enter] 跳阶段  [r] 恢复默认' : ''),
                    '[m] Presets  [e] Edit Note  [t] Target Date' + (methodData?.own ? '  [Enter] Jump  [r] Reset' : ''),
                  )}
                </Text>
              </Box>
            </Box>
          )
        ) : tab === 'info' ? (
          subMode === 'rename' ? (
            <Box flexDirection="column" height={tabBodyH} overflow="hidden">
              <Text color={theme.accent} bold>
                {t(lang, `重命名课程「${selectedCourse}」(将同步题组与资料):`, `Rename course "${selectedCourse}" (syncs decks & sources):`)}
              </Text>
              <Box borderStyle="round" borderColor={theme.borderActive} paddingX={1} marginTop={1}>
                <TextInput
                  value={renameInput}
                  onChange={setRenameInput}
                  maxLength={200}
                  width={Math.max(12, innerW - 6)}
                  placeholder={t(lang, '输入新的课程名称…', 'New course name…')}
                  isActive={isActive && subMode === 'rename' && !busy}
                  onCancel={() => setSubMode('none')}
                  onSubmit={(val) => {
                    const next = val.trim();
                    if (!next || next === selectedCourse) {
                      setSubMode('none');
                      return;
                    }
                    if (!resolvedCourseId) {
                      notify(t(lang, '未找到课程记录 ID，请刷新后重试', 'Course ID missing; refresh and retry'), 'error');
                      setSubMode('none');
                      return;
                    }
                    setPendingRename(next);
                    setSubMode('confirmRename');
                  }}
                />
              </Box>
            </Box>
          ) : subMode === 'editExamDate' ? (
            <Box flexDirection="column" height={tabBodyH} overflow="hidden">
              <Text color={theme.accent} bold>
                {t(lang, '设置考试日期 (YYYY-MM-DD，留空清除):', 'Set exam date (YYYY-MM-DD, empty to clear):')}
              </Text>
              <Box borderStyle="round" borderColor={theme.borderActive} paddingX={1} marginTop={1}>
                <TextInput
                  value={dateInput}
                  onChange={setDateInput}
                  maxLength={10}
                  width={Math.max(12, innerW - 6)}
                  placeholder="2026-06-20"
                  isActive={isActive && subMode === 'editExamDate' && !busy}
                  onCancel={() => setSubMode('none')}
                  onSubmit={(val) => {
                    void handleSaveExamDate(val);
                  }}
                />
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" height={tabBodyH} gap={0} overflow="hidden">
              <Box height={1} overflow="hidden">
                <Text color={theme.muted}>{t(lang, '课程名称', 'Course Name')}: </Text>
                <Text color={theme.text} bold>{courseDetail?.name || selectedCourse}</Text>
              </Box>
              <Box height={1} overflow="hidden">
                <Text color={theme.muted}>{t(lang, '旧称别名', 'Aliases')}: </Text>
                <Text color={theme.text} wrap="truncate-end">
                  {courseDetail?.aliases?.length ? courseDetail.aliases.join(' · ') : t(lang, '无', 'None')}
                </Text>
              </Box>
              <Box height={1} overflow="hidden">
                <Text color={theme.muted}>{t(lang, '资源规模', 'Library')}: </Text>
                <Text color={theme.text}>
                  {courseDetail?.decks ?? 0} {t(lang, '题组', 'decks')} · {courseDetail?.sources ?? 0} {t(lang, '资料', 'sources')}
                </Text>
              </Box>
              <Box height={1} overflow="hidden">
                <Text color={theme.muted}>{t(lang, '考试日期', 'Exam Date')}: </Text>
                <Text color={courseDetail?.exam?.date ? theme.warning : theme.dim}>
                  {courseDetail?.exam?.date || t(lang, '未设置', 'Not set')}
                </Text>
                <Text color={theme.muted}>   {t(lang, '学法目标日', 'Goal')}: </Text>
                <Text color={methodData?.method?.targetDate ? theme.accent : theme.dim}>
                  {methodData?.method?.targetDate || t(lang, '未设置', 'Not set')}
                </Text>
              </Box>
              <Box height={1} overflow="hidden">
                <Text color={theme.muted}>{t(lang, '重点知识点', 'Focus Topics')}: </Text>
                <Text color={theme.text} wrap="truncate-end">
                  {courseDetail?.focusTopics?.length
                    ? `${courseDetail.focusTopics.length} ${t(lang, '项', 'items')} (${courseDetail.focusTopics.slice(0, 3).join(', ')})`
                    : t(lang, '未设置', 'None')}
                </Text>
              </Box>
              <Divider width={innerW} />
              <Box flexDirection="column" overflow="hidden">
                <Text color={theme.accent} wrap="truncate-end">
                  [n] {t(lang, '重命名课程 (同步题组、资料和练习，旧名保留为别名)', 'Rename course (syncs decks, sources & runs)')}
                </Text>
                <Text color={theme.accent} wrap="truncate-end">
                  [d] {t(lang, '设置 / 清除考试日期 (同步考前对齐)', 'Set / clear exam date (triggers alignment)')}
                </Text>
              </Box>
            </Box>
          )
        ) : (
          /* Tab 3: Course Terms */
          <Box flexDirection="column" height={tabBodyH} overflow="hidden">
            {subMode === 'searchTerms' ? (
              <Box flexDirection="column" flexShrink={0}>
                <Text color={theme.accent}>{t(lang, '筛选课程术语:', 'Filter course terms:')}</Text>
                <Box borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
                  <TextInput
                    value={termFilter}
                    onChange={setTermFilter}
                    onSubmit={() => setSubMode('none')}
                    onCancel={() => setSubMode('none')}
                    isActive={isActive && subMode === 'searchTerms'}
                    width={Math.max(12, innerW - 6)}
                    placeholder={t(lang, '输入术语关键字…', 'Type term keyword…')}
                  />
                </Box>
              </Box>
            ) : null}

            <Box height={1} flexDirection="row" gap={1} overflow="hidden" flexShrink={0}>
              <Text color={theme.muted} wrap="truncate-end">
                {t(lang, '共', 'Total')} <Text color={theme.text} bold>{termCounts.total}</Text>
                {' · '}
                <Text color={theme.success}>{t(lang, '已掌握', 'Known')} {termCounts.known}</Text>
                {' · '}
                <Text color={theme.info}>{t(lang, '学习中', 'Learning')} {termCounts.learned}</Text>
                {' · '}
                <Text color={theme.warning}>{t(lang, '待巩固', 'Unknown')} {termCounts.unknown}</Text>
              </Text>
              {termFilter ? <Badge label={`${t(lang, '筛选', 'Filter')}: ${termFilter}`} tone="info" variant="soft" /> : null}
            </Box>

            {filteredTerms.length === 0 ? (
              <EmptyState
                title={termFilter ? t(lang, '没有匹配的术语', 'No matching terms') : t(lang, '该课程暂无提取术语', 'No terms recorded for this course')}
                hint={
                  termFilter
                    ? t(lang, '按 [x] 清除筛选', 'Press [x] to clear filter')
                    : t(lang, '练习时标记的生词与关键术语会汇总在这里', 'Key terms marked during practice appear here')
                }
                width={innerW}
                height={Math.max(3, tabBodyH - (subMode === 'searchTerms' ? 4 : 1))}
              />
            ) : (
              <>
                <VirtualList
                  items={filteredTerms}
                  height={Math.max(3, tabBodyH - (subMode === 'searchTerms' ? 7 : 4))}
                  width={innerW}
                  selectedIndex={termIndex}
                  onChange={(idx) => setTermIndex(idx)}
                  isActive={isActive && subMode === 'none'}
                  keyExtractor={(item, idx) => `${item.term}:${idx}`}
                  renderItem={renderTermRow}
                />
                <Divider width={innerW} />
                <Box height={2} flexDirection="column" overflow="hidden">
                  {selectedTerm ? (
                    <>
                      <Text color={theme.text} wrap="truncate-end">
                        <Text bold>{selectedTerm.term}</Text>
                        {selectedTerm.alt ? ` (${selectedTerm.alt})` : ''}
                        {' · '}
                        <Text color={theme.muted}>{termStateBadge(selectedTerm.state, lang).label}</Text>
                      </Text>
                      <Text color={theme.muted} wrap="truncate-end">
                        {selectedTerm.fromPrompt
                          ? `${t(lang, '出处题干', 'From')}: ${selectedTerm.fromPrompt}`
                          : selectedTerm.at
                            ? `${t(lang, '记录时间', 'Recorded')}: ${selectedTerm.at.slice(0, 10)}`
                            : t(lang, '按 [/] 搜索术语', 'Press [/] to filter terms')}
                      </Text>
                    </>
                  ) : null}
                </Box>
              </>
            )}
          </Box>
        )}
      </Modal>

      {subMode === 'confirmRename' && pendingRename ? (
        <ConfirmDialog
          title={t(lang, '确认重命名课程', 'Confirm Course Rename')}
          message={t(
            lang,
            `把「${selectedCourse}」改名为「${pendingRename}」？所有题组、资料和练习都会同步更新，旧名称会保留为别名。`,
            `Rename "${selectedCourse}" to "${pendingRename}"? All decks, sources, and runs will update, keeping the old name as an alias.`,
          )}
          confirmLabel={t(lang, '确认改名', 'Rename')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive && subMode === 'confirmRename'}
          onConfirm={() => {
            void handleRenameConfirmed();
          }}
          onCancel={() => setSubMode('none')}
        />
      ) : null}
    </>
  );
});
