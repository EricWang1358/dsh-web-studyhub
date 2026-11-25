import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolve } from 'node:path';
import { Box, Text } from 'ink';
import { KEY_LAYER_MODAL } from '../../input/dispatcher.js';
import { KeyScope, useKeyScope } from '../../input/hooks.js';
import type { KeyHint, UiLanguage, ViewProps } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { currentCourse } from '../../shell/data.js';
import { useShellActions } from '../../shell/actions.js';
import { atomicWriteExportText, defaultBackupFilePath, todayLocalYmd } from '../../host/atomic-write.js';
import { tryAction, type ReviewRun } from '../../host/sample-actions.js';
import { toneColor, useTheme } from '../../theme/tokens.js';
import { Badge, EmptyState, Spinner } from '../../components/Badge.js';
import { computeProseLayout } from '../../components/Layout.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { SelectList, type SelectOption } from '../../components/SelectList.js';
import { SplitPane, type PaneSize } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { useInputCapture } from '../../components/focus.js';
import { LAYOUT_BP, computeFilterBarLayout } from '../../components/layout-tokens.js';
import { useFooterHints } from '../../components/hooks.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { renderProgressBar } from '../../render/charts.js';
import { buildFileHyperlinkUrl, formatOsc8Link } from '../../render/osc8.js';
import { buildTopWrongCluster } from './quick-triage.js';
import {
  ERROR_REASONS,
  REASON_FILTER_ORDER,
  TABS,
  buildDetailMarkdown,
  errorReasonMeta,
  gradeRatio,
  itemKey,
  plainSnippet,
  reasonLabel,
  reasonShort,
  relatedRecommendations,
  triageSummary,
  type ReasonFilterValue,
} from './helpers.js';
import type {
  ErrorReasonId,
  WrongBookDetail,
  WrongBookItem,
  WrongBookRecommendItem,
  WrongBookRecommendResponse,
  WrongBookResponse,
  WrongBookTab,
} from './types.js';

const PAGE_LIMIT = 100;
const MAX_FETCH_ITEMS = 300;
const PRACTICE_BATCH_CAP = 50;
const CLAIMED_KEYS: readonly string[] = Object.freeze(['t', 'e', 'p', 'o', 'f', 'm', ' ', 'B', 'V', 'x', 'X', '/', 'Q']);

export interface WrongBookExportOption {
  id?: string;
  text?: string;
  correct?: boolean;
  explanation?: string;
}

export interface WrongBookExportItem extends Partial<WrongBookItem> {
  options?: readonly WrongBookExportOption[];
  correctAnswer?: string;
  answer?: string;
  explanation?: string;
  misconception?: string;
  yourAnswer?: string | null;
  hint?: string;
  cloze?: {
    text?: string;
    answers?: Array<{ id?: string; value?: string }>;
  };
  detail?: WrongBookDetail | null;
}

export interface FormatWrongBookMarkdownParams {
  items: readonly WrongBookExportItem[];
  course?: string | null;
  lang: UiLanguage;
  generatedAt?: Date | string;
}

function formatGeneratedDate(generatedAt?: Date | string): string {
  if (typeof generatedAt === 'string' && generatedAt.trim()) {
    return generatedAt.trim();
  }
  const d = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${todayLocalYmd(d)} ${hh}:${mm}`;
}

function optionMarker(opt: WrongBookExportOption, idx: number): string {
  const rawId = String(opt.id ?? '').trim();
  if (rawId) {
    return /^[a-z]$/i.test(rawId) ? rawId.toUpperCase() : rawId;
  }
  return String.fromCharCode(65 + (idx % 26));
}

function resolveExportAnswer(item: WrongBookExportItem): string {
  if (item.correctAnswer && item.correctAnswer.trim()) return item.correctAnswer.trim();
  if (item.detail?.correctAnswer && item.detail.correctAnswer.trim()) return item.detail.correctAnswer.trim();
  if (Array.isArray(item.options) && item.options.some((o) => o?.correct)) {
    return item.options
      .filter((o) => o?.correct)
      .map((o, idx) => {
        const label = optionMarker(o, idx);
        const text = String(o.text ?? '').trim();
        return text ? `${label}. ${text}` : label;
      })
      .join('; ');
  }
  const clozeAnswers = item.cloze?.answers ?? item.detail?.cloze?.answers;
  if (Array.isArray(clozeAnswers) && clozeAnswers.length > 0) {
    return clozeAnswers.map((a) => String(a?.value ?? '').trim()).filter(Boolean).join('; ');
  }
  if (typeof item.answer === 'string' && item.answer.trim()) return item.answer.trim();
  return '';
}

/** Format wrong-book cards into a printable Markdown study sheet with collapsible answers. */
export function formatWrongBookMarkdown({
  items,
  course,
  lang,
  generatedAt,
}: FormatWrongBookMarkdownParams): string {
  const list = Array.isArray(items) ? items : [];
  const dateStr = formatGeneratedDate(generatedAt);
  const courseLabel = course && course.trim() ? course.trim() : t(lang, '全部课程', 'All Courses');

  const lines: string[] = [
    `# ${t(lang, '错题复习卷', 'Wrong-Book Study Sheet')}`,
    '',
    `- **${t(lang, '生成日期', 'Generated')}**: ${dateStr}`,
    `- **${t(lang, '课程筛选', 'Course')}**: ${courseLabel}`,
    `- **${t(lang, '错题数量', 'Cards')}**: ${list.length}`,
    '',
    '---',
  ];

  if (list.length === 0) {
    lines.push('', t(lang, '_当前没有可导出的错题。_', '_No wrong cards to export._'), '');
    return lines.join('\n');
  }

  list.forEach((item, idx) => {
    const detail = item.detail ?? null;
    const topic = (item.topic || '').trim();
    const deckTitle = (item.deckTitle || item.deckId || '-').trim();
    const kind = (item.kind || detail?.kind || '-').trim();
    const wrongCount = item.wrongCount ?? 1;
    const reasonText = item.errorReason ? reasonLabel(item.errorReason, lang) : '';

    const headingTitle = topic
      ? `${idx + 1}. ${topic}`
      : `${idx + 1}. ${t(lang, `错题 #${idx + 1}`, `Question #${idx + 1}`)}`;

    const metaParts = [
      `${t(lang, '题组', 'Deck')}: ${deckTitle}`,
      `${t(lang, '题型', 'Kind')}: ${kind}`,
      `${t(lang, '出错次数', 'Mistakes')}: ${wrongCount}`,
    ];
    if (topic) metaParts.unshift(`${t(lang, '主题', 'Topic')}: ${topic}`);
    if (reasonText) metaParts.push(`${t(lang, '错因', 'Reason')}: ${reasonText}`);

    const promptText = (
      detail?.prompt ||
      item.prompt ||
      item.cloze?.text ||
      detail?.cloze?.text ||
      t(lang, '（无题干）', '(No prompt)')
    ).trim();

    lines.push('', `## ${headingTitle}`, '', `> ${metaParts.join(' | ')}`, '', promptText);

    const rawOptions: readonly WrongBookExportOption[] = Array.isArray(item.options) ? item.options : [];
    const options = rawOptions.filter((o) => Boolean(o && (o.text || o.id)));
    if (options.length > 0) {
      lines.push('');
      options.forEach((opt, optIdx) => {
        const marker = optionMarker(opt, optIdx);
        lines.push(`- **${marker}.** ${String(opt.text ?? '').trim()}`);
      });
    }

    const answerText = resolveExportAnswer(item);
    const explanationText = (item.explanation || detail?.explanation || '').trim();
    const misconceptionText = (item.misconception || detail?.misconception || '').trim();
    const yourAnswerText = (item.yourAnswer ?? detail?.yourAnswer ?? '').trim();

    lines.push(
      '',
      '<details>',
      '<summary>参考答案与解析 / Answer & Explanation</summary>',
      '',
    );

    if (answerText) {
      lines.push(`- **${t(lang, '参考答案', 'Reference Answer')}**: ${answerText}`);
    }
    if (yourAnswerText) {
      lines.push(`- **${t(lang, '最近作答', 'Your Answer')}**: ${yourAnswerText}`);
    }
    if (explanationText) {
      lines.push('', `**${t(lang, '解析', 'Explanation')}**:`, '', explanationText);
    }
    if (misconceptionText) {
      lines.push('', `**${t(lang, '常见误区', 'Common Misconception')}**: ${misconceptionText}`);
    }
    if (detail?.distractorExplanations?.length) {
      lines.push('', `**${t(lang, '干扰项分析', 'Distractor Analysis')}**:`);
      for (const d of detail.distractorExplanations) {
        lines.push(`- **${d.text}**: ${d.explanation}`);
      }
    }
    if (!answerText && !explanationText && !misconceptionText) {
      lines.push(t(lang, '_暂无参考答案与解析。_', '_No reference answer or explanation recorded._'));
    }

    lines.push('', '</details>', '', '---');
  });

  lines.push('');
  return lines.join('\n');
}

function cardSelectionKey(item: Pick<WrongBookItem, 'deckId' | 'cardId'>): string {
  return `${item.deckId}\0${item.cardId}`;
}

type ActiveModal = 'reason' | 'confusable' | 'flag' | null;

async function fetchViewItems(
  host: ViewProps['host'],
  course: string | null,
  view: 'weak' | 'history',
): Promise<{ items: WrongBookItem[]; counts: { weak: number; history: number }; error?: string }> {
  const scope = course ? { course } : { course: '*' };
  const first = await tryAction<WrongBookResponse>(host, 'wrongbook', {
    ...scope,
    view,
    offset: 0,
    limit: PAGE_LIMIT,
  });
  if (!first.ok || !first.value) {
    return { items: [], counts: { weak: 0, history: 0 }, error: first.error?.message };
  }
  const rawFirst = Array.isArray(first.value.items) ? first.value.items : [];
  const collected: WrongBookItem[] = rawFirst
    .filter((x) => x && x.deckId && x.cardId && !x.suspended)
    .map((x) => ({ ...x, _view: view }));

  const total = Math.min(MAX_FETCH_ITEMS, Number(first.value.total ?? collected.length) || 0);
  let offset = rawFirst.length;
  while (offset < total && rawFirst.length > 0) {
    const next = await tryAction<WrongBookResponse>(host, 'wrongbook', {
      ...scope,
      view,
      offset,
      limit: PAGE_LIMIT,
    });
    if (!next.ok || !next.value?.items?.length) break;
    for (const x of next.value.items) {
      if (x && x.deckId && x.cardId && !x.suspended) {
        collected.push({ ...x, _view: view });
      }
    }
    offset += next.value.items.length;
  }

  return {
    items: collected,
    counts: {
      weak: Number(first.value.counts?.weak ?? (view === 'weak' ? collected.length : 0)) || 0,
      history: Number(first.value.counts?.history ?? (view === 'history' ? collected.length : 0)) || 0,
    },
  };
}

export const WrongBookView: React.FC<ViewProps> = memo(function WrongBookView({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const snapshot = useTuiStore((s) => s.snapshot);
  const bindingRoot = useTuiStore((s) => s.binding?.root);
  const snapshotRoot = useTuiStore((s) => s.snapshot?.root);
  const notify = useTuiStore((s) => s.notify);
  const navigate = useTuiStore((s) => s.navigate);
  const setActiveRunId = useTuiStore((s) => s.setActiveRunId);
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const { refresh: refreshSnapshot } = useShellActions();
  const course = currentCourse(snapshot);

  const [tab, setTab] = useState<WrongBookTab>('weak');
  const [reasonFilter, setReasonFilter] = useState<ReasonFilterValue>('all');
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [flagText, setFlagText] = useState('');
  const [detailScrollTop, setDetailScrollTop] = useState(0);

  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [weakItems, setWeakItems] = useState<WrongBookItem[]>([]);
  const [historyItems, setHistoryItems] = useState<WrongBookItem[]>([]);
  const [counts, setCounts] = useState<{ weak: number; history: number }>({ weak: 0, history: 0 });
  const [recs, setRecs] = useState<WrongBookRecommendItem[]>([]);

  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<WrongBookDetail | null>(null);
  const [selectedMap, setSelectedMap] = useState<Map<string, { deckId: string; cardId: string }>>(() => new Map());

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const exportBusyRef = useRef(false);
  const listSeqRef = useRef(0);
  const detailSeqRef = useRef(0);
  const detailCacheRef = useRef<Map<string, WrongBookDetail>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadWrongBook = useCallback(
    async (silent = false) => {
      const seq = ++listSeqRef.current;
      if (!silent) setLoading(true);
      setLoadError(null);
      const recScope = course ? { course } : { course: '*' };

      const [weakRes, historyRes, recRes] = await Promise.all([
        fetchViewItems(host, course, 'weak'),
        fetchViewItems(host, course, 'history'),
        tryAction<WrongBookRecommendResponse>(host, 'wrongbook.recommend', { ...recScope, limit: 15 }),
      ]);

      if (!mountedRef.current || seq !== listSeqRef.current) return;
      if (weakRes.error && !weakRes.items.length) {
        setLoadError(weakRes.error);
      }
      setWeakItems(weakRes.items);
      setHistoryItems(historyRes.items);
      setCounts({
        weak: weakRes.counts.weak || weakRes.items.length,
        history: weakRes.counts.history || historyRes.items.length,
      });
      setRecs(recRes.ok && Array.isArray(recRes.value?.items) ? recRes.value.items : []);
      setSelectedMap((prev) => {
        if (prev.size === 0) return prev;
        const valid = new Set<string>();
        for (const item of weakRes.items) valid.add(cardSelectionKey(item));
        for (const item of historyRes.items) valid.add(cardSelectionKey(item));
        let changed = false;
        const next = new Map(prev);
        for (const k of next.keys()) {
          if (!valid.has(k)) {
            next.delete(k);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      detailCacheRef.current.clear();
      setLoading(false);
    },
    [host, course],
  );

  useEffect(() => {
    void loadWrongBook(false);
  }, [loadWrongBook]);

  // Combined + filtered items according to active tab and reason sub-filter
  const allItems = useMemo<WrongBookItem[]>(() => {
    const seen = new Set<string>();
    const out: WrongBookItem[] = [];
    for (const item of weakItems) {
      const k = `${item.deckId}:${item.cardId}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
    }
    for (const item of historyItems) {
      const k = `${item.deckId}:${item.cardId}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
    }
    return out;
  }, [weakItems, historyItems]);

  const confusableItems = useMemo(
    () => weakItems.filter((item) => item.triage?.route === 'confusable_contrast'),
    [weakItems],
  );

  const tabItems = useMemo<WrongBookItem[]>(() => {
    if (tab === 'weak') return weakItems;
    if (tab === 'confusable') return confusableItems;
    if (tab === 'all') return allItems;
    // 'reason' tab: filter weakItems (or allItems if weak has none for that reason) and sort by errorReason
    const pool = weakItems.length ? weakItems : allItems;
    const filtered =
      reasonFilter === 'all'
        ? pool
        : reasonFilter === 'unclassified'
          ? pool.filter((x) => !x.errorReason)
          : pool.filter((x) => x.errorReason === reasonFilter);
    return [...filtered].sort((a, b) => {
      const ra = a.errorReason ?? 'zzz';
      const rb = b.errorReason ?? 'zzz';
      if (ra !== rb) return ra.localeCompare(rb);
      return String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? ''));
    });
  }, [tab, weakItems, confusableItems, allItems, reasonFilter]);

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const visibleItems = useMemo<WrongBookItem[]>(() => {
    if (!normalizedFilter) return tabItems;
    return tabItems.filter((item) => {
      const meta = errorReasonMeta(item.errorReason);
      const itemCourse = (item as WrongBookItem & { course?: string }).course ?? item.triage?.course ?? course ?? '';
      const haystack = [
        item.prompt,
        item.topic,
        item.deckTitle,
        item.errorReason,
        meta?.zh,
        meta?.en,
        itemCourse,
        item.cardId,
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      return haystack.includes(normalizedFilter);
    });
  }, [tabItems, normalizedFilter, course]);

  const clampedSelectedIdx =
    visibleItems.length === 0 ? 0 : Math.max(0, Math.min(selectedIdx, visibleItems.length - 1));

  useEffect(() => {
    setSelectedIdx((idx) => Math.max(0, Math.min(idx, Math.max(0, visibleItems.length - 1))));
  }, [visibleItems.length]);

  const selectedItem = visibleItems[clampedSelectedIdx] ?? null;
  const selectedKey = selectedItem ? itemKey(selectedItem) : '';

  // Load detail for currently selected card with cache + cancel guard
  useEffect(() => {
    setDetailScrollTop(0);
    if (!selectedItem) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const cached = detailCacheRef.current.get(selectedKey);
    if (cached) {
      setDetail(cached);
      setDetailLoading(false);
      return;
    }
    const seq = ++detailSeqRef.current;
    setDetail(null);
    setDetailLoading(true);
    void tryAction<WrongBookDetail>(host, 'wrongbook.detail', {
      deckId: selectedItem.deckId,
      cardId: selectedItem.cardId,
      view: selectedItem._view,
    }).then((res) => {
      if (!mountedRef.current || seq !== detailSeqRef.current) return;
      if (res.ok && res.value) {
        if (detailCacheRef.current.size > 150) {
          const oldest = detailCacheRef.current.keys().next().value;
          if (oldest !== undefined) detailCacheRef.current.delete(oldest);
        }
        detailCacheRef.current.set(selectedKey, res.value);
        setDetail(res.value);
      }
      setDetailLoading(false);
    });
  }, [host, selectedItem, selectedKey]);

  const relatedRecs = useMemo(
    () => (selectedItem ? relatedRecommendations(recs, selectedItem.cardId) : []),
    [recs, selectedItem],
  );

  const triageInfo = useMemo(
    () => (selectedItem ? triageSummary(selectedItem, lang) : null),
    [selectedItem, lang],
  );

  const detailMarkdown = useMemo(
    () => (selectedItem ? buildDetailMarkdown(selectedItem, detail, relatedRecs, lang) : ''),
    [selectedItem, detail, relatedRecs, lang],
  );

  const launchPractice = useCallback(
    async (scope: Array<{ deckId: string; cardId: string }>, emptyMsg?: string) => {
      if (busyRef.current || busyAction) return;
      if (!scope.length) {
        notify(emptyMsg || t(lang, '当前没有可练习的题目', 'No cards available to practise'), 'warning');
        return;
      }
      busyRef.current = true;
      setBusyAction(true);
      const res = await tryAction<ReviewRun>(host, 'review.start', {
        mode: 'path',
        scope: scope.slice(0, PRACTICE_BATCH_CAP),
        fresh: true,
      });
      if (!mountedRef.current) {
        busyRef.current = false;
        return;
      }
      busyRef.current = false;
      setBusyAction(false);
      if (!res.ok || !res.value?.id) {
        notify(res.error?.message || t(lang, '启动练习失败', 'Failed to start practice'), 'error');
        return;
      }
      navigate('review', { runId: res.value.id });
    },
    [busyAction, host, lang, navigate, notify],
  );

  const handleVariantPractice = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction(true);
    try {
      const originCardIds =
        selectedMap.size > 0
          ? Array.from(selectedMap.values()).map((x) => x.cardId)
          : selectedItem
            ? [selectedItem.cardId]
            : [];
      const res = await tryAction<{ id: string }>(
        host,
        'coach.practice',
        originCardIds.length > 0 ? { originCardIds } : {},
      );
      if (!mountedRef.current) return;
      if (!res.ok || !res.value?.id) {
        const msg = res.error?.message || '';
        const noReady =
          !msg ||
          msg.includes('还没有备好的定制题') ||
          msg.toLowerCase().includes('no custom question is ready') ||
          msg.toLowerCase().includes('no ready');
        notify(
          noReady
            ? t(
                lang,
                '无变式; 考试教练(9)[g]生成',
                'No variants; ExamCoach(9)[g]',
              )
            : msg,
          noReady ? 'info' : 'error',
        );
        return;
      }
      setActiveRunId(res.value.id);
      await refreshSnapshot();
      if (!mountedRef.current) return;
      navigate('review', { runId: res.value.id });
      notify(t(lang, '已开启错题变式专练', 'Started mistake variant practice'), 'success');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(false);
    }
  }, [host, lang, navigate, notify, refreshSnapshot, selectedItem, selectedMap, setActiveRunId]);

  const setErrorReason = useCallback(
    async (reason: ErrorReasonId | null) => {
      if (!selectedItem || busyAction) return;
      setBusyAction(true);
      const res = await tryAction(host, 'attempt.errorReason.set', {
        deckId: selectedItem.deckId,
        cardId: selectedItem.cardId,
        errorReason: reason,
      });
      if (!mountedRef.current) return;
      setBusyAction(false);
      setActiveModal(null);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '更新错因失败', 'Failed to update error reason'), 'error');
        return;
      }
      notify(
        reason
          ? t(lang, `已标记错因：${reasonLabel(reason, lang)}`, `Reason set: ${reasonLabel(reason, lang)}`)
          : t(lang, '已清除错因标记', 'Error reason cleared'),
        'success',
      );
      await loadWrongBook(true);
    },
    [selectedItem, busyAction, host, lang, notify, loadWrongBook],
  );

  const submitFlagRepair = useCallback(
    async (reasonTextValue: string) => {
      if (!selectedItem || busyAction) return;
      const reason = reasonTextValue.trim();
      setBusyAction(true);
      const res = await tryAction(host, 'card.flag', {
        deckId: selectedItem.deckId,
        cardId: selectedItem.cardId,
        reason,
      });
      if (!mountedRef.current) return;
      setBusyAction(false);
      setActiveModal(null);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '提交修题标记失败', 'Failed to flag card'), 'error');
        return;
      }
      notify(t(lang, '已标记题目待修题核查', 'Question flagged for repair'), 'success');
    },
    [selectedItem, busyAction, host, lang, notify],
  );

  const executeTriageAction = useCallback(() => {
    if (!selectedItem || !triageInfo) return;
    const triage = selectedItem.triage;
    switch (triageInfo.route) {
      case 'confusable_contrast':
        setActiveModal('confusable');
        return;
      case 'book_retell':
        navigate('book', {
          course: triage?.course || course || undefined,
          deckId: selectedItem.deckId,
          ...(triage?.hid || selectedItem.hid ? { focusPointKey: triage?.hid || selectedItem.hid } : {}),
        });
        return;
      case 'prereq_branch': {
        const refs = triage?.prereqRefs?.length
          ? triage.prereqRefs.map((r) => ({ deckId: r.deckId, cardId: r.cardId }))
          : triage?.prereq
            ? [{ deckId: triage.prereq.deckId, cardId: triage.prereq.cardId }]
            : [];
        void launchPractice(refs, t(lang, '没有找到未稳的前置题', 'No unresolved prerequisites found'));
        return;
      }
      case 'fix_question':
        setFlagText(t(lang, '题干或答案表述存疑，需要修题核查', 'Question stem or answer needs review'));
        setActiveModal('flag');
        return;
      default:
        void launchPractice([{ deckId: selectedItem.deckId, cardId: selectedItem.cardId }]);
    }
  }, [selectedItem, triageInfo, navigate, course, launchPractice, lang]);

  const cycleTab = useCallback((dir: 1 | -1) => {
    setTab((cur) => {
      const idx = TABS.findIndex((x) => x.id === cur);
      return TABS[(idx + dir + TABS.length) % TABS.length].id;
    });
    setSelectedIdx(0);
  }, []);

  const cycleReasonFilter = useCallback(() => {
    setReasonFilter((cur) => {
      const idx = REASON_FILTER_ORDER.indexOf(cur);
      return REASON_FILTER_ORDER[(idx + 1) % REASON_FILTER_ORDER.length];
    });
    setSelectedIdx(0);
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    if (exportBusyRef.current) return;
    const sourceItems: WrongBookItem[] =
      selectedMap.size > 0
        ? (() => {
            const picked = visibleItems.filter((item) => selectedMap.has(cardSelectionKey(item)));
            if (picked.length === selectedMap.size) return picked;
            const seen = new Set(picked.map((x) => cardSelectionKey(x)));
            const rest = allItems.filter(
              (item) => selectedMap.has(cardSelectionKey(item)) && !seen.has(cardSelectionKey(item)),
            );
            return [...picked, ...rest];
          })()
        : visibleItems;

    if (sourceItems.length === 0) {
      notify(t(lang, '当前没有可导出的错题', 'No wrong cards to export'), 'info');
      return;
    }

    exportBusyRef.current = true;
    try {
      const enriched: WrongBookExportItem[] = [];
      const CHUNK = 8;
      for (let i = 0; i < sourceItems.length; i += CHUNK) {
        const slice = sourceItems.slice(i, i + CHUNK);
        const chunkRes = await Promise.all(
          slice.map(async (item): Promise<WrongBookExportItem> => {
            const k = itemKey(item);
            let itemDetail = detailCacheRef.current.get(k) ?? null;
            const [detailRes, cardRes] = await Promise.all([
              itemDetail
                ? Promise.resolve(null)
                : tryAction<WrongBookDetail>(host, 'wrongbook.detail', {
                    deckId: item.deckId,
                    cardId: item.cardId,
                    view: item._view,
                  }),
              tryAction<{
                card?: {
                  options?: WrongBookExportOption[];
                  answer?: string;
                  explanation?: string;
                  misconception?: string;
                  hint?: string;
                  cloze?: { text?: string; answers?: Array<{ id?: string; value?: string }> };
                };
              }>(host, 'card.get', {
                deckId: item.deckId,
                cardId: item.cardId,
              }),
            ]);
            if (detailRes && detailRes.ok && detailRes.value) {
              itemDetail = detailRes.value;
              if (mountedRef.current) {
                detailCacheRef.current.set(k, detailRes.value);
              }
            }
            const card = cardRes.ok ? cardRes.value?.card : undefined;
            return {
              ...item,
              options: Array.isArray(card?.options) ? card.options : undefined,
              answer: card?.answer,
              explanation: itemDetail?.explanation || card?.explanation,
              misconception: itemDetail?.misconception || card?.misconception,
              hint: card?.hint,
              cloze: card?.cloze ?? itemDetail?.cloze,
              correctAnswer: itemDetail?.correctAnswer,
              yourAnswer: itemDetail?.yourAnswer,
              detail: itemDetail,
            };
          }),
        );
        enriched.push(...chunkRes);
      }

      const markdown = formatWrongBookMarkdown({
        items: enriched,
        course,
        lang,
        generatedAt: new Date(),
      });

      const rawRoot =
        bindingRoot?.trim() ||
        host.getLibraryRoot?.()?.trim() ||
        host.getConfig?.()?.libraryRoot?.trim() ||
        snapshotRoot?.trim() ||
        '';
      const baseDir = rawRoot ? resolve(rawRoot) : process.cwd();
      const exportLabel = course || (selectedMap.size > 0 ? `selected-${selectedMap.size}` : undefined);
      const defaultPath = defaultBackupFilePath(baseDir, 'studyhub-wrongbook', 'md', exportLabel);

      const written = await atomicWriteExportText(defaultPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(
          lang,
          `已导出 ${enriched.length} 道错题 ${arrow} ${written.path}`,
          `Exported ${enriched.length} wrong card(s) ${arrow} ${written.path}`,
        ),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      notify(t(lang, `导出错题失败：${msg}`, `Failed to export wrong cards: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [allItems, asciiMode, bindingRoot, course, host, lang, notify, selectedMap, snapshotRoot, visibleItems]);

  useInputCapture(isActive && filterEditing && activeModal === null);

  const footerHints: KeyHint[] = useMemo(() => {
    if (selectedMap.size > 0) {
      return [
        { key: 'Space', label: t(lang, '勾选', 'Select') },
        { key: 'B', label: t(lang, `练已选(${selectedMap.size})`, `Batch(${selectedMap.size})`) },
        { key: 'V', label: t(lang, '变式练', 'Variants') },
        { key: 'X', label: t(lang, '导出错题', 'Export MD') },
        { key: 'x', label: t(lang, '清空', 'Clear') },
        { key: 'e', label: t(lang, '标错因', 'Reason') },
        { key: 't', label: t(lang, '分流处理', 'Triage') },
        { key: '/', label: t(lang, '筛选', 'Filter') },
      ];
    }
    if (tab === 'reason') {
      return [
        { key: 'Tab/h/l', label: t(lang, '切换分组', 'Tabs') },
        { key: 'f', label: t(lang, '筛选错因', 'Filter') },
        { key: 'e', label: t(lang, '标错因', 'Reason') },
        { key: 't', label: t(lang, '分流处理', 'Triage') },
        { key: 'V', label: t(lang, '变式练', 'Variants') },
        { key: 'X', label: t(lang, '导出错题', 'Export MD') },
        { key: 'Enter/p', label: t(lang, '重练', 'Practise') },
        { key: '/', label: t(lang, '筛选', 'Filter') },
      ];
    }
    return [
      { key: 'Tab/h/l', label: t(lang, '切换标签', 'Tabs') },
      { key: 'Space', label: t(lang, '多选', 'Select') },
      { key: 'e', label: t(lang, '标错因', 'Reason') },
      { key: 't', label: t(lang, '分流处理', 'Triage') },
      { key: 'Enter/p', label: t(lang, '重练', 'Practise') },
      { key: 'P', label: t(lang, '批量练', 'Batch') },
      { key: 'V', label: t(lang, '变式练', 'Variants') },
      { key: 'X', label: t(lang, '导出错题', 'Export MD') },
      { key: 'x', label: t(lang, '同类题', 'Similar') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
    ];
  }, [lang, tab, selectedMap.size]);

  const narrowLayout = width < LAYOUT_BP.COMPACT;

  const pageActive = useKeyScope({
    id: 'WrongBookView:main',
    active: isActive,
    keys: CLAIMED_KEYS,
    onKey: (input, key) => {
      if (key.tab) {
        cycleTab(key.shift ? -1 : 1);
        return true;
      }
      if (input === 'h') {
        cycleTab(-1);
        return true;
      }
      if (input === 'l') {
        cycleTab(1);
        return true;
      }
      if (key.rightArrow) {
        setActivePane('right');
        return true;
      }
      if (key.leftArrow || (key.escape && narrowLayout && activePane === 'right')) {
        setActivePane('left');
        return true;
      }
      if (key.escape && filterQuery) {
        setFilterQuery('');
        setSelectedIdx(0);
        return true;
      }
      if (input === '/' && !key.ctrl && !key.meta) {
        setActivePane('left');
        setFilterEditing(true);
        return true;
      }
      if (input === 'R') {
        void loadWrongBook(false);
        return true;
      }
      if (input === 'm') {
        setPreferences({ mathUnicode: !mathUnicode });
        return true;
      }
      if (input === 'f') {
        if (tab !== 'reason') setTab('reason');
        cycleReasonFilter();
        return true;
      }
      if (input === 'J') {
        setDetailScrollTop((top) => top + 4);
        return true;
      }
      if (input === 'K') {
        setDetailScrollTop((top) => Math.max(0, top - 4));
        return true;
      }
      if (input === 'B') {
        if (selectedMap.size === 0) {
          notify(t(lang, '请先按 [Space] 勾选要练习的错题', 'Press [Space] to select cards first'), 'warning');
          return true;
        }
        void launchPractice(Array.from(selectedMap.values()));
        return true;
      }
      if (input === 'x' && selectedMap.size > 0) {
        setSelectedMap(new Map());
        return true;
      }
      if (input === 'P') {
        const batch = visibleItems.map((x) => ({ deckId: x.deckId, cardId: x.cardId }));
        void launchPractice(batch);
        return true;
      }
      if (input === 'V') {
        void handleVariantPractice();
        return true;
      }
      if (input === 'X') {
        void handleExportMarkdown();
        return true;
      }
      if (!selectedItem) return false;
      if (input === ' ' && activePane === 'left') {
        const selKey = cardSelectionKey(selectedItem);
        setSelectedMap((prev) => {
          const next = new Map(prev);
          if (next.has(selKey)) {
            next.delete(selKey);
          } else {
            if (next.size >= PRACTICE_BATCH_CAP) {
              notify(
                t(lang, `最多同时勾选 ${PRACTICE_BATCH_CAP} 题`, `Up to ${PRACTICE_BATCH_CAP} cards can be selected`),
                'warning',
              );
              return prev;
            }
            next.set(selKey, { deckId: selectedItem.deckId, cardId: selectedItem.cardId });
          }
          return next;
        });
        return true;
      }
      if (input === 'p' || (key.return && (!narrowLayout || activePane === 'right'))) {
        void launchPractice([{ deckId: selectedItem.deckId, cardId: selectedItem.cardId }]);
        return true;
      }
      if (input === 'e') {
        setActiveModal('reason');
        return true;
      }
      if (input === 't') {
        executeTriageAction();
        return true;
      }
      if (input === 'x') {
        const scope = relatedRecs.length
          ? relatedRecs.map((r) => ({ deckId: r.deckId, cardId: r.cardId }))
          : recs.slice(0, 10).map((r) => ({ deckId: r.deckId, cardId: r.cardId }));
        void launchPractice(scope, t(lang, '暂无推荐同类题', 'No recommended similar cards'));
        return true;
      }
      if (input === 'o') {
        const cit = selectedItem.citations?.find((c) => c?.sourceId);
        if (cit?.sourceId) {
          navigate('sources', {
            sourceId: cit.sourceId,
            ...(cit.page != null ? { pageNumber: cit.page } : {}),
          });
        } else {
          notify(t(lang, '该题暂无关联原文页码', 'No source citation for this question'), 'info');
        }
        return true;
      }
      if (input === 'Q') {
        const cluster = buildTopWrongCluster(visibleItems, lang);
        if (!cluster) {
          notify(t(lang, '当前列表暂无 >=2 题的高频错题聚类', 'Need >=2 related wrong cards for quick cluster drill'), 'info');
        } else {
          void tryAction<ReviewRun>(host, 'review.start', { mode: 'path', scope: cluster.scope, fresh: true }).then((res) => {
            if (res.ok && res.value?.id) {
              navigate('review', { runId: res.value.id });
            } else {
              notify(res.error?.message || t(lang, '启动高频错题练习失败', 'Failed to start cluster drill'), 'error');
            }
          });
        }
        return true;
      }
      return false;
    },
  });

  useFooterHints(footerHints, pageActive);

  // Compute header & split layout heights
  const showFilterBar = filterEditing || filterQuery.length > 0;
  const headerRows = (tab === 'reason' ? 3 : 2) + (showFilterBar ? 1 : 0);
  const bodyHeight = Math.max(6, height - headerRows);

  const renderListItem = useCallback(
    (item: WrongBookItem, ctx: VirtualListRenderContext) => {
      const ell = asciiMode ? '...' : '…';
      const isChecked = selectedMap.has(cardSelectionKey(item));
      const checkMark = selectedMap.size > 0 ? (isChecked ? (asciiMode ? '[x] ' : '[✓] ') : '[ ] ') : '';
      const reasonMeta = errorReasonMeta(item.errorReason);
      const reasonTag = reasonMeta ? `[${reasonShort(item.errorReason, lang)}]` : '';
      const errTag = `${asciiMode ? 'x' : '×'}${item.wrongCount ?? 1}`;
      const bar = renderProgressBar(gradeRatio(item.lastGrade), 5, theme, {
        style: 'block',
        showPercent: false,
        ascii: asciiMode,
        color: (item.lastGrade ?? 0) >= 3 ? theme.success : item.leech ? theme.error : theme.warning,
      });
      const prefix = asciiMode
        ? item._view === 'history'
          ? '+ '
          : item.leech
            ? '! '
            : '* '
        : item._view === 'history'
          ? '✓ '
          : item.leech
            ? '◆ '
            : '• ';
      const rightMeta = `${errTag}${reasonTag ? ` ${reasonTag}` : ''} `;
      const fixedW = displayWidth(checkMark) + displayWidth(prefix) + displayWidth(rightMeta) + 5;
      const snippetW = Math.max(6, ctx.width - fixedW);
      const snippet = truncateDisplay(plainSnippet(item.prompt) || item.topic || item.cardId, snippetW, ell);
      const padW = Math.max(
        1,
        ctx.width - displayWidth(checkMark) - displayWidth(prefix) - displayWidth(snippet) - displayWidth(rightMeta) - 5,
      );

      return (
        <Box width={ctx.width} height={1} overflow="hidden">
          {checkMark ? (
            <Text color={ctx.selected ? theme.selectionFg : isChecked ? theme.success : theme.muted} bold={isChecked}>
              {checkMark}
            </Text>
          ) : null}
          <Text color={item._view === 'history' ? theme.success : item.leech ? theme.error : theme.warning} bold={ctx.selected}>
            {prefix}
          </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
            {snippet}
          </Text>
          <Text>{' '.repeat(padW)}</Text>
          <Text color={item.wrongCount && item.wrongCount >= 3 ? theme.error : theme.muted}>{errTag}</Text>
          {reasonTag ? (
            <Text color={toneColor(theme, reasonMeta?.tone ?? 'muted')}>{` ${reasonTag}`}</Text>
          ) : null}
          <Text>{' '}</Text>
          <Text>{bar}</Text>
        </Box>
      );
    },
    [lang, asciiMode, theme, selectedMap],
  );

  const leftListActive = pageActive && activePane === 'left';
  const detailScrollActive = pageActive && activePane === 'right';

  const renderLeftPane = useCallback(
    (size: PaneSize) => {
      const listH = Math.max(1, size.height - 2);
      const listW = Math.max(10, size.width - 4);
      const selectionBadge = selectedMap.size > 0 ? `[${t(lang, `已选 ${selectedMap.size}`, `${selectedMap.size} sel`)}]` : '';
      const baseSubtitle = course || t(lang, '全部课程', 'All');
      const leftSubtitle = selectionBadge ? `${selectionBadge} ${baseSubtitle}` : baseSubtitle;
      return (
        <Panel
          title={t(lang, '错题列表', 'Mistakes')}
          badge={visibleItems.length}
          badgeTone={tab === 'confusable' ? 'warning' : 'primary'}
          subtitle={leftSubtitle}
          focused={activePane === 'left'}
          width={size.width}
          height={size.height}
        >
            {loading ? (
              <Box height={listH} alignItems="center" justifyContent="center">
                <Spinner label={asciiMode ? t(lang, '正在加载错题本...', 'Loading mistakes...') : t(lang, '正在加载错题本…', 'Loading mistakes…')} active={isActive} />
              </Box>
            ) : loadError ? (
            <EmptyState
              title={t(lang, '加载错题本失败', 'Failed to load mistakes')}
              hint={loadError}
              icon="!"
              actions={[{ key: 'R', label: t(lang, '重试', 'Retry') }]}
              width={listW}
              height={listH}
            />
          ) : (
            <VirtualList
              items={visibleItems}
              height={listH}
              width={listW}
              selectedIndex={clampedSelectedIdx}
              onChange={(idx) => setSelectedIdx(idx)}
              onSelect={(item) => {
                if (narrowLayout && activePane === 'left') setActivePane('right');
                else void launchPractice([{ deckId: item.deckId, cardId: item.cardId }]);
              }}
              keyExtractor={(item) => itemKey(item)}
              renderItem={renderListItem}
              isActive={leftListActive}
              emptyText={
                normalizedFilter
                  ? t(lang, `没有匹配「${filterQuery.trim()}」的错题`, `No mistakes matching "${filterQuery.trim()}"`)
                  : tab === 'confusable'
                    ? t(lang, '当前没有命中易混对的错题', 'No confusable mistakes found')
                    : t(lang, '暂无错题记录', 'No mistakes recorded')
              }
              emptyHint={
                normalizedFilter
                  ? t(lang, '按 Esc 清除筛选或按 / 修改关键词', 'Press Esc to clear filter or / to edit')
                  : t(lang, '切换标签或去学习库继续练习', 'Switch tabs or practise from Library')
              }
            />
          )}
        </Panel>
      );
    },
    [
      lang,
      visibleItems,
      tab,
      course,
      activePane,
      loading,
      isActive,
      loadError,
      clampedSelectedIdx,
      narrowLayout,
      launchPractice,
      renderListItem,
      leftListActive,
      selectedMap,
      asciiMode,
      normalizedFilter,
      filterQuery,
    ],
  );

  const renderRightPane = useCallback(
    (size: PaneSize) => {
      const innerW = Math.max(12, size.width - 4);
      const innerH = Math.max(4, size.height - 2);

      if (!selectedItem) {
        return (
          <Panel
            title={t(lang, '错题详情', 'Detail')}
            focused={activePane === 'right'}
            width={size.width}
            height={size.height}
          >
            <EmptyState
              title={t(lang, '选择一道错题查看详情与分流建议', 'Select a mistake to inspect details')}
              hint={t(lang, '按 P 批量重练或按 R 刷新', 'Press P for batch practice or R to refresh')}
              width={innerW}
              height={innerH}
            />
          </Panel>
        );
      }

      const reasonMeta = errorReasonMeta(selectedItem.errorReason);
      const triageBoxRows = triageInfo ? 3 : 0;
      const metaRows = 2;
      const citationRow = selectedItem.citations?.some((c) => c?.sourceId) ? 1 : 0;
      const actionBarRow = 1;
      const mdHeight = Math.max(3, innerH - metaRows - triageBoxRows - citationRow - actionBarRow);

      return (
        <Panel
          title={selectedItem.deckTitle}
          subtitle={selectedItem.topic || selectedItem.kind || ''}
          focused={activePane === 'right'}
          width={size.width}
          height={size.height}
        >
          {/* Meta & Status Badges */}
          <Box height={metaRows} flexDirection="column" overflow="hidden">
            <Box gap={1} overflow="hidden">
              <Badge
                label={selectedItem._view === 'history' ? t(lang, '已订正', 'Fixed') : t(lang, '待巩固', 'Weak')}
                tone={selectedItem._view === 'history' ? 'success' : 'warning'}
                variant="solid"
              />
              {selectedItem.leech ? (
                <Badge label={t(lang, '顽固题', 'Stubborn')} tone="error" variant="solid" />
              ) : null}
              <Badge
                label={t(lang, `错 ${selectedItem.wrongCount ?? 1} 次`, `×${selectedItem.wrongCount ?? 1}`)}
                tone="error"
                variant="soft"
              />
              <Badge
                label={
                  reasonMeta
                    ? t(lang, reasonMeta.zh, reasonMeta.en)
                    : t(lang, '未归因 [e]', 'No reason [e]')
                }
                tone={reasonMeta?.tone ?? 'muted'}
                variant="outline"
              />
              <Text color={theme.muted}>
                {t(lang, `最近评分 ${selectedItem.lastGrade ?? '-'}/5`, `Grade ${selectedItem.lastGrade ?? '-'}/5`)}
              </Text>
            </Box>
            <Box height={1} overflow="hidden">
              <Text color={theme.dim}>
                {truncateDisplay(
                  `${t(lang, '题型', 'Kind')}: ${selectedItem.kind || '-'}  ·  ${t(lang, '数学符号', 'Math')}: ${mathUnicode ? 'Unicode' : 'LaTeX'} [m]  ·  ${
                    detailScrollActive
                      ? asciiMode
                        ? t(lang, 'j/k 滚动  < 返回列表', 'j/k scroll  < list')
                        : t(lang, 'j/k 滚动  ← 返回列表', 'j/k scroll  ← list')
                      : asciiMode
                        ? t(lang, 'J/K 滚详情  > 专注详情', 'J/K scroll  > focus')
                        : t(lang, 'J/K 滚详情  → 专注详情', 'J/K scroll  → focus')
                  }`,
                  innerW,
                  asciiMode ? '...' : '…',
                )}
              </Text>
            </Box>
          </Box>

          {/* 0-Token Triage Recommendation Card */}
          {triageInfo ? (
            <Box
              height={triageBoxRows}
              flexDirection="column"
              borderStyle={asciiMode ? 'classic' : 'single'}
              borderColor={toneColor(theme, triageInfo.tone)}
              paddingX={1}
              overflow="hidden"
            >
              <Box height={1} overflow="hidden">
                <Text color={toneColor(theme, triageInfo.tone)} bold>
                  {triageInfo.isZeroToken
                    ? asciiMode
                      ? t(lang, '* 0-token 分流建议: ', '* 0-token Triage: ')
                      : t(lang, '⚡ 0-token 分流建议: ', '⚡ 0-token Triage: ')
                    : asciiMode
                      ? t(lang, '+ 分流建议: ', '+ Triage: ')
                      : t(lang, '✦ 分流建议: ', '✦ Triage: ')}
                </Text>
                <Text color={theme.text}>{truncateDisplay(triageInfo.lead, Math.max(10, innerW - 24), asciiMode ? '...' : '…')}</Text>
              </Box>
            </Box>
          ) : null}

          {/* Scrollable Detail Markdown (centered within 96-col measure on ultrawide screens — Round 92 A10) */}
          {(() => {
            const { proseWidth, marginLeft } = computeProseLayout(innerW);
            return (
              <Box height={mdHeight} width={innerW} paddingLeft={marginLeft} overflow="hidden">
                {detailLoading && !detail ? (
                  <Box height={mdHeight} alignItems="center" justifyContent="center">
                    <Spinner label={asciiMode ? t(lang, '加载题目详情...', 'Loading detail...') : t(lang, '加载题目详情…', 'Loading detail…')} active={isActive} />
                  </Box>
                ) : (
                  <MarkdownView
                    markdown={detailMarkdown}
                    width={proseWidth}
                    height={mdHeight}
                    isActive={detailScrollActive}
                    scrollTop={detailScrollTop}
                    onScroll={setDetailScrollTop}
                  />
                )}
              </Box>
            );
          })()}

          {/* Source Citation Bar (optional, with safe OSC 8 hyperlink when terminal supports it) */}
          {citationRow > 0 ? (
            <Box height={1} overflow="hidden">
              <Text color={theme.accent}>
                {(() => {
                  const cit = selectedItem.citations?.find((c) => c?.sourceId);
                  const rawLabel = truncateDisplay(
                    `[o] ${t(lang, '跳转原文', 'Source')}: ${cit?.title || cit?.sourceId || ''}${cit?.page != null ? ` p.${cit.page}` : ''}`,
                    innerW,
                    asciiMode ? '...' : '…',
                  );
                  const src = cit?.sourceId ? snapshot?.sources?.find((s) => s.id === cit.sourceId) : undefined;
                  const rawPath =
                    (typeof src?.filePath === 'string' && src.filePath) ||
                    (typeof src?.path === 'string' && src.path) ||
                    '';
                  const url = rawPath ? buildFileHyperlinkUrl(rawPath, cit?.page) : '';
                  return formatOsc8Link(rawLabel, url, { asciiMode });
                })()}
              </Text>
            </Box>
          ) : null}

          {/* Quick Action Strip (single-line width-budgeted so chips never wrap or clip) */}
          <Box height={1} width={innerW} flexDirection="row" flexWrap="nowrap" overflow="hidden">
            {(() => {
              const chips: Array<{
                id: string;
                keyLabel: string;
                textLabel: string;
                bg: string;
                fg: string;
                textColor: string;
              }> = [
                {
                  id: 'practise',
                  keyLabel: ' Enter/p ',
                  textLabel: t(lang, '立即重练', 'Practise'),
                  bg: theme.primary,
                  fg: theme.dark ? theme.bg : '#ffffff',
                  textColor: theme.text,
                },
                {
                  id: 'triage',
                  keyLabel: ' t ',
                  textLabel: triageInfo?.actionLabel ?? t(lang, '分流', 'Triage'),
                  bg: theme.surface,
                  fg: toneColor(theme, triageInfo?.tone ?? 'accent'),
                  textColor: theme.muted,
                },
                {
                  id: 'reason',
                  keyLabel: ' e ',
                  textLabel: t(lang, '错因', 'Reason'),
                  bg: theme.surface,
                  fg: theme.accent,
                  textColor: theme.muted,
                },
                {
                  id: 'variants',
                  keyLabel: ' V ',
                  textLabel: t(lang, '变式练', 'Variants'),
                  bg: theme.surface,
                  fg: theme.warning,
                  textColor: theme.muted,
                },
              ];
              if (selectedMap.size > 0) {
                chips.push({
                  id: 'batch-selected',
                  keyLabel: ' B ',
                  textLabel: t(lang, `练已选(${selectedMap.size})`, `Batch(${selectedMap.size})`),
                  bg: theme.surface,
                  fg: theme.primary,
                  textColor: theme.muted,
                });
              }
              if (relatedRecs.length > 0) {
                chips.push({
                  id: 'similar',
                  keyLabel: ' x ',
                  textLabel: t(lang, `同类题(${relatedRecs.length})`, `Similar(${relatedRecs.length})`),
                  bg: theme.surface,
                  fg: theme.success,
                  textColor: theme.muted,
                });
              }
              const visible: typeof chips = [];
              let used = 0;
              for (const chip of chips) {
                const need = displayWidth(chip.keyLabel) + 1 + displayWidth(chip.textLabel) + (visible.length > 0 ? 2 : 0);
                if (visible.length === 0 || used + need <= innerW) {
                  visible.push(chip);
                  used += need;
                }
              }
              return visible.map((chip, idx) => (
                <Box key={chip.id} flexDirection="row" flexShrink={0} marginRight={idx < visible.length - 1 ? 2 : 0}>
                  <Text backgroundColor={chip.bg} color={chip.fg} bold>
                    {chip.keyLabel}
                  </Text>
                  <Text color={chip.textColor}>{` ${chip.textLabel}`}</Text>
                </Box>
              ));
            })()}
          </Box>
        </Panel>
      );
    },
    [
      selectedItem,
      lang,
      activePane,
      triageInfo,
      theme,
      mathUnicode,
      detailScrollActive,
      detailLoading,
      detail,
      detailMarkdown,
      isActive,
      detailScrollTop,
      relatedRecs,
      selectedMap.size,
      asciiMode,
      snapshot?.sources,
    ],
  );

  // Reason Modal options
  const reasonOptions = useMemo<Array<SelectOption<string>>>(() => {
    const arrow = asciiMode ? '->' : '→';
    const opts: Array<SelectOption<string>> = ERROR_REASONS.map((r) => ({
      value: r.id,
      label: t(lang, r.zh, r.en),
      hint:
        r.id === 'concept'
          ? t(lang, `易混概念 ${arrow} 0-token 对比辨析 / 全书梳理`, `Confusable ${arrow} 0-token contrast / Book`)
          : r.id === 'prerequisite'
            ? t(lang, `前置未稳 ${arrow} 0-token 先练前置题`, `Gap ${arrow} 0-token prerequisite branch`)
            : r.id === 'slip'
              ? t(lang, `粗心失误 ${arrow} 仅按 FSRS 排程`, `Slip ${arrow} FSRS spacing only`)
              : undefined,
      badge: reasonShort(r.id, lang),
      badgeTone: r.tone,
    }));
    opts.push({
      value: '__clear__',
      label: t(lang, '清除错因标记', 'Clear error reason'),
      badge: asciiMode ? 'x' : '×',
      badgeTone: 'muted',
    });
    return opts;
  }, [lang, asciiMode]);

  const reasonCountsSummary = useMemo(() => {
    const map = new Map<ReasonFilterValue, number>();
    for (const r of REASON_FILTER_ORDER) map.set(r, 0);
    const pool = weakItems.length ? weakItems : allItems;
    map.set('all', pool.length);
    for (const item of pool) {
      const k: ReasonFilterValue = item.errorReason ?? 'unclassified';
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [weakItems, allItems]);

  const ell = asciiMode ? '...' : '…';
  const filterBadge = `[${t(lang, '筛选', filterEditing ? 'Filter' : 'Filtered')} ${visibleItems.length}/${tabItems.length}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Top Filter & KPI Strip */}
      <Box height={1} width={width} paddingX={1} flexDirection="row" flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0} marginRight={width < 72 ? 1 : 2}>
          <Text color={theme.primary} bold>
            {asciiMode ? t(lang, '! 错题本', '! Mistakes') : t(lang, '✕ 错题本', '✕ Mistakes')}
          </Text>
        </Box>
        {TABS.map((tb) => {
          const active = tab === tb.id;
          const cnt =
            tb.id === 'weak'
              ? counts.weak
              : tb.id === 'confusable'
                ? confusableItems.length
                : tb.id === 'all'
                  ? allItems.length
                  : weakItems.length;
          const compactZh = tb.id === 'confusable' ? '易混' : tb.id === 'reason' ? '错因' : tb.zh;
          const tabText =
            width < 72
              ? ` ${t(lang, compactZh, tb.en)} `
              : ` ${t(lang, tb.zh, tb.en)} (${cnt}) `;
          return (
            <Box key={tb.id} marginRight={width < 72 ? 0 : 1} flexShrink={0}>
              <Text
                backgroundColor={active ? theme.primary : theme.surface}
                color={active ? (theme.dark ? theme.bg : '#ffffff') : theme.muted}
                bold={active}
              >
                {tabText}
              </Text>
            </Box>
          );
        })}
        {width >= 88 ? (
          <>
            <Box flexGrow={1} />
            <Box flexShrink={0}>
              <Text color={theme.muted}>
                {t(lang, `已订正 ${counts.history}  ·  推荐同类 ${recs.length}`, `Fixed ${counts.history}  ·  Similar ${recs.length}`)}
              </Text>
            </Box>
          </>
        ) : null}
      </Box>

      {/* Secondary Sub-filter Bar when "按错因" tab is active */}
      {tab === 'reason' ? (
        <Box height={1} width={width} paddingX={1} gap={1} overflow="hidden">
          <Box flexShrink={0}>
            <Text color={theme.dim}>{width < 76 ? '[f]:' : width < 116 ? t(lang, '筛选[f]:', 'Filter[f]:') : t(lang, '错因筛选 [f]:', 'Reason [f]:')}</Text>
          </Box>
          {REASON_FILTER_ORDER.map((r) => {
            const active = reasonFilter === r;
            const c = reasonCountsSummary.get(r) ?? 0;
            const useShort = width < 116;
            const lbl = useShort
              ? r === 'all'
                ? t(lang, '全部', 'All')
                : r === 'unclassified'
                  ? t(lang, '未归因', 'Unset')
                  : reasonShort(r, lang)
              : reasonLabel(r, lang);
            return (
              <Box key={r} flexShrink={0}>
                <Text
                  backgroundColor={active ? theme.accent : undefined}
                  color={active ? (theme.dark ? theme.bg : '#ffffff') : c > 0 ? theme.text : theme.dim}
                  bold={active}
                >
                  {active ? ` ${lbl}(${c}) ` : `${lbl}(${c})`}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      <Text color={theme.border}>{(asciiMode ? '-' : '─').repeat(Math.max(0, width))}</Text>

      {/* Inline `/` Live Wrong-Card Search & Filter Bar */}
      {showFilterBar ? (
        <KeyScope id="wrongbook:filter" opaque active={isActive && filterEditing}>
          <Box height={1} width={width} backgroundColor={theme.surface} overflow="hidden" paddingX={1}>
            <Text color={filterEditing ? theme.primary : theme.accent} bold>
              {filterBadge}
            </Text>
            <Box flexGrow={1} overflow="hidden">
              <TextInput
                value={filterQuery}
                onChange={(next) => {
                  setFilterQuery(next);
                  setSelectedIdx(0);
                }}
                onSubmit={(val) => {
                  if (!val.trim()) setFilterQuery('');
                  setFilterEditing(false);
                }}
                onCancel={() => {
                  setFilterQuery('');
                  setFilterEditing(false);
                  setSelectedIdx(0);
                }}
                isActive={isActive && filterEditing}
                width={filterInputW}
                prompt="/"
                placeholder={t(lang, `题干/主题/题组/错因/课程${ell}`, `prompt/topic/deck/reason/course${ell}`)}
                maxLength={120}
              />
            </Box>
            {filterRightHint ? (
              <Text color={theme.dim} wrap="truncate">
                {filterRightHint}
              </Text>
            ) : null}
          </Box>
        </KeyScope>
      ) : null}

      {/* Master-Detail SplitPane */}
      <SplitPane
        width={width}
        height={bodyHeight}
        left={renderLeftPane}
        right={renderRightPane}
        leftWidth={0.44}
        minLeft={28}
        minRight={36}
        breakpoint={86}
        activePane={activePane}
        narrowMode="tabs"
        leftLabel={t(lang, '错题列表', 'List')}
        rightLabel={t(lang, '错题详情', 'Detail')}
        divider
      />

      {/* Modal: Error Reason Selector */}
      {activeModal === 'reason' && selectedItem ? (
        <KeyScope id="wrongbook:reason" opaque>
          <Modal
            title={t(lang, '选择错因分类', 'Set Error Reason')}
            subtitle={selectedItem.topic || selectedItem.deckTitle}
            icon={asciiMode ? '#' : '✎'}
            tone="accent"
            width={Math.min(68, width - 4)}
            onClose={() => setActiveModal(null)}
            isActive={isActive}
            hints={[
              { key: '1-7', label: t(lang, '选择', 'Pick') },
              { key: 'Esc', label: t(lang, '取消', 'Cancel') },
            ]}
          >
            <Box marginY={1} flexDirection="column">
              <SelectList
                options={reasonOptions}
                currentValue={selectedItem.errorReason ?? '__clear__'}
                isActive={isActive}
                width={modalContentWidth(Math.min(68, width - 4))}
                onSelect={(opt) => {
                  void setErrorReason(opt.value === '__clear__' ? null : (opt.value as ErrorReasonId));
                }}
              />
            </Box>
          </Modal>
        </KeyScope>
      ) : null}

      {/* Modal: 0-Token Confusable Pair Contrast */}
      {activeModal === 'confusable' && selectedItem ? (
        <KeyScope id="wrongbook:confusable" opaque>
          <ConfusableContrastModal
            item={selectedItem}
            lang={lang}
            width={Math.min(76, width - 4)}
            isActive={isActive}
            relatedRecs={relatedRecs}
            onClose={() => setActiveModal(null)}
            onPracticeContrast={() => {
              setActiveModal(null);
              const scope = [
                { deckId: selectedItem.deckId, cardId: selectedItem.cardId },
                ...relatedRecs.map((r) => ({ deckId: r.deckId, cardId: r.cardId })),
              ];
              void launchPractice(scope);
            }}
            onOpenBook={() => {
              setActiveModal(null);
              navigate('book', {
                course: selectedItem.triage?.course || course || undefined,
                deckId: selectedItem.deckId,
                ...(selectedItem.triage?.hid || selectedItem.hid
                  ? { focusPointKey: selectedItem.triage?.hid || selectedItem.hid }
                  : {}),
              });
            }}
          />
        </KeyScope>
      ) : null}

      {/* Modal: Flag Question for Repair */}
      {activeModal === 'flag' && selectedItem ? (
        <KeyScope id="wrongbook:flag" opaque>
          <Modal
            title={t(lang, '标记题目待修题', 'Flag Question for Repair')}
            subtitle={selectedItem.deckTitle}
            icon={asciiMode ? '!' : '⚑'}
            tone="error"
            width={Math.min(68, width - 4)}
            onClose={() => setActiveModal(null)}
            isActive={isActive}
            hints={[
              { key: 'Enter', label: t(lang, '提交标记', 'Submit') },
              { key: 'Esc', label: t(lang, '取消', 'Cancel') },
            ]}
          >
            <Box flexDirection="column" marginY={1} gap={1}>
              <Text color={theme.muted}>
                {t(lang, '请输入问题描述（将记录为待修标记供后续核查）：', 'Describe the issue (saved as a review flag):')}
              </Text>
              <TextInput
                value={flagText}
                onChange={setFlagText}
                onSubmit={(val) => void submitFlagRepair(val)}
                onCancel={() => setActiveModal(null)}
                isActive={isActive}
                width={modalContentWidth(Math.min(68, width - 4)) - 2}
                placeholder={t(lang, '例如：选项存在歧义 / 参考答案有误', 'e.g. Ambiguous options / wrong key')}
              />
            </Box>
          </Modal>
        </KeyScope>
      ) : null}
    </Box>
  );
});

interface ConfusableContrastModalProps {
  item: WrongBookItem;
  lang: 'zh' | 'en';
  width: number;
  isActive: boolean;
  relatedRecs: readonly WrongBookRecommendItem[];
  onClose: () => void;
  onPracticeContrast: () => void;
  onOpenBook: () => void;
}

const ConfusableContrastModal = memo(function ConfusableContrastModal({
  item,
  lang,
  width,
  isActive,
  relatedRecs,
  onClose,
  onPracticeContrast,
  onOpenBook,
}: ConfusableContrastModalProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const pair = item.triage?.confusable;
  const innerW = modalContentWidth(width);
  const names = (pair?.names ?? []).filter(Boolean);
  const rows = pair?.rows ?? [];

  useKeyScope({
    id: 'WrongBookView:confusable',
    active: isActive,
    layer: KEY_LAYER_MODAL,
    onKey: (input, key) => {
      if (key.return || input === 'p') {
        onPracticeContrast();
        return true;
      }
      if (input === 'b') {
        onOpenBook();
        return true;
      }
      return false;
    },
  });

  return (
    <Modal
      title={t(lang, `0-token 易混对比 · ${pair?.id || 'C001'}`, `0-token Contrast · ${pair?.id || 'C001'}`)}
      subtitle={names.join(' vs ') || item.topic || ''}
      icon={asciiMode ? '<>' : '⇄'}
      tone="warning"
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={[
        { key: 'Enter/p', label: t(lang, `对比练习(${1 + relatedRecs.length})`, `Practise(${1 + relatedRecs.length})`) },
        { key: 'b', label: t(lang, '打开复习全书', 'Open Book') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ]}
    >
      <Box flexDirection="column" marginY={1} gap={1}>
        {names.length >= 2 ? (
          <Box gap={1}>
            <Badge label={names[0]} tone="warning" variant="solid" />
            <Text color={theme.muted}>vs</Text>
            <Badge label={names[1]} tone="accent" variant="solid" />
          </Box>
        ) : null}
        {rows.length > 0 ? (
          <Box flexDirection="column">
            {rows.slice(0, 8).map((row, idx) => (
              <Box key={idx} flexDirection="column" marginBottom={0}>
                <Text color={theme.primary} bold>
                  {truncateDisplay(`${asciiMode ? '>' : '▸'} ${row.aspect || t(lang, '对比维度', 'Aspect')}`, innerW)}
                </Text>
                {(row.cells ?? []).map((cell, ci) => (
                  <Text key={ci} color={theme.text}>
                    {truncateDisplay(`  ${names[ci] ? `${names[ci]}: ` : ''}${cell}`, innerW)}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ) : (
          <Text color={theme.muted}>
            {t(
              lang,
              '可直接启动此题与同类易混题对比练习，或跳转复习全书查看完整辨析表。',
              'Launch targeted contrast practice with related cards, or open Review Book.',
            )}
          </Text>
        )}
      </Box>
    </Modal>
  );
});
