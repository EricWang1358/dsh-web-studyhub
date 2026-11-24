import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { KeyHint, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useClaimKeys, useInputCapture } from '../../components/focus.js';
import { computeFilterBarLayout } from '../../components/layout-tokens.js';
import { useFooterHints } from '../../components/hooks.js';
import { currentCourse, listCourses, modelInfo } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { errorMessage, tryAction } from '../../host/sample-actions.js';
import { type DocumentGroup, groupSourcesFromSnapshot, formatLabel } from '../sources/source-helpers.js';

const DraftEditor = lazy(() => import('./DraftEditor.js').then((m) => ({ default: m.DraftEditor })));
const IngestModal = lazy(() => import('./IngestModal.js').then((m) => ({ default: m.IngestModal })));
const GeneratePathModal = lazy(() => import('./GeneratePathModal.js').then((m) => ({ default: m.GeneratePathModal })));

type SubTab = 'new' | 'drafts';
type GenOverlay = 'none' | 'scope' | 'focus' | 'ingest' | 'path' | 'suggest-confirm' | 'suggest-loading' | 'suggest-result';

interface SuggestUnavailable {
  reason?: string;
  message?: string;
  sample?: string;
}

interface GenerateSuggestResult {
  source?: 'model' | 'local';
  focus?: string[];
  coverage?: string;
  difficulty?: string;
  kind?: string;
  count?: number;
  why?: string;
  basis?: { sources?: number; weakTopics?: number };
  unavailable?: SuggestUnavailable;
}

const QUESTION_KINDS: ReadonlyArray<{ id: string; zh: string; en: string }> = [
  { id: 'quiz', zh: '单选', en: 'Quiz' },
  { id: 'multi', zh: '多选', en: 'Multi' },
  { id: 'truefalse', zh: '判断', en: 'True/False' },
  { id: 'cloze', zh: '填空', en: 'Cloze' },
  { id: 'open', zh: '简答', en: 'Open' },
  { id: 'flashcard', zh: '闪卡', en: 'Flashcard' },
  { id: 'mixed', zh: '混合', en: 'Mixed' },
];

const TARGET_COUNTS = [5, 10, 15, 20] as const;

function parsePageScope(scopeText: string): Set<number> | null {
  const clean = scopeText.trim().toLowerCase();
  if (!clean || clean === 'all' || clean === '*') return null;
  const pages = new Set<number>();
  for (const part of clean.split(/[,，\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number.parseInt(range[1], 10);
      const b = Number.parseInt(range[2], 10);
      const lo = Math.min(a, b);
      const hi = Math.min(Math.max(a, b), lo + 500);
      for (let p = lo; p <= hi; p += 1) pages.add(p);
    } else if (/^\d+$/.test(part)) {
      pages.add(Number.parseInt(part, 10));
    }
  }
  return pages.size > 0 ? pages : null;
}

export function formatWeakTopicNames(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { topics?: unknown }).topics)
      ? (raw as { topics: unknown[] }).topics
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let candidate = '';
    if (typeof item === 'string') {
      candidate = item.trim();
    } else if (item && typeof item === 'object') {
      const obj = item as { topic?: unknown; name?: unknown };
      if (typeof obj.topic === 'string' && obj.topic.trim()) {
        candidate = obj.topic.trim();
      } else if (typeof obj.name === 'string' && obj.name.trim()) {
        candidate = obj.name.trim();
      }
    }
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= 8) break;
  }
  return out;
}

function mergeFocusText(current: string, items: readonly string[], lang: 'zh' | 'en'): string {
  const sep = lang === 'en' ? '; ' : '；';
  const existing = current
    .split(/[；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let next = current.trim();
  for (const raw of items) {
    const item = raw.trim();
    if (!item || existing.includes(item)) continue;
    existing.push(item);
    next = next ? `${next.replace(/[；;]+$/, '')}${sep}${item}` : item;
  }
  return next;
}

function formatCoverageLabel(coverage: string | undefined, lang: 'zh' | 'en'): string {
  if (coverage === 'lean') return t(lang, '精简', 'Lean');
  if (coverage === 'standard') return t(lang, '标准', 'Standard');
  if (coverage === 'full') return t(lang, '完整', 'Full');
  return coverage ?? '';
}

function formatDifficultyLabel(difficulty: string | undefined, lang: 'zh' | 'en'): string {
  if (difficulty === 'mixed') return t(lang, '混合难度', 'Mixed');
  if (difficulty === 'foundation') return t(lang, '基础理解', 'Foundation');
  if (difficulty === 'application') return t(lang, '应用迁移', 'Application');
  if (difficulty === 'advanced') return t(lang, '深入辨析', 'Advanced');
  return difficulty ?? '';
}

function formatUnavailableReason(unavailable: SuggestUnavailable | undefined, lang: 'zh' | 'en'): string | null {
  if (!unavailable?.reason) return null;
  switch (unavailable.reason) {
    case 'no-signal':
      return t(
        lang,
        '所选资料暂未提取到标题/目录且暂无薄弱知识点记录，请先确认资料内容或先做一轮练习。',
        'No headings or weak topics found for the selected materials yet.',
      );
    case 'no-model':
      return t(
        lang,
        '当前未配置可用模型，已为你展示基于本地目录与薄弱点的参考建议。',
        'No AI model configured; showing local suggestions from outlines and weak topics.',
      );
    case 'nothing-usable':
      return t(
        lang,
        '模型返回内容未能解析，已回退为基于本地目录与薄弱点的建议。',
        'Model output could not be parsed; falling back to local suggestions.',
      );
    case 'failed':
      return t(
        lang,
        `AI 建议调用失败${unavailable.message ? ` (${unavailable.message})` : ''}，已回退为本地建议。`,
        `AI suggestion call failed${unavailable.message ? ` (${unavailable.message})` : ''}; falling back to local suggestions.`,
      );
    default:
      return t(
        lang,
        `AI 建议暂不可用 (${unavailable.reason})，已展示本地可用建议。`,
        `AI suggestion unavailable (${unavailable.reason}); showing local suggestions.`,
      );
  }
}

export function filterMaterialGroups(
  docs: readonly DocumentGroup[],
  query: string,
): readonly DocumentGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs;
  return docs.filter((doc) => {
    const hay = [doc.title, ...doc.courses, doc.folder ?? '', doc.format, formatLabel(doc.format)]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

export const GenerateView: React.FC<ViewProps> = memo(function GenerateView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const binding = useTuiStore((s) => s.binding);
  const desktopConfig = useTuiStore((s) => s.desktopConfig);
  const navContext = useTuiStore((s) => s.navContext);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const inputCaptured = useTuiStore((s) => s.inputCaptured);
  const shellOverlay = useTuiStore(
    (s) => s.commandPaletteOpen || s.helpOpen || s.coursePickerOpen || s.inboxOpen || s.voicePackOpen,
  );
  const { columns } = useStableWindowSize();
  const { refresh } = useShellActions();

  const [tab, setTab] = useState<SubTab>(navContext.draftId ? 'drafts' : 'new');

  useEffect(() => {
    if (navContext.draftId) setTab('drafts');
  }, [navContext.draftId]);

  const model = useMemo(
    () => modelInfo(desktopConfig, binding, snapshot, asciiMode),
    [desktopConfig, binding, snapshot, asciiMode],
  );

  const courses = useMemo(() => listCourses(snapshot), [snapshot]);
  const allDocs = useMemo(() => groupSourcesFromSnapshot(snapshot), [snapshot]);

  const [courseName, setCourseName] = useState<string>(
    navContext.course || currentCourse(snapshot) || '',
  );
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(
    () => new Set(navContext.sourceIds ?? []),
  );
  const [pageScope, setPageScope] = useState('all');
  const [kindIndex, setKindIndex] = useState(0);
  const [countIndex, setCountIndex] = useState(1); // default 10
  const [focusText, setFocusText] = useState('');
  const [sourceCursor, setSourceCursor] = useState(0);
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
  const [overlay, setOverlay] = useState<GenOverlay>('none');
  const [submitting, setSubmitting] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestResult, setSuggestResult] = useState<GenerateSuggestResult | null>(null);
  const [weakTopics, setWeakTopics] = useState<string[]>([]);
  const weakSeqRef = useRef(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isActive || tab !== 'new') return;
    const seq = ++weakSeqRef.current;
    void (async () => {
      const res = await tryAction<{ topics?: unknown }>(
        host,
        'generate.weakTopics',
        courseName ? { course: courseName } : {},
      );
      if (!mountedRef.current || seq !== weakSeqRef.current) return;
      if (res.ok && res.value) {
        setWeakTopics(formatWeakTopicNames(res.value));
      } else {
        setWeakTopics([]);
      }
    })();
  }, [host, isActive, tab, courseName, snapshot]);

  // Sync incoming navContext.sourceIds / navContext.course
  useEffect(() => {
    if (navContext.sourceIds && navContext.sourceIds.length > 0) {
      setSelectedSourceIds(new Set(navContext.sourceIds));
      setTab('new');
    }
    if (navContext.course !== undefined && navContext.course !== null) {
      setCourseName(navContext.course);
    }
  }, [navContext.sourceIds, navContext.course]);

  const baseDocs = useMemo(() => {
    if (!courseName) return allDocs;
    const filtered = allDocs.filter((d) => d.courses.includes(courseName));
    return filtered.length > 0 ? filtered : allDocs;
  }, [allDocs, courseName]);

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const filteredDocs = useMemo(
    () => (normalizedFilter ? filterMaterialGroups(baseDocs, normalizedFilter) : baseDocs),
    [baseDocs, normalizedFilter],
  );

  useEffect(() => {
    setSourceCursor((cur) => {
      if (filteredDocs.length === 0) return 0;
      return Math.min(cur, filteredDocs.length - 1);
    });
  }, [filteredDocs.length]);

  // Resolve final sourceIds with page scope applied
  const effectiveSourceIds = useMemo(() => {
    const scopeSet = parsePageScope(pageScope);
    if (!scopeSet) return [...selectedSourceIds];
    const out: string[] = [];
    for (const doc of allDocs) {
      const hasDocSelected = doc.sourceIds.some((id) => selectedSourceIds.has(id));
      if (!hasDocSelected) continue;
      for (const p of doc.pages) {
        if (selectedSourceIds.has(p.sourceId) && scopeSet.has(p.page)) {
          out.push(p.sourceId);
        }
      }
    }
    return out.length > 0 ? out : [...selectedSourceIds];
  }, [allDocs, pageScope, selectedSourceIds]);

  const selectedKind = QUESTION_KINDS[kindIndex] ?? QUESTION_KINDS[0];
  const targetCount = TARGET_COUNTS[countIndex] ?? 10;

  // Live cost/token estimate (debounced)
  const [estimate, setEstimate] = useState<{
    loading: boolean;
    tokensLow?: number;
    tokensHigh?: number;
    calls?: number;
    note?: string;
  }>({ loading: false });

  useEffect(() => {
    if (!isActive || tab !== 'new' || effectiveSourceIds.length === 0) {
      setEstimate({ loading: false });
      return;
    }
    let cancelled = false;
    setEstimate((prev) => ({ ...prev, loading: true }));
    const timer = setTimeout(() => {
      void (async () => {
        const req = {
          sourceIds: effectiveSourceIds,
          count: targetCount,
          kind: selectedKind.id,
          ...(courseName ? { course: courseName } : {}),
          ...(focusText.trim() ? { focus: focusText.trim() } : {}),
        };
        let res = await tryAction<Record<string, unknown>>(host, 'generate.preview', req);
        if (!res.ok) {
          res = await tryAction<Record<string, unknown>>(host, 'usage.estimate', {
            feature: 'generate',
            ...req,
          });
        }
        if (cancelled) return;
        if (res.ok && res.value) {
          const val = res.value;
          const totalTokens = (val.totalTokens || (val.estimate as Record<string, unknown>)?.totalTokens) as
            | { low?: number; high?: number }
            | undefined;
          const callsObj = (val.calls || (val.estimate as Record<string, unknown>)?.calls) as
            | { low?: number; high?: number }
            | number
            | undefined;
          const callsCount =
            typeof callsObj === 'number'
              ? callsObj
              : typeof callsObj === 'object' && callsObj
                ? callsObj.high ?? callsObj.low
                : undefined;
          setEstimate({
            loading: false,
            tokensLow: totalTokens?.low,
            tokensHigh: totalTokens?.high,
            calls: callsCount,
          });
        } else {
          setEstimate({ loading: false, note: res.error?.message });
        }
      })();
    }, 280);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [host, isActive, tab, effectiveSourceIds, targetCount, selectedKind.id, courseName, focusText]);

  const handleSubmitGeneration = useCallback(async () => {
    if (submitting) return;
    if (!model.ready) {
      notify(t(lang, '模型未就绪，请先按 [S] 配置模型', 'Model not ready — press [S] to open Settings'), 'warning');
      return;
    }
    if (effectiveSourceIds.length === 0) {
      notify(t(lang, '请至少选择一份资料 (空格键勾选)', 'Select at least one material (Space)'), 'warning');
      return;
    }
    setSubmitting(true);
    const res = await tryAction<{ jobId?: string; id?: string }>(host, 'generate', {
      sourceIds: effectiveSourceIds,
      count: targetCount,
      kind: selectedKind.id,
      ...(courseName ? { course: courseName } : {}),
      ...(focusText.trim() ? { focus: focusText.trim() } : {}),
    });
    setSubmitting(false);
    if (!res.ok) {
      notify(res.error?.message || t(lang, '提交出题任务失败', 'Failed to start generation'), 'error');
      return;
    }
    await refresh();
    const jobId = res.value?.jobId || res.value?.id;
    notify(t(lang, `后台出题任务已启动，正在跳转任务监控${ell}`, `Generation job started — opening Tasks${ell}`), 'success');
    navigate('tasks', jobId ? { jobId } : {});
  }, [
    submitting,
    model.ready,
    effectiveSourceIds,
    host,
    targetCount,
    selectedKind.id,
    courseName,
    focusText,
    refresh,
    notify,
    lang,
    navigate,
  ]);

  const handleRunSuggest = useCallback(async () => {
    if (busyRef.current || suggestLoading) return;
    if (effectiveSourceIds.length === 0) {
      setOverlay('none');
      notify(
        t(
          lang,
          '请至少选择一份资料后再使用「帮我想想」（按空格键勾选）',
          'Select at least 1 material first before using AI Suggest (Space)',
        ),
        'warning',
      );
      return;
    }
    busyRef.current = true;
    setSuggestLoading(true);
    setOverlay('suggest-loading');
    try {
      let goal: string | undefined;
      const profileRes = await tryAction<{ goal?: unknown }>(host, 'coach.profile', {});
      if (profileRes.ok && typeof profileRes.value?.goal === 'string' && profileRes.value.goal.trim()) {
        goal = profileRes.value.goal.trim();
      }
      const res = await tryAction<GenerateSuggestResult>(host, 'generate.suggest', {
        sourceIds: effectiveSourceIds,
        ...(courseName ? { course: courseName } : {}),
        ...(goal ? { goal } : {}),
      });
      if (!mountedRef.current) return;
      if (!res.ok || !res.value) {
        setOverlay('none');
        notify(
          res.error?.message || t(lang, '获取 AI 出题建议失败', 'Failed to get AI generation suggestion'),
          'error',
        );
        return;
      }
      setSuggestResult(res.value);
      setOverlay('suggest-result');
    } catch (error) {
      if (mountedRef.current) {
        setOverlay('none');
        notify(errorMessage(error, lang), 'error');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSuggestLoading(false);
    }
  }, [courseName, effectiveSourceIds, host, lang, notify, suggestLoading]);

  const handleApplySuggest = useCallback(() => {
    if (!suggestResult) {
      setOverlay('none');
      return;
    }
    const items = Array.isArray(suggestResult.focus) ? suggestResult.focus.filter((x) => typeof x === 'string' && x.trim()) : [];
    const kindIdx = suggestResult.kind ? QUESTION_KINDS.findIndex((k) => k.id === suggestResult.kind) : -1;
    if (items.length === 0 && kindIdx < 0) {
      notify(t(lang, '当前暂无可应用的建议重点', 'No suggested focus to apply yet'), 'warning');
      return;
    }
    if (items.length > 0) {
      setFocusText((prev) => mergeFocusText(prev, items, lang));
    }
    if (kindIdx >= 0) {
      setKindIndex(kindIdx);
    }
    setOverlay('none');
    notify(t(lang, '已将建议重点应用到出题设置', 'Applied suggested focus to generation settings'), 'success');
  }, [lang, notify, suggestResult]);

  const handleFillWeakTopics = useCallback(() => {
    if (weakTopics.length === 0) {
      notify(
        t(lang, '当前课程暂无薄弱知识点记录', 'No weak topics recorded for this course yet'),
        'info',
      );
      return;
    }
    const candidates = weakTopics.slice(0, 5);
    const existing = new Set(
      focusText
        .split(/[；;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const added = candidates.filter((topic) => !existing.has(topic)).length;
    if (added === 0) {
      notify(
        t(lang, '当前薄弱知识点已全部在出题重点中', 'All weak topics are already in focus'),
        'info',
      );
      return;
    }
    setFocusText((prev) => mergeFocusText(prev, candidates, lang));
    notify(
      t(
        lang,
        `已填入 ${added} 个薄弱知识点到出题重点`,
        `Added ${added} weak topic(s) to focus`,
      ),
      'success',
    );
  }, [weakTopics, focusText, lang, notify]);

  const wizardActive = isActive && tab === 'new' && overlay === 'none' && !inputCaptured && !suggestLoading;
  const filterInputActive =
    isActive && tab === 'new' && overlay === 'none' && !shellOverlay && !suggestLoading && filterEditing;

  useClaimKeys(['c', 'k', 'n', 'p', 'f', 'S', 'W', 'P', 'a', 'g', 'i', '/'], wizardActive && !filterEditing);
  useInputCapture(isActive && tab === 'new' && (overlay === 'scope' || overlay === 'focus'));
  useInputCapture(isActive && tab === 'new' && overlay === 'none' && filterEditing);

  const handleApplyPathStep = useCallback(
    ({ pageScope: nextScope, targetCount: nextCount, focusNote }: { pageScope: string; targetCount: number; focusNote?: string }) => {
      setPageScope(nextScope);
      let bestIdx = 0;
      let bestDiff = Math.abs(TARGET_COUNTS[0] - nextCount);
      for (let i = 1; i < TARGET_COUNTS.length; i += 1) {
        const diff = Math.abs(TARGET_COUNTS[i] - nextCount);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      setCountIndex(bestIdx);
      if (focusNote && focusNote.trim()) {
        setFocusText((prev) => mergeFocusText(prev, [focusNote.trim()], lang));
      }
      setOverlay('none');
      notify(
        t(
          lang,
          `已应用分步范围 p.${nextScope}（${TARGET_COUNTS[bestIdx]} 题）`,
          `Applied path step p.${nextScope} (${TARGET_COUNTS[bestIdx]} questions)`,
        ),
        'success',
      );
    },
    [lang, notify],
  );

  const wizardHints: KeyHint[] = useMemo(
    () => [
      { key: 'Tab', label: t(lang, '切到草稿箱', 'Drafts') },
      { key: 'Space', label: t(lang, '勾选资料', 'Toggle Src') },
      { key: 'i', label: t(lang, '录题', 'Capture') },
      { key: 'c', label: t(lang, '换课程', 'Course') },
      { key: 'k', label: t(lang, '题型', 'Kind') },
      { key: 'n', label: t(lang, '题数', 'Count') },
      { key: 'p', label: t(lang, '页码范围', 'Pages') },
      { key: 'f', label: t(lang, '出题要求', 'Focus') },
      { key: 'W', label: t(lang, '填薄弱点', 'Weak Topics') },
      { key: 'S', label: model.ready ? t(lang, '帮我想想', 'AI Suggest') : t(lang, '设置模型', 'Settings') },
      { key: 'P', label: t(lang, '分步路径', 'Path') },
      { key: 'Ctrl+S', label: t(lang, '开始出题', 'Generate') },
      { key: '/', label: t(lang, '筛选资料', 'Filter') },
    ],
    [lang, model.ready],
  );
  useFooterHints(wizardHints, isActive && tab === 'new' && !inputCaptured);

  useInput(
    (input, key) => {
      if (!isActive || shellOverlay) return;
      if (overlay === 'suggest-result') {
        if (input === 'a' || input === 'A' || key.return) {
          handleApplySuggest();
        }
        return;
      }
      if (overlay !== 'none' || inputCaptured || busyRef.current || suggestLoading || filterEditing) return;
      if (key.tab) {
        setTab((cur) => (cur === 'new' ? 'drafts' : 'new'));
        return;
      }
      if (tab !== 'new') return;

      if (key.escape && filterQuery) {
        setFilterQuery('');
        setSourceCursor(0);
        return;
      }

      if (input === '/' && !key.ctrl && !key.meta) {
        setFilterEditing(true);
        return;
      }

      if (input === 'i' && !key.ctrl && !key.meta) {
        setOverlay('ingest');
        return;
      }

      if (key.ctrl && input === 's') {
        void handleSubmitGeneration();
        return;
      }
      if (input === 'W' && !key.ctrl && !key.meta) {
        handleFillWeakTopics();
        return;
      }
      if (input === 'P' && !key.ctrl && !key.meta) {
        if (selectedSourceIds.size === 0) {
          notify(
            t(
              lang,
              '请至少选择一份资料后再规划分步出题路径（按空格键勾选）',
              'Select at least 1 material first to plan generation path (Space)',
            ),
            'warning',
          );
          return;
        }
        setOverlay('path');
        return;
      }
      if (input === 'S' && !key.ctrl && !key.meta) {
        if (!model.ready) {
          navigate('settings', { mode: 'model' });
          return;
        }
        if (busyRef.current || suggestLoading) return;
        if (effectiveSourceIds.length === 0) {
          notify(
            t(
              lang,
              '请至少选择一份资料后再使用「帮我想想」（按空格键勾选）',
              'Select at least 1 material first before using AI Suggest (Space)',
            ),
            'warning',
          );
          return;
        }
        setOverlay('suggest-confirm');
        return;
      }
      if (input === 'c') {
        const names = ['', ...courses.map((c) => c.key)];
        const idx = names.indexOf(courseName);
        setCourseName(names[(idx + 1) % names.length]);
      } else if (input === 'k') {
        setKindIndex((i) => (i + 1) % QUESTION_KINDS.length);
      } else if (input === 'n') {
        setCountIndex((i) => (i + 1) % TARGET_COUNTS.length);
      } else if (input === 'p') {
        setOverlay('scope');
      } else if (input === 'f') {
        setOverlay('focus');
      } else if (input === 'a') {
        const visibleIds = filteredDocs.flatMap((d) => d.sourceIds);
        if (visibleIds.length === 0) return;
        setSelectedSourceIds((prev) => {
          const allVisibleSelected = visibleIds.every((id) => prev.has(id));
          const next = new Set(prev);
          if (allVisibleSelected) {
            for (const id of visibleIds) next.delete(id);
          } else {
            for (const id of visibleIds) next.add(id);
          }
          return next;
        });
      } else if (input === ' ') {
        const doc = filteredDocs[sourceCursor];
        if (doc) {
          setSelectedSourceIds((prev) => {
            const next = new Set(prev);
            const allPicked = doc.sourceIds.every((id) => next.has(id));
            for (const id of doc.sourceIds) {
              if (allPicked) next.delete(id);
              else next.add(id);
            }
            return next;
          });
        }
      }
    },
    { isActive },
  );

  const showFilterBar = tab === 'new' && (filterEditing || filterQuery.length > 0);
  const filterBarH = showFilterBar ? 1 : 0;
  const tabBarH = 2;
  const bodyH = Math.max(4, height - tabBarH - filterBarH);
  const draftCount = snapshot?.drafts?.length ?? 0;

  const filterBadge = `[${t(lang, '筛选', filterEditing ? 'Filter' : 'Filtered')} ${filteredDocs.length}/${baseDocs.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Sub-tab Header */}
      <Box height={tabBarH} width={width} paddingX={1} flexDirection="column">
        <Box flexDirection="row" alignItems="center">
          <Badge
            label={`${asciiMode ? '+' : '✦'} ${t(lang, '新建出题任务', 'New Generation')}`}
            tone={tab === 'new' ? 'primary' : 'muted'}
            variant={tab === 'new' ? 'solid' : 'outline'}
          />
          <Text> </Text>
          <Badge
            label={`${asciiMode ? '#' : '▤'} ${t(lang, '草稿箱', 'Drafts')} (${draftCount})`}
            tone={tab === 'drafts' ? 'primary' : 'muted'}
            variant={tab === 'drafts' ? 'solid' : 'outline'}
          />
          <Text color={theme.dim}>  [Tab]</Text>
          <Box flexGrow={1} />
          <Badge
            label={`${model.icon} ${model.provider}${model.model ? `${asciiMode ? ' - ' : ' · '}${model.model}` : ''}`}
            tone={model.ready ? 'success' : 'warning'}
            variant="soft"
          />
          {!model.ready ? (
            <Text color={theme.warning}>{t(lang, ' [S] 去设置', ' [S] Settings')}</Text>
          ) : null}
        </Box>
        {!model.ready && tab === 'new' ? (
          <Text color={theme.warning}>
            {`${asciiMode ? '!' : '⚠'} ${t(lang, '模型尚未就绪', 'Model not ready')}${model.reason ? `: ${model.reason}` : ''} ${asciiMode ? '-' : '—'} ${t(lang, '按 [S] 打开模型设置', 'Press [S] to configure')}`}
          </Text>
        ) : (
          <Text color={theme.dim}>
            {truncateDisplay(
              tab === 'new'
                ? t(
                    lang,
                    '勾选资料后 [Enter]/[Ctrl+S] 出题 · [S] 帮我想想 · [i] 录题',
                    'Select sources + [Enter]/[Ctrl+S] to generate · [S] AI Suggest · [i] Capture',
                  )
                : t(lang, '审核、修改或发布生成的题目草稿', 'Review, edit or publish generated drafts'),
              Math.max(12, width - 2),
              ell,
            )}
          </Text>
        )}
      </Box>

      {/* Inline Live Material Filter Bar */}
      {showFilterBar ? (
        <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
          <Text color={filterEditing ? theme.primary : theme.accent} bold>
            {filterBadge}
          </Text>
          <Box flexGrow={1} overflow="hidden">
            <TextInput
              value={filterQuery}
              onChange={(val) => {
                setFilterQuery(val);
                setSourceCursor(0);
              }}
              onSubmit={(val) => {
                if (!val.trim()) setFilterQuery('');
                setFilterEditing(false);
              }}
              onCancel={() => {
                setFilterQuery('');
                setFilterEditing(false);
                setSourceCursor(0);
              }}
              isActive={filterInputActive}
              width={filterInputW}
              prompt="/"
              placeholder={t(lang, `关键词${ell}`, `keyword${ell}`)}
              maxLength={120}
            />
          </Box>
          {filterRightHint ? (
            <Text color={theme.dim} wrap="truncate">
              {filterRightHint}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/* Body */}
      <Box height={bodyH} width={width}>
        {tab === 'drafts' ? (
          <Suspense
            fallback={
              <Box paddingX={1} paddingY={1}>
                <Spinner
                  label={asciiMode ? t(lang, '正在载入草稿编辑器...', 'Loading draft editor...') : t(lang, '正在载入草稿编辑器…', 'Loading draft editor…')}
                  active={isActive}
                />
              </Box>
            }
          >
            <DraftEditor
              host={host}
              initialDraftId={navContext.draftId}
              width={width}
              height={bodyH}
              isActive={isActive && tab === 'drafts' && overlay === 'none'}
            />
          </Suspense>
        ) : (
          <SplitPane
            width={width}
            height={bodyH}
            leftWidth={width < 86 ? 0.45 : 0.5}
            minLeft={24}
            minRight={38}
            breakpoint={68}
            leftLabel={t(lang, '选择资料', 'Sources')}
            rightLabel={t(lang, '出题参数 & 费用预估', 'Options & Estimate')}
            left={({ width: lw, height: lh }) => (
              <Panel
                title={t(lang, '1. 选择资料 (Space 勾选)', '1. Select Materials (Space)')}
                badge={`${effectiveSourceIds.length}p`}
                width={lw}
                height={lh}
                focused={wizardActive && !filterEditing}
              >
                {baseDocs.length === 0 ? (
                  <EmptyState
                    title={t(lang, '暂无可用资料', 'No materials')}
                    hint={t(lang, '请先前往「资料」页导入讲义或笔记', 'Import materials in Sources view first')}
                    width={Math.max(12, lw - 4)}
                    height={Math.max(4, lh - 2)}
                  />
                ) : filteredDocs.length === 0 ? (
                  <EmptyState
                    title={t(lang, '无匹配资料', 'No matching materials')}
                    hint={t(lang, '按 [Esc] 清除筛选，或 [/] 修改关键词', 'Press [Esc] to clear filter, or [/] to edit')}
                    width={Math.max(12, lw - 4)}
                    height={Math.max(4, lh - 2)}
                  />
                ) : (
                  <VirtualList
                    items={filteredDocs}
                    height={Math.max(1, lh - 2)}
                    width={Math.max(12, lw - 4)}
                    selectedIndex={sourceCursor}
                    onChange={(idx) => setSourceCursor(idx)}
                    onSelect={() => void handleSubmitGeneration()}
                    isActive={wizardActive && !filterEditing}
                    vimNavKeys={false}
                    keyExtractor={(d) => d.key}
                    renderItem={(doc, ctx) => {
                      const pickedCount = doc.sourceIds.filter((id) => selectedSourceIds.has(id)).length;
                      const check = asciiMode
                        ? pickedCount === doc.sourceIds.length
                          ? '[x]'
                          : pickedCount > 0
                            ? '[~]'
                            : '[ ]'
                        : pickedCount === doc.sourceIds.length
                          ? '☑'
                          : pickedCount > 0
                            ? '◐'
                            : '☐';
                      const fmt = formatLabel(doc.format);
                      const meta = `${doc.pageCount}p`;
                      const titleMax = Math.max(8, ctx.width - fmt.length - meta.length - (asciiMode ? 10 : 8));
                      return (
                        <Box flexDirection="row" width={ctx.width}>
                          <Text color={pickedCount > 0 ? theme.success : theme.muted}>{`${check} `}</Text>
                          <Text color={theme.accent}>{`[${fmt}] `}</Text>
                          <Text color={theme.text} bold={ctx.selected}>
                            {truncateDisplay(doc.title, titleMax, ell)}
                          </Text>
                          <Box flexGrow={1} />
                          <Text color={theme.dim}>{meta}</Text>
                        </Box>
                      );
                    }}
                  />
                )}
              </Panel>
            )}
            right={({ width: rw, height: rh }) => (
              <Panel
                title={t(lang, '2. 出题设置与预估', '2. Generation Settings')}
                width={rw}
                height={rh}
              >
                <Box flexDirection="column" width={Math.max(14, rw - 4)}>
                  <Text color={theme.muted}>
                    {t(lang, '[c] 课程归属: ', '[c] Course: ')}
                    <Text color={theme.text} bold>
                      {courseName || t(lang, '自动 / 全部', 'Auto / All')}
                    </Text>
                  </Text>

                  <Text color={theme.muted}>
                    {t(lang, '[p] 页码范围: ', '[p] Page Scope: ')}
                    <Text color={theme.text} bold>
                      {pageScope}
                    </Text>
                  </Text>

                  <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
                    <Text color={theme.muted}>{t(lang, '[k] 题型: ', '[k] Kind: ')}</Text>
                    <Badge
                      label={lang === 'en' ? selectedKind.en : selectedKind.zh}
                      tone="primary"
                    />
                  </Box>

                  <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
                    <Text color={theme.muted}>{t(lang, '[n] 目标题数: ', '[n] Count: ')}</Text>
                    {TARGET_COUNTS.map((cnt) => (
                      <Box key={cnt} marginRight={1}>
                        <Badge
                          label={cnt}
                          tone={cnt === targetCount ? 'accent' : 'muted'}
                          variant={cnt === targetCount ? 'solid' : 'outline'}
                        />
                      </Box>
                    ))}
                  </Box>

                  <Box marginTop={1} flexDirection="column">
                    <Text color={theme.muted}>{t(lang, '[f] 重点与额外指令:', '[f] Focus / Instructions:')}</Text>
                    <Text color={focusText ? theme.text : theme.dim}>
                      {focusText
                        ? truncateDisplay(focusText, Math.max(20, (rw - 4) * 2 - 4), ell)
                        : t(lang, '（无，按材料自动规划重点）', '(None — auto plan from materials)')}
                    </Text>
                    {weakTopics.length > 0
                      ? (() => {
                          const panelInnerW = Math.max(14, rw - 4);
                          const weakPrefix = `${t(lang, '薄弱点', 'Weak')}: `;
                          const weakSuffix = ` [${t(lang, 'W 填入', 'W Fill')}]`;
                          const topicMax = Math.max(6, panelInnerW - displayWidth(weakPrefix) - displayWidth(weakSuffix));
                          const line = `${weakPrefix}${truncateDisplay(weakTopics.slice(0, 3).join(', '), topicMax, ell)}${weakSuffix}`;
                          return (
                            <Text color={theme.warning}>
                              {truncateDisplay(line, panelInnerW, ell)}
                            </Text>
                          );
                        })()
                      : null}
                  </Box>

                  <Box marginTop={1} flexDirection="column">
                    <Text color={theme.primary} bold>
                      {t(lang, '用量与费用预估:', 'Token Estimate:')}
                    </Text>
                    {effectiveSourceIds.length === 0 ? (
                      <Text color={theme.dim}>{t(lang, '勾选左侧资料后自动估算', 'Select materials to estimate')}</Text>
                    ) : estimate.loading ? (
                      <Spinner label={asciiMode ? t(lang, '正在计算预估用量...', 'Estimating...') : t(lang, '正在计算预估用量…', 'Estimating…')} />
                    ) : estimate.tokensHigh ? (
                      <Text color={theme.info}>
                        {`${asciiMode ? '~' : '≈'} ${(estimate.tokensLow ?? 0).toLocaleString()}-${estimate.tokensHigh.toLocaleString()} tokens` +
                          (estimate.calls ? ` · ${estimate.calls} ${t(lang, '次调用', 'calls')}` : '')}
                      </Text>
                    ) : (
                      <Text color={theme.dim}>{estimate.note || t(lang, '约按所选文本长度动态规划', 'Planned dynamically by selected pages')}</Text>
                    )}
                  </Box>

                  <Box marginTop={1}>
                    {submitting ? (
                      <Spinner label={asciiMode ? t(lang, '正在提交后台出题任务...', 'Submitting generation job...') : t(lang, '正在提交后台出题任务…', 'Submitting generation job…')} />
                    ) : (
                      <Badge
                        label={t(lang, '按 [Enter] 或 [Ctrl+S] 开始出题', 'Press [Enter] or [Ctrl+S] to Generate')}
                        tone={model.ready && effectiveSourceIds.length > 0 ? 'success' : 'muted'}
                      />
                    )}
                  </Box>
                </Box>
              </Panel>
            )}
          />
        )}
      </Box>

      {/* Modals for scope / focus */}
      {overlay === 'scope' ? (
        <Modal
          title={t(lang, '设置页码范围', 'Page Scope')}
          width={56}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Enter', label: t(lang, '确定', 'Apply') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={theme.muted}>{t(lang, '输入 all 或页码范围（例如 1-5, 8）:', 'Enter "all" or page ranges (e.g. 1-5, 8):')}</Text>
          <Box marginTop={1}>
            <TextInput
              value={pageScope}
              onChange={setPageScope}
              onSubmit={() => setOverlay('none')}
              onCancel={() => setOverlay('none')}
              width={modalContentWidth(56) - 4}
              isActive={isActive}
              prompt={asciiMode ? '>' : '›'}
            />
          </Box>
        </Modal>
      ) : null}

      {overlay === 'focus' ? (
        <Modal
          title={t(lang, '自定义出题重点 / 要求', 'Custom Focus / Instructions')}
          width={68}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <TextInput
            value={focusText}
            onChange={setFocusText}
            onSubmit={() => setOverlay('none')}
            onCancel={() => setOverlay('none')}
            placeholder={t(lang, '例如：侧重计算题与易错概念辨析，解析给出推导步骤', 'e.g. Focus on numerical derivations and common misconceptions')}
            multiline
            height={4}
            width={modalContentWidth(68) - 4}
            isActive={isActive}
          />
        </Modal>
      ) : null}

      <Suspense fallback={null}>
        {overlay === 'ingest' ? (
          <IngestModal
            host={host}
            defaultCourse={courseName || currentCourse(snapshot)}
            isActive={isActive && overlay === 'ingest'}
            onClose={() => setOverlay('none')}
            onDone={refresh}
          />
        ) : null}
        {overlay === 'path' ? (
          <GeneratePathModal
            host={host}
            groups={allDocs}
            selectedSourceIds={selectedSourceIds}
            course={courseName || undefined}
            isActive={isActive && overlay === 'path'}
            onApplyStep={handleApplyPathStep}
            onClose={() => setOverlay('none')}
          />
        ) : null}
      </Suspense>

      {overlay === 'suggest-confirm' ? (
        <ConfirmDialog
          title={t(lang, 'AI 帮我想想', 'AI Study Focus Suggestion')}
          message={t(
            lang,
            `将发起 1 次轻量 AI 调用（仅发送已选 ${effectiveSourceIds.length} 份资料的标题/目录与薄弱知识点，不发送正文且不会立即出题），为你推荐出题重点。是否继续？`,
            `This will make 1 lightweight AI call over ${effectiveSourceIds.length} selected source title(s)/headings and weak topics to suggest a study focus (no cards generated yet). Continue?`,
          )}
          confirmLabel={t(lang, '开始分析', 'Suggest')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          width={62}
          isActive={isActive && overlay === 'suggest-confirm' && !suggestLoading}
          onConfirm={() => void handleRunSuggest()}
          onCancel={() => {
            if (!busyRef.current) setOverlay('none');
          }}
        />
      ) : null}

      {overlay === 'suggest-loading' ? (
        <Modal
          title={t(lang, 'AI 帮我想想', 'AI Study Focus Suggestion')}
          icon={asciiMode ? '*' : '✦'}
          width={56}
          isActive={isActive && overlay === 'suggest-loading'}
        >
          <Box paddingY={1}>
            <Spinner
              label={
                asciiMode
                  ? t(lang, '正在分析资料目录与薄弱知识点...', 'Analyzing source outlines and weak topics...')
                  : t(lang, '正在分析资料目录与薄弱知识点…', 'Analyzing source outlines and weak topics…')
              }
              active={isActive}
            />
          </Box>
        </Modal>
      ) : null}

      {overlay === 'suggest-result' && suggestResult
        ? (() => {
            const modalW = Math.min(70, Math.max(44, columns - 4));
            const innerW = modalContentWidth(modalW);
            const focusItems = Array.isArray(suggestResult.focus)
              ? suggestResult.focus.filter((item) => typeof item === 'string' && item.trim())
              : [];
            const kindMatch = suggestResult.kind ? QUESTION_KINDS.find((k) => k.id === suggestResult.kind) : undefined;
            const kindText = kindMatch ? (lang === 'en' ? kindMatch.en : kindMatch.zh) : suggestResult.kind || '';
            const recParts = [
              suggestResult.coverage
                ? `${t(lang, '覆盖', 'Coverage')}: ${formatCoverageLabel(suggestResult.coverage, lang)}`
                : '',
              suggestResult.difficulty
                ? `${t(lang, '难度', 'Difficulty')}: ${formatDifficultyLabel(suggestResult.difficulty, lang)}`
                : '',
              kindText ? `${t(lang, '题型', 'Kind')}: ${kindText}` : '',
            ].filter(Boolean);
            const sepDot = asciiMode ? ' | ' : ' · ';
            const unavailableMsg = formatUnavailableReason(suggestResult.unavailable, lang);
            const isModel = suggestResult.source === 'model';
            const canApply = focusItems.length > 0 || Boolean(kindMatch);
            const bullet = asciiMode ? '- ' : '• ';

            return (
              <Modal
                title={t(lang, 'AI 出题重点建议', 'AI Focus Suggestion')}
                subtitle={isModel ? t(lang, 'AI 推荐', 'AI') : t(lang, '本地回退', 'Local')}
                icon={asciiMode ? '*' : '✦'}
                tone={isModel ? 'primary' : 'warning'}
                width={modalW}
                isActive={isActive && overlay === 'suggest-result'}
                onClose={() => setOverlay('none')}
                hints={
                  canApply
                    ? [
                        { key: 'a', label: t(lang, '应用到出题设置', 'Apply to Form') },
                        { key: 'Esc', label: t(lang, '关闭', 'Close') },
                      ]
                    : [{ key: 'Esc', label: t(lang, '关闭', 'Close') }]
                }
              >
                <Box flexDirection="column" width={innerW}>
                  <Box flexDirection="row" alignItems="center">
                    <Badge
                      label={isModel ? t(lang, 'AI 推荐重点', 'AI Suggested Focus') : t(lang, '本地目录与错题建议', 'Local Outline & Weak-Topic Suggestion')}
                      tone={isModel ? 'success' : 'warning'}
                      variant="soft"
                    />
                    {suggestResult.basis ? (
                      <Text color={theme.dim}>
                        {`  ${suggestResult.basis.sources ?? 0} ${t(lang, '资料', 'src')}${sepDot}${suggestResult.basis.weakTopics ?? 0} ${t(lang, '薄弱点', 'weak')}`}
                      </Text>
                    ) : null}
                  </Box>

                  {unavailableMsg ? (
                    <Box marginTop={1}>
                      <Text color={theme.warning} wrap="wrap">
                        {truncateDisplay(unavailableMsg, Math.max(24, innerW * 2 - 4), ell)}
                      </Text>
                    </Box>
                  ) : null}

                  <Box marginTop={1} flexDirection="column">
                    <Text color={theme.primary} bold>
                      {t(lang, '推荐练习重点:', 'Recommended Focus:')}
                    </Text>
                    {focusItems.length === 0 ? (
                      <Text color={theme.dim}>
                        {t(lang, '（暂无可推荐重点，可先检查资料目录或补充练习记录）', '(No focus items available yet)')}
                      </Text>
                    ) : (
                      focusItems.map((item, idx) => (
                        <Text key={`${idx}-${item}`} color={theme.text}>
                          {`${bullet}${truncateDisplay(item, Math.max(12, innerW - 4), ell)}`}
                        </Text>
                      ))
                    )}
                  </Box>

                  {recParts.length > 0 ? (
                    <Box marginTop={1}>
                      <Text color={theme.accent} wrap="wrap">
                        {truncateDisplay(`${t(lang, '建议参数: ', 'Settings: ')}${recParts.join(sepDot)}`, Math.max(20, innerW * 2 - 4), ell)}
                      </Text>
                    </Box>
                  ) : null}

                  {suggestResult.why ? (
                    <Box marginTop={1}>
                      <Text color={theme.muted} wrap="wrap">
                        {truncateDisplay(`${t(lang, '建议依据: ', 'Reason: ')}${suggestResult.why}`, Math.max(24, innerW * 2 - 4), ell)}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              </Modal>
            );
          })()
        : null}
    </Box>
  );
});
