import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, normalizeAsciiChrome, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane } from '../../components/SplitPane.js';
import { TextInput } from '../../components/TextInput.js';
import { VirtualList } from '../../components/VirtualList.js';
import { useInputCapture } from '../../components/focus.js';
import { computeFilterBarLayout } from '../../components/layout-tokens.js';
import { useFooterHints } from '../../components/hooks.js';
import { useShellActions } from '../../shell/actions.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import { runOptimisticWrite } from '../../host/tx-write.js';
import { atomicWriteExportText, defaultBackupFilePath } from '../../host/atomic-write.js';

export interface DraftEditorProps {
  host: HostClient;
  initialDraftId?: string;
  width: number;
  height: number;
  isActive: boolean;
}

interface DraftCard {
  id: string;
  kind?: string;
  topic?: string;
  prompt?: string;
  answer?: string;
  hint?: string;
  explanation?: string;
  options?: Array<{ id?: string; text?: string; correct?: boolean; explanation?: string }>;
  cloze?: { text?: string; answers?: Array<{ id?: string; value?: string }> };
  [k: string]: unknown;
}

interface FullDraft {
  id: string;
  title?: string;
  course?: string;
  draftVersion?: number;
  cards: DraftCard[];
  editorial?: {
    rejectedIssues?: Record<string, string[]>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface SimilarWarning {
  cardId: string;
  similarity: number;
  otherPrompt?: string;
  where?: string;
  deckTitle?: string | null;
}

interface SimilarItem {
  cardId: string;
  n: number;
  similarity: number;
  other?: {
    where?: string;
    deckId?: string | null;
    deckTitle?: string | null;
    cardId?: string;
    n?: number;
    prompt?: string;
  };
}

const KIND_LABELS: Record<string, [string, string]> = {
  quiz: ['单选', 'MCQ'],
  multi: ['多选', 'Multi'],
  truefalse: ['判断', 'T/F'],
  cloze: ['填空', 'Cloze'],
  open: ['简答', 'Open'],
  flashcard: ['闪卡', 'Card'],
  task: ['任务', 'Task'],
};

function kindLabelFor(kind: unknown, lang: 'zh' | 'en'): string {
  const k = String(kind || '');
  const pair = KIND_LABELS[k];
  if (pair) return lang === 'en' ? pair[1] : pair[0];
  return k || (lang === 'en' ? 'Card' : '题');
}

export interface DraftMarkdownCard {
  id?: string;
  kind?: string;
  topic?: string;
  prompt?: string;
  answer?: string;
  hint?: string;
  explanation?: string;
  rubric?: string;
  options?: ReadonlyArray<{ id?: string; text?: string; correct?: boolean; explanation?: string }>;
  cloze?: { text?: string; answers?: ReadonlyArray<{ id?: string; value?: string }> };
}

export interface DraftMarkdownInput {
  id?: string;
  title?: string;
  course?: string;
  draftVersion?: number;
  cards?: readonly DraftMarkdownCard[];
}

function localDraftDateLabel(value?: Date | string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const d = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function draftOptionTag(id: string | undefined, idx: number): string {
  const s = (id ?? '').trim();
  return s ? (/^[a-z]$/i.test(s) ? s.toUpperCase() : s) : String.fromCharCode(65 + (idx % 26));
}

/** Pure helper generating a clean Markdown draft review sheet with collapsible answers (0 LLM tokens). */
export function formatDraftMarkdown({
  draft,
  cards,
  lang,
  generatedAt,
}: {
  draft: DraftMarkdownInput;
  cards?: readonly DraftMarkdownCard[];
  lang: UiLanguage;
  generatedAt?: Date | string;
}): string {
  const list: readonly DraftMarkdownCard[] = Array.isArray(cards)
    ? cards
    : Array.isArray(draft.cards)
      ? draft.cards
      : [];
  const title = String(draft.title || draft.id || t(lang, '未命名草稿', 'Untitled Draft')).trim();
  const course = String(draft.course || '').trim() || t(lang, '未分课', 'General');
  const date = localDraftDateLabel(generatedAt);
  const versionText =
    draft.draftVersion !== undefined && draft.draftVersion !== null
      ? `v${draft.draftVersion}`
      : t(lang, '未定稿', 'draft');

  const lines: string[] = [
    `# ${title}`,
    '',
    `- **${t(lang, '课程', 'Course')}**: ${course}`,
    `- **${t(lang, '生成日期', 'Generated')}**: ${date}`,
    `- **${t(lang, '题目数量', 'Cards')}**: ${list.length}`,
    `- **${t(lang, '草稿版本', 'Draft Version')}**: ${versionText}`,
    '',
    '---',
  ];

  if (list.length === 0) {
    lines.push('', t(lang, '_当前草稿暂无匹配题目。_', '_No matching draft cards._'), '');
    return lines.join('\n');
  }

  list.forEach((c, i) => {
    const kind = String(c.kind || 'card').trim();
    const topic = String(c.topic || '').trim();
    const tags = [`\`${kind}\``, ...(topic ? [`\`${topic}\``] : [])].join(' ');
    const promptText = String(c.prompt || '').trim();
    const clozeText = String(c.cloze?.text || '').trim();
    const stem = promptText || clozeText || t(lang, '（无题干）', '(No prompt)');

    lines.push('', `## ${i + 1}. ${topic || t(lang, `第 ${i + 1} 题`, `Card ${i + 1}`)}`, '', tags, '', stem);
    if (clozeText && promptText && clozeText !== promptText) {
      lines.push('', `**Cloze:** ${clozeText}`);
    }

    const opts = Array.isArray(c.options)
      ? c.options.filter((o) => Boolean(o && (o.text || o.id)))
      : [];
    if (opts.length > 0) {
      lines.push('');
      opts.forEach((o, oi) => {
        lines.push(`- **${draftOptionTag(o.id, oi)}.** ${String(o.text ?? '').trim()}`);
      });
    }

    const optAns = opts
      .map((o, oi) => (o.correct ? `${draftOptionTag(o.id, oi)}. ${String(o.text ?? '').trim()}` : ''))
      .filter(Boolean)
      .join('; ');
    const clozeAnswers = Array.isArray(c.cloze?.answers) ? c.cloze.answers : [];
    const clozeAns = clozeAnswers.map((a) => String(a?.value ?? '').trim()).filter(Boolean).join('; ');
    const ans = String(c.answer || optAns || clozeAns || c.rubric || '').trim();
    const hint = String(c.hint || '').trim();
    const expl = String(c.explanation || '').trim();

    lines.push('', '<details>', '<summary>参考答案与解析 / Answer & Explanation</summary>', '');
    if (ans) lines.push(`- **${t(lang, '参考答案', 'Answer')}**: ${ans}`);
    if (hint) lines.push(`- **${t(lang, '提示', 'Hint')}**: ${hint}`);
    if (expl) lines.push('', `**${t(lang, '解析', 'Explanation')}**:`, '', expl);
    if (!ans && !hint && !expl) {
      lines.push(t(lang, '_暂无参考答案与解析。_', '_No answer or explanation._'));
    }
    lines.push('', '</details>', '', '---');
  });

  lines.push('');
  return lines.join('\n');
}

interface PublishPlanExpect {
  draftId: string;
  draftVersion?: number;
  deckId?: string | null;
  before?: { id: string; contentVersion?: number } | null;
  written?: Record<string, unknown>;
  remaining?: { id: string; draftVersion?: number } | null;
  receipt?: {
    id?: string | null;
    deckId?: string | null;
    accepted?: number;
    rejected?: number;
    added?: number;
    total?: number | null;
    autoReviewed?: number;
    unchecked?: number;
  };
}

interface PublishPlanResult {
  decision?: unknown;
  expect?: PublishPlanExpect;
}

type DraftOverlay =
  | 'none'
  | 'pick-draft'
  | 'edit-card'
  | 'delete-card'
  | 'delete-draft'
  | 'publish-plan'
  | 'publish-confirm'
  | 'similar-results';

export const DraftEditor = memo(function DraftEditor({
  host,
  initialDraftId,
  width,
  height,
  isActive,
}: DraftEditorProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);
  const { refresh } = useShellActions();

  const draftsList = useMemo(() => snapshot?.drafts ?? [], [snapshot?.drafts]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | undefined>(
    initialDraftId || draftsList[0]?.id,
  );
  const [draft, setDraft] = useState<FullDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [draftPickerIdx, setDraftPickerIdx] = useState(0);
  const [overlay, setOverlay] = useState<DraftOverlay>('none');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');

  // Similar card warnings keyed by cardId + modal list state
  const [similarMap, setSimilarMap] = useState<Map<string, SimilarWarning>>(new Map());
  const [similarItems, setSimilarItems] = useState<SimilarItem[]>([]);
  const [similarCursor, setSimilarCursor] = useState(0);

  // Edit card state
  const [editField, setEditField] = useState<'prompt' | 'explanation'>('prompt');
  const [editPrompt, setEditPrompt] = useState('');
  const [editExplanation, setEditExplanation] = useState('');
  const [confirmDiscardEdit, setConfirmDiscardEdit] = useState(false);
  const [lastRemoved, setLastRemoved] = useState<{
    draftId: string;
    index: number;
    card: DraftCard;
  } | null>(null);

  // Publish preflight plan state
  const [planLoading, setPlanLoading] = useState(false);
  const [planData, setPlanData] = useState<PublishPlanResult | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const planBusyRef = useRef(false);
  const planSeqRef = useRef(0);
  const mountedRef = useRef(true);

  // Live filter & markdown export state
  const [filterQuery, setFilterQuery] = useState('');
  const [filterEditing, setFilterEditing] = useState(false);
  const exportBusyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (initialDraftId) setSelectedDraftId(initialDraftId);
  }, [initialDraftId]);

  useEffect(() => {
    setLastRemoved((prev) => (prev && prev.draftId === selectedDraftId ? prev : null));
    setFilterQuery('');
    setFilterEditing(false);
    planSeqRef.current += 1;
    planBusyRef.current = false;
    setPlanLoading(false);
    setPlanData(null);
    setPlanError(null);
  }, [selectedDraftId]);

  useEffect(() => {
    if (!selectedDraftId && draftsList.length > 0) {
      setSelectedDraftId(draftsList[0].id);
    } else if (selectedDraftId && draftsList.length > 0 && !draftsList.some((d) => d.id === selectedDraftId)) {
      setSelectedDraftId(draftsList[0].id);
    } else if (draftsList.length === 0) {
      setSelectedDraftId(undefined);
      setDraft(null);
    }
  }, [draftsList, selectedDraftId]);

  const loadDraft = useCallback(
    async (id: string) => {
      setLoading(true);
      const res = await tryAction<FullDraft>(host, 'draft.get', { id });
      setLoading(false);
      if (res.ok && res.value) {
        setDraft({
          ...res.value,
          cards: Array.isArray(res.value.cards) ? res.value.cards : [],
        });
        setSimilarMap(new Map());
      } else {
        setDraft(null);
      }
    },
    [host],
  );

  useEffect(() => {
    if (!selectedDraftId) return;
    void loadDraft(selectedDraftId);
  }, [selectedDraftId, loadDraft]);

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const filteredEntries = useMemo(() => {
    const all = draft?.cards ?? [];
    const entries = all.map((card, originalIndex) => ({ card, originalIndex }));
    if (!normalizedFilter) return entries;
    return entries.filter(({ card }) => {
      const haystack = [
        card.prompt,
        card.cloze?.text,
        card.topic,
        card.kind,
        card.answer,
        card.explanation,
      ]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join('\n')
        .toLowerCase();
      return haystack.includes(normalizedFilter);
    });
  }, [draft?.cards, normalizedFilter]);

  useEffect(() => {
    if (filteredEntries.length === 0) {
      if (cardIndex !== 0) setCardIndex(0);
    } else if (cardIndex >= filteredEntries.length) {
      setCardIndex(Math.max(0, filteredEntries.length - 1));
    }
  }, [filteredEntries.length, cardIndex]);

  const selectedEntry = filteredEntries[cardIndex];
  const selectedCard: DraftCard | undefined = selectedEntry?.card;
  const selectedOriginalIndex: number = selectedEntry?.originalIndex ?? -1;

  const saveDraftCards = useCallback(
    async (nextCards: DraftCard[], msg: string): Promise<boolean> => {
      if (!draft || busy) return false;
      setBusy(true);
      const updated = { ...draft, cards: nextCards };
      const res = await runOptimisticWrite({
        getSnapshot: () => draft,
        applyOptimistic: () => {},
        write: async () => {
          const out = await tryAction<FullDraft>(host, 'draft.save', { deck: updated });
          return out.ok
            ? { ok: true, value: out.value }
            : { ok: false, error: out.error?.message || t(lang, '保存草稿失败', 'Save draft failed') };
        },
        restoreSnapshot: (prev) => setDraft(prev),
      });
      setBusy(false);
      if (!res.ok) {
        notify(res.error || t(lang, '保存草稿失败', 'Save draft failed'), 'error');
        return false;
      }
      if (res.value && Array.isArray(res.value.cards)) {
        setDraft(res.value);
      } else {
        await loadDraft(draft.id);
      }
      await refresh();
      notify(msg, 'success');
      return true;
    },
    [busy, draft, host, lang, loadDraft, notify, refresh],
  );

  const confirmRemoveCard = useCallback(async () => {
    if (!draft || !selectedCard || selectedOriginalIndex < 0 || busy) return;
    if (draft.cards.length <= 1) {
      setOverlay('none');
      notify(t(lang, '最后一道题请使用 [D] 删除整份草稿', 'Use [D] to delete the whole draft'), 'warning');
      return;
    }
    const removed = { draftId: draft.id, index: selectedOriginalIndex, card: selectedCard };
    const next = draft.cards.filter((_, idx) => idx !== selectedOriginalIndex);
    setOverlay('none');
    const ok = await saveDraftCards(
      next,
      t(lang, '已移除该题目（按 [u] 撤销）', 'Removed card from draft (press [u] to undo)'),
    );
    if (ok) {
      setLastRemoved(removed);
    }
  }, [busy, draft, lang, notify, saveDraftCards, selectedCard, selectedOriginalIndex]);

  const undoRemoveCard = useCallback(async () => {
    if (!draft || !lastRemoved || lastRemoved.draftId !== draft.id || busy) return;
    const insertAt = Math.min(lastRemoved.index, draft.cards.length);
    const next = [
      ...draft.cards.slice(0, insertAt),
      lastRemoved.card,
      ...draft.cards.slice(insertAt),
    ];
    const ok = await saveDraftCards(next, t(lang, '已恢复刚移除的题目', 'Restored removed card'));
    if (ok) {
      setLastRemoved(null);
      if (!normalizedFilter) {
        setCardIndex(insertAt);
      }
    }
  }, [busy, draft, lang, lastRemoved, normalizedFilter, saveDraftCards]);

  // #1429: single save path for the edit-card modal, shared by the modal's Ctrl+S handler and
  // both multi-line TextInputs (via onSubmit). Before this, the inputs sat at a higher key layer
  // than the view handler and swallowed Ctrl+S, so saving a card edit did nothing.
  const saveEditCard = useCallback(() => {
    if (!draft || !selectedCard || selectedOriginalIndex < 0 || busy) return;
    const next = draft.cards.map((c, idx) =>
      idx === selectedOriginalIndex ? { ...c, prompt: editPrompt, explanation: editExplanation } : c,
    );
    setConfirmDiscardEdit(false);
    setOverlay('none');
    void saveDraftCards(next, t(lang, '题目修改已保存', 'Card updated'));
  }, [busy, draft, editExplanation, editPrompt, lang, saveDraftCards, selectedCard, selectedOriginalIndex]);

  const checkSimilar = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    setBusyLabel(asciiMode ? t(lang, '查重中...', 'Checking...') : t(lang, '查重中…', 'Checking…'));
    const res = await tryAction<{
      similar?: SimilarItem[];
    }>(host, 'draft.similar', { id: draft.id });
    setBusy(false);
    setBusyLabel('');
    if (!res.ok) {
      notify(res.error?.message || t(lang, '查重失败', 'Similarity check failed'), 'error');
      return;
    }
    const items = Array.isArray(res.value?.similar) ? res.value.similar : [];
    const map = new Map<string, SimilarWarning>();
    for (const item of items) {
      map.set(item.cardId, {
        cardId: item.cardId,
        similarity: item.similarity,
        otherPrompt: item.other?.prompt,
        where: item.other?.where,
        deckTitle: item.other?.deckTitle,
      });
    }
    setSimilarMap(map);
    setSimilarItems(items);
    setSimilarCursor(0);
    setOverlay('similar-results');
  }, [asciiMode, busy, draft, host, lang, notify]);

  const repairDraft = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    setBusyLabel(asciiMode ? t(lang, '修题中...', 'Repairing...') : t(lang, '修题中…', 'Repairing…'));
    const res = await tryAction<{ jobId?: string; status?: string; queuedBehind?: number; next?: string }>(
      host,
      'draft.repair',
      {
        id: draft.id,
        draftVersion: draft.draftVersion,
      },
    );
    if (!res.ok) {
      setBusy(false);
      setBusyLabel('');
      notify(res.error?.message || t(lang, '修复草稿失败', 'Draft repair failed'), 'error');
      return;
    }
    await loadDraft(draft.id);
    await refresh();
    setBusy(false);
    setBusyLabel('');
    const jobId = res.value?.jobId;
    notify(
      jobId
        ? t(lang, `已启动修题任务 (${jobId})，草稿已刷新`, `Repair queued (${jobId}); draft reloaded`)
        : t(lang, '草稿已修复并刷新', 'Draft repaired and reloaded'),
      'success',
    );
  }, [asciiMode, busy, draft, host, lang, loadDraft, notify, refresh]);

  const closePublishPlan = useCallback(() => {
    planSeqRef.current += 1;
    planBusyRef.current = false;
    setPlanLoading(false);
    setOverlay('none');
  }, []);

  const runPublishPlan = useCallback(async () => {
    if (!draft || busy || planBusyRef.current) return;
    planBusyRef.current = true;
    const seq = ++planSeqRef.current;
    setPlanLoading(true);
    setPlanError(null);
    setOverlay('publish-plan');
    try {
      const res = await tryAction<PublishPlanResult>(host, 'draft.publish.plan', {
        id: draft.id,
        ...(draft.draftVersion !== undefined ? { draftVersion: draft.draftVersion } : {}),
        quick: true,
      });
      if (!mountedRef.current || seq !== planSeqRef.current) return;
      if (!res.ok || !res.value?.expect) {
        setPlanData(null);
        setPlanError(res.error?.message || t(lang, '发布预检失败', 'Publish preflight failed'));
      } else {
        setPlanData(res.value);
        setPlanError(null);
      }
    } finally {
      if (seq === planSeqRef.current) {
        planBusyRef.current = false;
        if (mountedRef.current) setPlanLoading(false);
      }
    }
  }, [busy, draft, host, lang]);

  const publishDraft = useCallback(
    async (reviewed: boolean) => {
      if (!draft || busy) return;
      setBusy(true);
      const action = reviewed ? 'draft.publish' : 'draft.publish.quick';
      const res = await tryAction<{ deckId?: string; id?: string; added?: number }>(host, action, {
        id: draft.id,
        ...(draft.draftVersion !== undefined ? { draftVersion: draft.draftVersion } : {}),
      });
      setBusy(false);
      setOverlay('none');
      if (!res.ok) {
        notify(res.error?.message || t(lang, '发布草稿失败', 'Publish failed'), 'error');
        return;
      }
      await refresh();
      const targetDeckId = res.value?.deckId || res.value?.id;
      notify(
        t(lang, `草稿已发布到题组（新增 ${res.value?.added ?? draft.cards.length} 题）`, `Published draft (${res.value?.added ?? draft.cards.length} cards)`),
        'success',
      );
      if (targetDeckId) {
        navigate('library', { deckId: targetDeckId });
      }
    },
    [busy, draft, host, lang, navigate, notify, refresh],
  );

  const deleteDraft = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    const res = await tryAction(host, 'draft.delete', {
      id: draft.id,
      ...(draft.draftVersion !== undefined ? { draftVersion: draft.draftVersion } : {}),
    });
    setBusy(false);
    setOverlay('none');
    if (!res.ok) {
      notify(res.error?.message || t(lang, '删除草稿失败', 'Delete draft failed'), 'error');
      return;
    }
    await refresh();
    notify(t(lang, '草稿已删除', 'Draft deleted'), 'success');
  }, [busy, draft, host, lang, notify, refresh]);

  const exportDraftMarkdown = useCallback(async () => {
    if (!draft || exportBusyRef.current) return;
    const cardsToExport = filteredEntries.map((entry) => entry.card);
    if (cardsToExport.length === 0) {
      notify(
        t(
          lang,
          normalizedFilter ? '当前筛选结果为空，请先按 Esc 清除筛选' : '当前草稿暂无可导出题目',
          normalizedFilter ? 'No matching cards; press Esc to clear filter' : 'No draft cards to export',
        ),
        'info',
      );
      return;
    }
    exportBusyRef.current = true;
    try {
      const markdown = formatDraftMarkdown({
        draft,
        cards: cardsToExport,
        lang,
        generatedAt: new Date(),
      });
      const defaultPath = defaultBackupFilePath(
        host.getLibraryRoot(),
        'studyhub-draft',
        '.md',
        draft.title || draft.course || draft.id,
      );
      const written = await atomicWriteExportText(defaultPath, markdown);
      if (!mountedRef.current) return;
      const arrow = asciiMode ? '->' : '→';
      notify(
        t(
          lang,
          `已导出 ${cardsToExport.length} 道草稿题 ${arrow} ${written.path}`,
          `Exported ${cardsToExport.length} draft card(s) ${arrow} ${written.path}`,
        ),
        'success',
      );
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      notify(t(lang, `导出草稿失败: ${msg}`, `Failed to export draft: ${msg}`), 'error');
    } finally {
      exportBusyRef.current = false;
    }
  }, [asciiMode, draft, filteredEntries, host, lang, normalizedFilter, notify]);

  const mainListActive = isActive && overlay === 'none';
  const canUndoRemove = Boolean(draft && lastRemoved && lastRemoved.draftId === draft.id);
  const draftClaimedKeys = useMemo(
    () =>
      canUndoRemove
        ? ['e', 'x', 'X', '/', 'u', 's', 'S', 'R', 'V', 'P', 'D', 'd', 'n']
        : ['e', 'x', 'X', '/', 's', 'S', 'R', 'V', 'P', 'D', 'd', 'n'],
    [canUndoRemove],
  );
  useInputCapture(isActive && overlay === 'edit-card');

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'd', label: t(lang, '切换草稿', 'Drafts') },
      { key: 'e', label: t(lang, '编辑', 'Edit') },
      { key: 'x', label: t(lang, '删题', 'Drop') },
      ...(canUndoRemove ? [{ key: 'u', label: t(lang, '撤销删题', 'Undo') }] : []),
      { key: 'R', label: t(lang, '修题', 'Repair') },
      { key: 'S', label: t(lang, '查重', 'Similar') },
      { key: 'V', label: t(lang, '预检', 'Plan') },
      { key: 'P', label: t(lang, '发布', 'Publish') },
      { key: 'D', label: t(lang, '删草稿', 'Del') },
      { key: '/', label: t(lang, '筛选', 'Filter') },
      { key: 'X', label: t(lang, '导出MD', 'Export') },
    ],
    [lang, canUndoRemove],
  );
  useFooterHints(hints, isActive);

  const editCardDirty =
    overlay === 'edit-card' &&
    Boolean(selectedCard) &&
    (editPrompt !== String(selectedCard?.prompt || '') || editExplanation !== String(selectedCard?.explanation || ''));

  const requestCloseEditCard = useCallback(() => {
    if (editCardDirty) {
      setConfirmDiscardEdit(true);
      return;
    }
    setConfirmDiscardEdit(false);
    setOverlay('none');
  }, [editCardDirty]);

  useKeyScope({
    id: 'generate:draft-editor:overlays',
    active: isActive && (overlay === 'edit-card' || overlay === 'publish-plan') && !confirmDiscardEdit,
    onKey: (input, key) => {
      if (overlay === 'edit-card') {
        if (key.ctrl && !key.meta && input === 'n') {
          setEditField((f) => (f === 'prompt' ? 'explanation' : 'prompt'));
          return true;
        }
        if (key.ctrl && !key.meta && input === 's') {
          saveEditCard();
          return true;
        }
        return false;
      }
      if (overlay === 'publish-plan') {
        const plain = isPlainKey(input, key);
        if (plain && (input === 'q' || input === 'Q')) {
          closePublishPlan();
          return true;
        }
        if (plain && (input === 'r' || input === 'R')) {
          void runPublishPlan();
          return true;
        }
        if (
          ((!key.ctrl && !key.meta && key.return) || (plain && (input === 'p' || input === 'P'))) &&
          !planLoading &&
          !planError &&
          (planData?.expect?.receipt?.accepted ?? 0) > 0
        ) {
          setOverlay('publish-confirm');
          return true;
        }
        return false;
      }
      return false;
    },
  });

  useKeyScope({
    id: 'generate:draft-editor',
    active: mainListActive && !filterEditing && !confirmDiscardEdit,
    keys: draftClaimedKeys,
    onKey: (input, key) => {
      if (key.escape && filterQuery) {
        setFilterQuery('');
        return true;
      }
      if (!isPlainKey(input, key)) return false;

      if (input === 'd' && draftsList.length > 0) {
        const idx = Math.max(0, draftsList.findIndex((item) => item.id === selectedDraftId));
        setDraftPickerIdx(idx);
        setOverlay('pick-draft');
        return true;
      }

      if (!draft) return false;

      if (input === '/') {
        setFilterEditing(true);
        return true;
      }

      if (input === 'X') {
        void exportDraftMarkdown();
        return true;
      }

      if (input === 'u' && lastRemoved && lastRemoved.draftId === draft.id) {
        void undoRemoveCard();
        return true;
      }

      if (input === 'V') {
        void runPublishPlan();
        return true;
      }

      if (!selectedCard) return false;

      if (input === 'e') {
        setEditPrompt(String(selectedCard.prompt || ''));
        setEditExplanation(String(selectedCard.explanation || ''));
        setEditField('prompt');
        setOverlay('edit-card');
        return true;
      }
      if (input === 'x') {
        if (draft.cards.length <= 1) {
          notify(t(lang, '最后一道题请使用 [D] 删除整份草稿', 'Use [D] to delete the whole draft'), 'warning');
          return true;
        }
        setOverlay('delete-card');
        return true;
      }
      if (input === 'R') {
        void repairDraft();
        return true;
      }
      if (input === 'S' || input === 's') {
        void checkSimilar();
        return true;
      }
      if (input === 'P') {
        setOverlay('publish-confirm');
        return true;
      }
      if (input === 'D') {
        setOverlay('delete-draft');
        return true;
      }
      return false;
    },
  });

  const cardMarkdown = useMemo(() => {
    if (!selectedCard) return '';
    const parts: string[] = [];
    parts.push(`### ${selectedCard.prompt || ''}`);
    if (Array.isArray(selectedCard.options) && selectedCard.options.length > 0) {
      parts.push(
        selectedCard.options
          .map((opt, idx) => {
            const mark = opt.correct ? (asciiMode ? '[x]' : '✓') : (asciiMode ? '[ ]' : '○');
            const letter = String.fromCharCode(65 + idx);
            return `- **${mark} ${letter}.** ${opt.text || ''}`;
          })
          .join('\n'),
      );
    }
    if (selectedCard.cloze?.text) {
      parts.push(`**Cloze:** ${selectedCard.cloze.text}`);
    }
    parts.push(`**${t(lang, '参考答案', 'Answer')}:** ${selectedCard.answer || '—'}`);
    if (selectedCard.hint) {
      parts.push(`**${t(lang, '提示', 'Hint')}:** ${selectedCard.hint}`);
    }
    if (selectedCard.explanation) {
      parts.push(`---\n**${t(lang, '解析', 'Explanation')}:**\n\n${selectedCard.explanation}`);
    }
    return parts.join('\n\n');
  }, [selectedCard, lang, asciiMode]);

  if (draftsList.length === 0) {
    return (
      <EmptyState
        title={t(lang, '草稿箱为空', 'No drafts yet')}
        hint={t(lang, '切换到「新建出题任务」从资料生成题组', 'Switch to New Generation tab to create a draft')}
        width={width}
        height={height}
      />
    );
  }

  const showFilterBar = filterEditing || filterQuery.length > 0;
  const filterBarH = showFilterBar ? 1 : 0;
  const headerH = 2;
  const bodyH = Math.max(4, height - headerH - filterBarH);
  const totalCards = draft?.cards.length ?? 0;

  const simWarning = selectedCard ? similarMap.get(selectedCard.id) : undefined;
  const rejectedCount = draft?.editorial?.rejectedIssues
    ? Object.keys(draft.editorial.rejectedIssues).length
    : 0;
  const simModalW = Math.max(44, Math.min(78, width - 4));
  const simModalH = Math.max(12, Math.min(22, height - 2));
  const simInnerW = modalContentWidth(simModalW);
  const simBodyH = Math.max(6, simModalH - 5);
  const selectedSimilar = similarItems[similarCursor];
  const ell = asciiMode ? '...' : '…';

  const filterBadge = `[${filterEditing ? t(lang, '筛选', 'Filter') : t(lang, '已筛选', 'Filtered')} ${filteredEntries.length}/${totalCards}] `;
  const { rightHint: filterRightHint, inputWidth: filterInputW } = computeFilterBarLayout(width, filterBadge, lang, filterEditing);

  const planModalW = Math.max(44, Math.min(72, width - 4));
  const planInnerW = modalContentWidth(planModalW);
  const planExpect = planData?.expect;
  const planReceipt = planExpect?.receipt;
  const planAccepted = planReceipt?.accepted ?? 0;
  const planRejected = planReceipt?.rejected ?? 0;
  const planAdded = planReceipt?.added ?? 0;
  const planTotal = planReceipt?.total;
  const planAutoReviewed = planReceipt?.autoReviewed ?? 0;
  const planUnchecked = planReceipt?.unchecked ?? 0;
  const planHasTarget = Boolean(planExpect?.before);
  const planTargetDeckTitle = planExpect?.before?.id
    ? (snapshot?.decks ?? []).find((d) => d.id === planExpect.before?.id)?.title || planExpect.before.id
    : null;
  const planCanPublish = !planLoading && !planError && planAccepted > 0;

  const headerRightText = width < 92
    ? t(lang, '[V] 预检  [P] 发布', '[V] Plan  [P] Publish')
    : t(lang, `[d] 切换 (${draftsList.length})  [V] 预检  [P] 发布`, `[d] Switch (${draftsList.length})  [V] Plan  [P] Publish`);
  const headerCountLabel = `${draft?.cards.length ?? 0} ${t(lang, '题', 'cards')}`;
  const headerCourseLabel = draft?.course
    ? truncateDisplay(normalizeAsciiChrome(String(draft.course), asciiMode), width < 92 ? 12 : 24, ell)
    : '';
  const headerFixLabel = rejectedCount > 0 ? `${rejectedCount} ${t(lang, '待修', 'fix')}` : '';
  const headerReservedW =
    2 +
    (headerCourseLabel ? displayWidth(headerCourseLabel) + 3 : 0) +
    displayWidth(headerCountLabel) + 3 +
    (headerFixLabel ? displayWidth(headerFixLabel) + 3 : 0) +
    (busy ? 14 : displayWidth(headerRightText)) +
    4;
  const headerTitleMaxW = Math.max(8, width - headerReservedW);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Draft Header Bar */}
      <Box height={headerH} width={width} paddingX={1} flexDirection="column" overflow="hidden">
        <Box flexDirection="row" alignItems="center" height={1} overflow="hidden">
          <Text bold color={theme.primary}>
            {truncateDisplay(
              normalizeAsciiChrome(
                String(draft?.title || draftsList.find((d) => d.id === selectedDraftId)?.title || selectedDraftId),
                asciiMode,
              ),
              headerTitleMaxW,
              ell,
            )}
          </Text>
          <Text> </Text>
          {headerCourseLabel ? <Badge label={headerCourseLabel} tone="accent" variant="soft" /> : null}
          <Text> </Text>
          <Badge label={headerCountLabel} tone="info" variant="soft" />
          {headerFixLabel ? (
            <>
              <Text> </Text>
              <Badge label={headerFixLabel} tone="warning" variant="soft" />
            </>
          ) : null}
          <Box flexGrow={1} />
          {busy ? <Spinner label={busyLabel || (asciiMode ? t(lang, '处理中...', 'Working...') : t(lang, '处理中…', 'Working…'))} active={isActive} /> : (
            <Text color={theme.dim}>
              {truncateDisplay(headerRightText, Math.max(10, width - 2), ell)}
            </Text>
          )}
        </Box>
        <Text color={theme.dim}>
          {truncateDisplay(
            t(
              lang,
              '审校草稿题干、选项与解析；[R] 后台修题  [S] 查重  [V] 预检  [P] 发布到学习库',
              'Review stems & explanations; [R] Repair  [S] Similar  [V] Plan  [P] Publish',
            ),
            Math.max(20, width - 2),
            ell,
          )}
        </Text>
      </Box>

      {/* Inline Live Card Filter Bar */}
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
                setCardIndex(0);
              }}
              onSubmit={(val) => {
                if (!val.trim()) setFilterQuery('');
                setFilterEditing(false);
              }}
              onCancel={() => {
                setFilterQuery('');
                setFilterEditing(false);
              }}
              isActive={mainListActive && filterEditing}
              width={filterInputW}
              prompt="/"
              placeholder={t(lang, `关键词${ell}`, `keyword${ell}`)}
              maxLength={120}
            />
          </Box>
          {filterRightHint ? (
            <Text color={theme.dim}>
              {filterRightHint}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/* SplitPane */}
      <Box height={bodyH} width={width}>
        <SplitPane
          width={width}
          height={bodyH}
          leftWidth={0.4}
          leftLabel={t(lang, '草稿题目', 'Cards')}
          rightLabel={t(lang, '题目详情', 'Card Detail')}
          left={({ width: lw, height: lh }) => (
            <Panel
              title={t(lang, '题目列表', 'Draft Cards')}
              badge={normalizedFilter ? `${filteredEntries.length}/${totalCards}` : totalCards}
              width={lw}
              height={lh}
              focused={mainListActive && !filterEditing}
            >
              {loading ? (
                <Spinner label={asciiMode ? t(lang, '加载草稿...', 'Loading draft...') : t(lang, '加载草稿…', 'Loading draft…')} active={isActive} />
              ) : filteredEntries.length === 0 && normalizedFilter ? (
                <EmptyState
                  title={t(lang, '无匹配题目', 'No matching cards')}
                  hint={t(lang, '按 [Esc] 清除筛选，或 [/] 修改关键词', 'Press [Esc] to clear filter, or [/] to edit')}
                  width={Math.max(12, lw - 4)}
                  height={Math.max(4, lh - 2)}
                />
              ) : (
                <VirtualList
                  items={filteredEntries}
                  height={Math.max(1, lh - 2)}
                  width={Math.max(12, lw - 4)}
                  selectedIndex={cardIndex}
                  onChange={(idx) => setCardIndex(idx)}
                  isActive={mainListActive && !filterEditing}
                  keyExtractor={(entry) => `${entry.card.id}-${entry.originalIndex}`}
                  renderItem={(entry, ctx) => {
                    const card = entry.card;
                    const kindLabel = kindLabelFor(card.kind, lang);
                    const warn = similarMap.has(card.id) ? (asciiMode ? '! ' : '⚠ ') : '';
                    const pointer = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                    const prefix = `${entry.originalIndex + 1}. [${kindLabel}] `;
                    const stemMax = Math.max(8, ctx.width - displayWidth(prefix) - (warn ? 2 : 0) - 3);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{pointer}</Text>
                        {warn ? <Text color={theme.warning}>{warn}</Text> : null}
                        <Text color={theme.accent}>{prefix}</Text>
                        <Text color={theme.text} bold={ctx.selected}>
                          {truncateDisplay(String(card.prompt || card.cloze?.text || '').replace(/\s+/g, ' '), stemMax, ell)}
                        </Text>
                      </Box>
                    );
                  }}
                />
              )}
            </Panel>
          )}
          right={({ width: rw, height: rh }) => (
            <Panel
              title={selectedCard && selectedOriginalIndex >= 0 ? `#${selectedOriginalIndex + 1} ${kindLabelFor(selectedCard.kind, lang)}` : t(lang, '详情', 'Detail')}
              subtitle={selectedCard?.topic ? String(selectedCard.topic) : undefined}
              width={rw}
              height={rh}
            >
              {!selectedCard ? (
                <EmptyState
                  title={t(lang, '无选中题目', 'No card selected')}
                  width={Math.max(12, rw - 4)}
                  height={Math.max(4, rh - 2)}
                />
              ) : (
                <Box flexDirection="column" width={Math.max(12, rw - 4)} height={Math.max(2, rh - 2)}>
                  {simWarning ? (
                    <Box marginBottom={1}>
                      <Text color={theme.warning}>
                        {`${asciiMode ? '!' : '⚠'} ${t(lang, '相似题提醒', 'Similar')} (${Math.round(simWarning.similarity * 100)}%): ${simWarning.otherPrompt || ''}`}
                      </Text>
                    </Box>
                  ) : null}
                  <MarkdownView
                    markdown={cardMarkdown}
                    width={Math.max(12, rw - 4)}
                    height={Math.max(2, rh - 2 - (simWarning ? 2 : 0))}
                    mathUnicode={mathUnicode}
                    isActive={false}
                  />
                </Box>
              )}
            </Panel>
          )}
        />
      </Box>

      {/* Draft Switcher Modal */}
      {overlay === 'pick-draft' ? (
        <Modal
          title={t(lang, '选择草稿', 'Select Draft')}
          width={64}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Enter', label: t(lang, '打开', 'Open') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <VirtualList
            items={draftsList}
            height={Math.min(10, Math.max(3, draftsList.length))}
            width={modalContentWidth(64) - 2}
            selectedIndex={draftPickerIdx}
            onChange={(idx) => setDraftPickerIdx(idx)}
            onSelect={(item) => {
              setSelectedDraftId(item.id);
              setCardIndex(0);
              setOverlay('none');
            }}
            isActive={isActive}
            keyExtractor={(d) => d.id}
            renderItem={(d, ctx) => (
              <Box flexDirection="row" width={ctx.width}>
                <Text color={ctx.selected ? theme.primary : theme.muted}>{ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  '}</Text>
                <Text bold={ctx.selected} color={theme.text}>
                  {truncateDisplay(String(d.title || d.id), Math.max(12, ctx.width - 14), ell)}
                </Text>
                <Box flexGrow={1} />
                <Text color={theme.dim}>{`${d.cardCount ?? d.cards?.length ?? 0}${t(lang, '题', 'q')}`}</Text>
              </Box>
            )}
          />
        </Modal>
      ) : null}

      {/* Edit Card Modal */}
      {overlay === 'edit-card' && selectedCard ? (
        <Modal
          title={t(lang, `编辑第 ${selectedOriginalIndex + 1} 题`, `Edit Card #${selectedOriginalIndex + 1}`)}
          subtitle={editCardDirty ? t(lang, '未保存', 'unsaved') : undefined}
          width={72}
          isActive={isActive && !confirmDiscardEdit}
          onClose={confirmDiscardEdit ? undefined : requestCloseEditCard}
          hints={[
            { key: 'Ctrl+N', label: t(lang, '切换字段', 'Switch field') },
            { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: editCardDirty ? t(lang, '放弃/取消', 'Discard') : t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={editField === 'prompt' ? theme.primary : theme.muted} bold={editField === 'prompt'}>
            {t(lang, '题干 (Prompt):', 'Stem (Prompt):')}
          </Text>
          <TextInput
            value={editPrompt}
            onChange={setEditPrompt}
            onCancel={requestCloseEditCard}
            onSubmit={saveEditCard}
            multiline
            height={4}
            width={modalContentWidth(72) - 4}
            isActive={isActive && !confirmDiscardEdit && editField === 'prompt'}
          />
          <Box marginTop={1}>
            <Text color={editField === 'explanation' ? theme.primary : theme.muted} bold={editField === 'explanation'}>
              {t(lang, '解析 (Explanation):', 'Explanation:')}
            </Text>
          </Box>
          <TextInput
            value={editExplanation}
            onChange={setEditExplanation}
            onCancel={requestCloseEditCard}
            onSubmit={saveEditCard}
            multiline
            height={5}
            width={modalContentWidth(72) - 4}
            isActive={isActive && !confirmDiscardEdit && editField === 'explanation'}
          />
        </Modal>
      ) : null}

      {confirmDiscardEdit ? (
        <ConfirmDialog
          title={t(lang, '放弃未保存的题目修改？', 'Discard unsaved card edits?')}
          message={t(
            lang,
            '当前草稿题目仍有未保存的修改。放弃后将丢失这些编辑内容。',
            'You have unsaved edits for this draft card. Closing now will discard them.',
          )}
          confirmLabel={t(lang, '放弃修改', 'Discard')}
          cancelLabel={t(lang, '继续编辑', 'Keep Editing')}
          danger
          isActive={isActive && confirmDiscardEdit}
          onConfirm={() => {
            setConfirmDiscardEdit(false);
            setOverlay('none');
          }}
          onCancel={() => setConfirmDiscardEdit(false)}
        />
      ) : null}

      {/* Publish Preflight Dry-Run Modal */}
      {overlay === 'publish-plan' && draft ? (
        <Modal
          title={t(lang, '发布预检', 'Publish Preflight')}
          subtitle={t(lang, '干跑演练 (0 模型调用)', 'Dry-run (0 LLM calls)')}
          icon={planError ? '!' : asciiMode ? '+' : '✓'}
          tone={planError ? 'error' : planRejected > 0 ? 'warning' : 'primary'}
          width={planModalW}
          isActive={isActive}
          onClose={closePublishPlan}
          hints={
            planCanPublish
              ? [
                  { key: 'p/Enter', label: t(lang, '去发布确认', 'Publish') },
                  { key: 'r', label: t(lang, '重新预检', 'Re-run') },
                  { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
                ]
              : [
                  { key: 'r', label: t(lang, '重新预检', 'Re-run') },
                  { key: 'Esc/q', label: t(lang, '关闭', 'Close') },
                ]
          }
        >
          <Box flexDirection="column" width={planInnerW} overflow="hidden">
            <Box flexDirection="row" width={planInnerW}>
              <Text color={theme.muted}>{t(lang, '草稿: ', 'Draft: ')}</Text>
              <Text bold color={theme.text}>
                {truncateDisplay(normalizeAsciiChrome(String(draft.title || draft.id), asciiMode), Math.max(10, planInnerW - 8), ell)}
              </Text>
            </Box>
            {planLoading ? (
              <Box marginTop={1}>
                <Spinner
                  label={asciiMode ? t(lang, '正在运行发布预检...', 'Running publish preflight...') : t(lang, '正在运行发布预检…', 'Running publish preflight…')}
                  active={isActive}
                />
              </Box>
            ) : planError ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.error} bold>
                  {t(lang, '预检未通过:', 'Preflight failed:')}
                </Text>
                <Text color={theme.error}>
                  {truncateDisplay(normalizeAsciiChrome(planError, asciiMode).replace(/\s+/g, ' '), planInnerW * 3, ell)}
                </Text>
              </Box>
            ) : planExpect ? (
              <Box flexDirection="column" width={planInnerW}>
                <Box flexDirection="row" width={planInnerW}>
                  <Text color={theme.muted}>{t(lang, '目标: ', 'Target: ')}</Text>
                  <Text color={planHasTarget ? theme.accent : theme.primary} bold>
                    {truncateDisplay(
                      planHasTarget
                        ? `${t(lang, '合并到现有题组', 'Update existing deck')}${
                            planTargetDeckTitle ? ` (${normalizeAsciiChrome(String(planTargetDeckTitle), asciiMode)})` : ''
                          }`
                        : t(lang, '新建题组', 'New deck'),
                      Math.max(12, planInnerW - 10),
                      ell,
                    )}
                  </Text>
                </Box>
                <Box marginY={0}>
                  <Divider width={planInnerW} />
                </Box>
                <Box flexDirection="row" width={planInnerW}>
                  <Text color={theme.success}>
                    {`${t(lang, '通过 (accepted)', 'Accepted')}: ${planAccepted}`}
                  </Text>
                  <Text>   </Text>
                  <Text color={planRejected > 0 ? theme.warning : theme.muted}>
                    {`${t(lang, '拦截 (rejected)', 'Rejected')}: ${planRejected}`}
                  </Text>
                </Box>
                <Box flexDirection="row" width={planInnerW}>
                  <Text color={theme.primary}>
                    {`${t(lang, '新增 (added)', 'Added')}: ${planAdded}`}
                  </Text>
                  <Text>   </Text>
                  <Text color={theme.text}>
                    {`${t(lang, '发布后总计 (total)', 'Total')}: ${planTotal !== null && planTotal !== undefined ? planTotal : '-'}`}
                  </Text>
                </Box>
                <Box flexDirection="row" width={planInnerW}>
                  <Text color={theme.info}>
                    {`${t(lang, '自动复审 (autoReviewed)', 'Auto-reviewed')}: ${planAutoReviewed}`}
                  </Text>
                  <Text>   </Text>
                  <Text color={planUnchecked > 0 ? theme.warning : theme.muted}>
                    {`${t(lang, '未复审 (unchecked)', 'Unchecked')}: ${planUnchecked}`}
                  </Text>
                </Box>
                <Box marginTop={1} flexDirection="column" width={planInnerW}>
                  <Text color={planExpect.remaining ? theme.warning : theme.success}>
                    {truncateDisplay(
                      planExpect.remaining
                        ? t(
                            lang,
                            `剩余草稿: 将保留未通过草稿 (${normalizeAsciiChrome(planExpect.remaining.id, asciiMode)})`,
                            `Remaining draft: rejected cards kept in ${normalizeAsciiChrome(planExpect.remaining.id, asciiMode)}`,
                          )
                        : t(
                            lang,
                            '剩余草稿: 无 (发布后将清空草稿，本次预检未写入学习库)',
                            'Remaining draft: None (dry-run only; library unchanged)',
                          ),
                      planInnerW * 2,
                      ell,
                    )}
                  </Text>
                </Box>
              </Box>
            ) : null}
          </Box>
        </Modal>
      ) : null}

      {overlay === 'publish-confirm' && draft ? (
        <ConfirmDialog
          title={t(lang, '发布草稿到题组', 'Publish Draft to Deck')}
          message={t(
            lang,
            `确认将「${draft.title || draft.id}」（共 ${draft.cards.length} 道题）发布到学习库吗？`,
            `Publish "${draft.title || draft.id}" (${draft.cards.length} cards) to your study library?`,
          )}
          confirmLabel={t(lang, '立即发布', 'Publish Now')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive}
          onConfirm={() => void publishDraft(false)}
          onCancel={() => setOverlay('none')}
        />
      ) : null}

      {overlay === 'delete-card' && draft && selectedCard ? (
        <ConfirmDialog
          title={t(lang, '移除草稿题目', 'Remove Draft Card')}
          message={t(
            lang,
            `确定从草稿移除第 ${selectedOriginalIndex + 1} 题「${truncateDisplay(String(selectedCard.prompt || '').replace(/\s+/g, ' '), 48, ell)}」吗？`,
            `Remove card #${selectedOriginalIndex + 1} "${truncateDisplay(String(selectedCard.prompt || '').replace(/\s+/g, ' '), 48, ell)}" from this draft?`,
          )}
          confirmLabel={t(lang, '移除', 'Remove')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive}
          onConfirm={() => void confirmRemoveCard()}
          onCancel={() => setOverlay('none')}
        />
      ) : null}

      {overlay === 'delete-draft' && draft ? (
        <ConfirmDialog
          title={t(lang, '删除草稿', 'Delete Draft')}
          message={t(
            lang,
            `确定永久删除草稿「${draft.title || draft.id}」吗？`,
            `Permanently delete draft "${draft.title || draft.id}"?`,
          )}
          confirmLabel={t(lang, '删除', 'Delete')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive}
          onConfirm={() => void deleteDraft()}
          onCancel={() => setOverlay('none')}
        />
      ) : null}

      {/* Near-Duplicate Similarity Results Modal */}
      {overlay === 'similar-results' ? (
        <Modal
          title={t(lang, '相似 / 重复题检测', 'Near-Duplicate Check')}
          subtitle={
            similarItems.length > 0
              ? t(lang, `${similarItems.length} 处高相似`, `${similarItems.length} flagged`)
              : t(lang, '0 处相似', '0 flagged')
          }
          icon={asciiMode ? '!' : '≈'}
          tone={similarItems.length > 0 ? 'warning' : 'success'}
          width={simModalW}
          height={simModalH}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={
            similarItems.length > 0
              ? [
                  { key: 'Enter', label: t(lang, '跳转该题', 'Jump to Card') },
                  { key: 'Esc', label: t(lang, '关闭', 'Close') },
                ]
              : [{ key: 'Esc', label: t(lang, '关闭', 'Close') }]
          }
        >
          {similarItems.length === 0 ? (
            <EmptyState
              title={t(lang, '无明显重复题', 'No near-duplicates found')}
              hint={t(lang, '当前草稿与课程题库中未发现高相似度题目', 'No high-similarity matches in draft or course decks')}
              icon={asciiMode ? '+' : '✓'}
              width={simInnerW}
              height={simBodyH}
            />
          ) : (
            <Box flexDirection="column" height={simBodyH} width={simInnerW}>
              <VirtualList
                items={similarItems}
                height={Math.max(3, simBodyH - 4)}
                width={simInnerW}
                selectedIndex={similarCursor}
                onChange={(idx) => setSimilarCursor(idx)}
                onSelect={(item) => {
                  if (draft) {
                    const foundInFiltered = filteredEntries.findIndex((e) => e.card.id === item.cardId);
                    if (foundInFiltered >= 0) {
                      setCardIndex(foundInFiltered);
                    } else {
                      setFilterQuery('');
                      setFilterEditing(false);
                      const foundIdx = draft.cards.findIndex((c) => c.id === item.cardId);
                      const fallbackIdx = Number.isInteger(item.n)
                        ? Math.max(0, Math.min(draft.cards.length - 1, item.n - 1))
                        : 0;
                      setCardIndex(foundIdx >= 0 ? foundIdx : fallbackIdx);
                    }
                  }
                  setOverlay('none');
                }}
                isActive={isActive}
                keyExtractor={(item, i) => `${item.cardId}-${i}`}
                renderItem={(item, ctx) => {
                  const pct = `${Math.round(item.similarity * 100)}%`;
                  const draftCard = draft?.cards.find((c) => c.id === item.cardId) ?? draft?.cards[item.n - 1];
                  const stem = String(draftCard?.prompt || '').replace(/\s+/g, ' ');
                  const whereTag =
                    item.other?.where === 'draft'
                      ? t(lang, `草稿#${item.other?.n ?? '?'}`, `Draft#${item.other?.n ?? '?'}`)
                      : `${item.other?.deckTitle || t(lang, '题组', 'Deck')}#${item.other?.n ?? '?'}`;
                  const pointer = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                  const sep = asciiMode ? ' <-> ' : ' ↔ ';
                  const leftPart = `${pointer}[${pct}] #${item.n} `;
                  const rightPart = `${sep}${truncateDisplay(whereTag, 18, ell)}`;
                  const stemBudget = Math.max(8, ctx.width - leftPart.length - rightPart.length - 1);
                  return (
                    <Box flexDirection="row" width={ctx.width}>
                      <Text color={ctx.selected ? theme.primary : theme.muted}>{pointer}</Text>
                      <Text color={theme.warning} bold>{`[${pct}] `}</Text>
                      <Text color={theme.accent}>{`#${item.n} `}</Text>
                      <Text color={theme.text} bold={ctx.selected}>
                        {truncateDisplay(stem || item.cardId, stemBudget, ell)}
                      </Text>
                      <Box flexGrow={1} />
                      <Text color={theme.dim}>{rightPart}</Text>
                    </Box>
                  );
                }}
              />
              <Divider width={simInnerW} />
              {selectedSimilar ? (
                <Box flexDirection="column" height={3} width={simInnerW} overflow="hidden">
                  <Text color={theme.warning} bold>
                    {truncateDisplay(
                      `${Math.round(selectedSimilar.similarity * 100)}% · #${selectedSimilar.n} ${asciiMode ? '<->' : '↔'} ${
                        selectedSimilar.other?.where === 'draft'
                          ? t(lang, `草稿第 ${selectedSimilar.other?.n ?? '?'} 题`, `Draft #${selectedSimilar.other?.n ?? '?'}`)
                          : `${selectedSimilar.other?.deckTitle || t(lang, '题组', 'Deck')} #${selectedSimilar.other?.n ?? '?'}`
                      }`,
                      simInnerW,
                      ell,
                    )}
                  </Text>
                  <Text color={theme.muted}>
                    {truncateDisplay(
                      String(selectedSimilar.other?.prompt || '').replace(/\s+/g, ' '),
                      simInnerW * 2 - 2,
                      ell,
                    )}
                  </Text>
                </Box>
              ) : null}
            </Box>
          )}
        </Modal>
      ) : null}
    </Box>
  );
});
