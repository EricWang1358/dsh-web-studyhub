import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import { useStableWindowSize } from '../../components/resize.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { getReview, tryAction, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalChildRows, modalContentWidth, modalFrameHeight } from '../../components/Modal.js';
import { ScrollView } from '../../components/ScrollView.js';
import { TextInput } from '../../components/TextInput.js';
import { displayWidth, truncateDisplay, wrapDisplay, wrapToRows } from '../../render/cjk.js';
import {
  currentDeckIdOf,
  extractFeedback,
  extractReferenceAnswer,
  extractSolution,
  type NormalizedKind,
} from './review-helpers.js';
import { NextStepFollowupBar } from './NextStepFollowupBar.js';

export interface CardToolsModalProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  width: number;
  height: number;
  isActive: boolean;
  onClose: () => void;
  onRunUpdated: (nextRun: ReviewRun) => void;
  onCardEdited?: (cardId: string) => void;
  onFocusChanged?: (cardId: string, focus: boolean) => void;
  onRefreshSnapshot?: () => void;
}

type ToolMode = 'menu' | 'edit' | 'confirm-slay' | 'confirm-retry-rewrite' | 'terms' | 'prereqs' | 'feedback';
type EditField = 'prompt' | 'answer' | 'explanation';

const FEEDBACK_TAG_OPTIONS = [
  { key: 'general-quality', zh: '题目有问题，检查并修改', en: 'Problematic question; check and fix' },
  { key: 'stem-vague', zh: '题干太空', en: 'Stem too vague' },
  { key: 'bad-options', zh: '选项太烂', en: 'Poor distractors' },
  { key: 'too-easy', zh: '太简单', en: 'Too easy' },
  { key: 'too-hard', zh: '太难', en: 'Too hard' },
  { key: 'wrong-answer', zh: '答案有误', en: 'Wrong answer' },
  { key: 'unclear-explanation', zh: '解析不清', en: 'Unclear explanation' },
  { key: 'source-recall', zh: '只问资料怎么说，考的是背诵', en: 'Asks what the source says instead of the concept' },
] as const;

interface CardDetailShape {
  id?: string;
  kind?: string;
  prompt?: string;
  answer?: string;
  explanation?: string;
  suspended?: boolean;
  focus?: boolean;
}

interface PrereqItem {
  deckId: string;
  cardId: string;
  deckTitle?: string;
  topic?: string;
  prompt: string;
  kind?: string;
  level?: string;
}

interface CardSearchHit {
  deckId: string;
  deckTitle?: string;
  course?: string;
  cardId: string;
  kind?: string;
  topic?: string;
  prompt: string;
}

interface CardGetResponse {
  deckId?: string;
  card?: CardDetailShape;
  revisions?: Array<{ at?: string; reason?: string }>;
  prerequisites?: PrereqItem[];
}

interface CardPlaceResponse {
  course?: string | null;
  document?: { key?: string; title?: string } | null;
  chapter?: { key?: string; title?: string } | null;
  leaf?: { key?: string; title?: string; built?: boolean } | null;
}

interface ExtractedTermItem {
  term: string;
  definition?: string;
}

function normalizeExtractedTerms(raw: unknown): ExtractedTermItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedTermItem[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const term = entry.trim();
      if (term) out.push({ term });
    } else if (entry && typeof entry === 'object') {
      const obj = entry as { term?: unknown; name?: unknown; definition?: unknown; plain?: unknown; explanation?: unknown };
      const term = String(obj.term ?? obj.name ?? '').trim();
      const def = String(obj.definition ?? obj.plain ?? obj.explanation ?? '').trim();
      if (term) out.push({ term, ...(def ? { definition: def } : {}) });
    }
  }
  return out;
}

export const CardToolsModal = memo(function CardToolsModal({
  host,
  run,
  cardId,
  kind,
  width,
  height,
  isActive,
  onClose,
  onRunUpdated,
  onCardEdited,
  onFocusChanged,
  onRefreshSnapshot,
}: CardToolsModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const notify = useTuiStore((s) => s.notify);

  const deckId = currentDeckIdOf(run) ?? '';
  const feedback = extractFeedback(run);
  const solution = extractSolution(run);

  const initialPrompt = String(run.card?.prompt ?? '');
  const initialAnswer = String(
    (run.card as { answer?: unknown } | null | undefined)?.answer ??
      solution?.answer ??
      (kind === 'flashcard' || kind === 'short_answer' ? extractReferenceAnswer(run, kind, lang) : ''),
  );
  const initialExplanation = String(solution?.explanation ?? '');

  const [mode, setMode] = useState<ToolMode>('menu');
  const [menuCursor, setMenuCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [infoText, setInfoText] = useState<string | null>(null);
  const [resolvedDeckId, setResolvedDeckId] = useState<string>(deckId);
  const [cardPlaceInfo, setCardPlaceInfo] = useState<CardPlaceResponse | null>(null);
  const [revisionsCount, setRevisionsCount] = useState<number>(0);
  const [lastRevisionReason, setLastRevisionReason] = useState<string>('');
  const [confirmCoachRevert, setConfirmCoachRevert] = useState<boolean>(false);
  const [suspended, setSuspended] = useState<boolean>(Boolean((run.card as { suspended?: unknown } | null | undefined)?.suspended));
  const [focusedCard, setFocusedCard] = useState<boolean>(Boolean((run.card as { focus?: unknown } | null | undefined)?.focus));

  // Card quality feedback state
  const [feedbackTagCursor, setFeedbackTagCursor] = useState<number>(0);
  const [selectedFeedbackTags, setSelectedFeedbackTags] = useState<string[]>([]);
  const [lastFeedbackVote, setLastFeedbackVote] = useState<'up' | 'down' | null>(null);

  // Terms extraction state
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsItems, setTermsItems] = useState<ExtractedTermItem[]>([]);
  const [termsCached, setTermsCached] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [termsFollowupEngaged, setTermsFollowupEngaged] = useState(false);

  // Prerequisite links manager state
  const [prereqs, setPrereqs] = useState<PrereqItem[]>([]);
  const [prereqsLoading, setPrereqsLoading] = useState(false);
  const [prereqCursor, setPrereqCursor] = useState(0);
  const [prereqSearchActive, setPrereqSearchActive] = useState(false);
  const [prereqSearchFocused, setPrereqSearchFocused] = useState(false);
  const [prereqQuery, setPrereqQuery] = useState('');
  const [prereqSearchLoading, setPrereqSearchLoading] = useState(false);
  const [prereqHits, setPrereqHits] = useState<CardSearchHit[]>([]);
  const [prereqHitCursor, setPrereqHitCursor] = useState(0);
  const prereqSearchSeqRef = useRef(0);
  const lastSearchedQueryRef = useRef('');
  const hydrateSeqRef = useRef(0);
  const placeSeqRef = useRef(0);

  // Edit form fields
  const [editField, setEditField] = useState<EditField>('prompt');
  const [promptDraft, setPromptDraft] = useState(initialPrompt);
  const [answerDraft, setAnswerDraft] = useState(initialAnswer);
  const [explanationDraft, setExplanationDraft] = useState(initialExplanation);
  const [confirmDiscardEdit, setConfirmDiscardEdit] = useState(false);
  const baselineRef = useRef({
    prompt: initialPrompt,
    answer: initialAnswer,
    explanation: initialExplanation,
  });

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hydrateCardDetails = useCallback(async () => {
    const seq = ++hydrateSeqRef.current;
    const res = await tryAction<CardGetResponse>(host, 'card.get', {
      ...(deckId ? { deckId } : {}),
      cardId,
    });
    if (!mountedRef.current || seq !== hydrateSeqRef.current || !res.ok || !res.value) return false;
    if (typeof res.value.deckId === 'string' && res.value.deckId) {
      setResolvedDeckId(res.value.deckId);
    }
    const revs = Array.isArray(res.value.revisions) ? res.value.revisions : [];
    setRevisionsCount(revs.length);
    setLastRevisionReason(String(revs.at(-1)?.reason ?? '').trim());
    setPrereqs(Array.isArray(res.value.prerequisites) ? res.value.prerequisites : []);
    const c = res.value.card;
    if (c) {
      const nextPrompt = typeof c.prompt === 'string' ? c.prompt : initialPrompt;
      const nextAnswer = typeof c.answer === 'string' ? c.answer : '';
      const nextExpl = typeof c.explanation === 'string' ? c.explanation : '';
      setSuspended(Boolean(c.suspended));
      if (typeof c.focus === 'boolean') setFocusedCard(c.focus);
      setPromptDraft(nextPrompt);
      setAnswerDraft(nextAnswer);
      setExplanationDraft(nextExpl);
      baselineRef.current = {
        prompt: nextPrompt,
        answer: nextAnswer,
        explanation: nextExpl,
      };
    }
    return true;
  }, [host, deckId, cardId, initialPrompt]);

  // Hydrate full card details (authoritative suspended/focus/prereqs/revisions state, answer & explanation even pre-reveal)
  useEffect(() => {
    setResolvedDeckId(deckId);
    void hydrateCardDetails();
  }, [deckId, hydrateCardDetails]);

  // Lookup exact Review Book chapter/point & source placement (fail-soft, read-only)
  useEffect(() => {
    const seq = ++placeSeqRef.current;
    setCardPlaceInfo(null);
    let cancelled = false;
    void tryAction<CardPlaceResponse>(host, 'card.place', {
      ...(deckId ? { deckId } : {}),
      cardId,
    })
      .then((res) => {
        if (cancelled || !mountedRef.current || seq !== placeSeqRef.current) return;
        if (res.ok && res.value && typeof res.value === 'object') {
          setCardPlaceInfo(res.value);
        }
      })
      .catch(() => {
        // fail-soft: placement summary is informational only
      });
    return () => {
      cancelled = true;
    };
  }, [host, deckId, cardId]);

  const isExam = run.mode === 'exam';
  const isRetry = Boolean(run.retry);
  const canAdjustCloze = !isExam && !isRetry && kind === 'fill_blank' && Boolean(feedback) && !feedback?.correct;
  const canAdjustRubric =
    !isExam &&
    !isRetry &&
    kind === 'short_answer' &&
    Boolean(feedback) &&
    !feedback?.taskCheck &&
    (Boolean((feedback as { rubric?: unknown } | null)?.rubric) || (!feedback?.correct && !feedback?.selfReported));
  const canAdjustGrade = canAdjustCloze || canAdjustRubric;

  const canEditAnswer = kind === 'flashcard' || kind === 'short_answer' || baselineRef.current.answer.length > 0;
  const editDirty =
    mode === 'edit' &&
    (promptDraft !== baselineRef.current.prompt ||
      (canEditAnswer && answerDraft !== baselineRef.current.answer) ||
      explanationDraft !== baselineRef.current.explanation);

  const requestCancelEdit = useCallback(() => {
    if (busy) return;
    if (editDirty) {
      setConfirmDiscardEdit(true);
      return;
    }
    setConfirmDiscardEdit(false);
    setMode('menu');
  }, [busy, editDirty]);

  const handleSaveEdit = useCallback(async () => {
    if (busy) return;
    const base = baselineRef.current;
    const patch: Record<string, string> = {};
    const p = promptDraft.trim();
    const a = answerDraft.trim();
    const e = explanationDraft.trim();
    if (p !== base.prompt.trim() && p.length > 0) patch.prompt = p;
    if (canEditAnswer && a !== base.answer.trim()) patch.answer = a;
    if (e !== base.explanation.trim()) patch.explanation = e;

    if (Object.keys(patch).length === 0) {
      setErrorText(t(lang, '内容未发生修改', 'No changes to save'));
      return;
    }

    setBusy(true);
    setErrorText(null);
    const res = await tryAction(host, 'card.update', {
      ...(deckId ? { deckId } : {}),
      cardId,
      patch,
      reason: 'Updated in StudyHub TUI review',
    });
    if (!mountedRef.current) return;
    if (!res.ok) {
      setBusy(false);
      setErrorText(res.error?.message || t(lang, '保存题目修改失败', 'Failed to update card'));
      return;
    }
    onCardEdited?.(cardId);
    try {
      const refreshed = await getReview(host, run.id);
      if (!mountedRef.current) return;
      onRunUpdated(refreshed);
    } catch {
      // card.update succeeded even if run refresh failed
    }
    if (!mountedRef.current) return;
    setBusy(false);
    onRefreshSnapshot?.();
    notify(t(lang, '题目已更新并刷新当前复习', 'Card updated and review refreshed'), 'success');
    onClose();
  }, [
    busy,
    promptDraft,
    answerDraft,
    explanationDraft,
    canEditAnswer,
    lang,
    host,
    deckId,
    cardId,
    onCardEdited,
    run.id,
    onRunUpdated,
    onRefreshSnapshot,
    notify,
    onClose,
  ]);

  const handleToggleSuspend = useCallback(async () => {
    if (busy) return;
    if (!deckId) {
      setErrorText(t(lang, '缺少题组信息，无法暂停/恢复题目', 'Missing deck context; cannot pause or resume card'));
      return;
    }
    const nextSuspended = !suspended;
    setBusy(true);
    setErrorText(null);
    const res = await tryAction<{ ok?: boolean }>(host, 'card.suspend', {
      deckId,
      cardId,
      suspended: nextSuspended,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.error?.message || t(lang, '更新暂停状态失败', 'Failed to toggle suspend'));
      return;
    }
    setSuspended(nextSuspended);
    onRefreshSnapshot?.();
    notify(
      nextSuspended
        ? t(lang, '已暂停此题，将离开每日复习队列', 'Card suspended from daily queue')
        : t(lang, '已恢复此题到复习队列', 'Card resumed in queue'),
      'success',
    );
    onClose();
  }, [busy, deckId, suspended, host, cardId, onRefreshSnapshot, notify, lang, onClose]);

  const handleConfirmSlay = useCallback(async () => {
    if (busy) return;
    if (!deckId) {
      setErrorText(t(lang, '缺少题组信息，无法斩题', 'Missing deck context; cannot slay card'));
      return;
    }
    setBusy(true);
    setErrorText(null);
    const res = await tryAction<ReviewRun>(host, 'card.slay', {
      deckId,
      cardId,
      runId: run.id,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.error?.message || t(lang, '斩题失败', 'Failed to slay card'));
      return;
    }
    if (res.value && typeof res.value === 'object' && 'id' in res.value) {
      onRunUpdated(res.value);
    }
    onRefreshSnapshot?.();
    notify(t(lang, '已斩题：移入斩题组并推进到下一题', 'Card slain and advanced'), 'success');
    onClose();
  }, [busy, deckId, host, cardId, run.id, onRunUpdated, onRefreshSnapshot, notify, lang, onClose]);

  const handleAdjustGrade = useCallback(async () => {
    if (busy || !canAdjustGrade) return;
    setBusy(true);
    setErrorText(null);
    const args: Record<string, unknown> = canAdjustCloze
      ? {
          runId: run.id,
          cardId,
          entryIndex: run.index,
          clozeEquivalent: true,
          saveAccept: true,
        }
      : {
          runId: run.id,
          cardId,
          entryIndex: run.index,
          grade: 4,
        };
    const res = await tryAction<ReviewRun>(host, 'review.grade.adjust', args);
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok || !res.value) {
      setErrorText(res.error?.message || t(lang, '等效改判失败', 'Failed to adjust grade'));
      return;
    }
    onRunUpdated(res.value);
    onRefreshSnapshot?.();
    notify(t(lang, '已等效改判为正确', 'Judgment overridden as equivalent/correct'), 'success');
    onClose();
  }, [busy, canAdjustGrade, canAdjustCloze, run.id, run.index, cardId, host, onRunUpdated, onRefreshSnapshot, notify, lang, onClose]);

  const handleToggleFocus = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErrorText(null);
    const res = await tryAction<{ ok?: boolean; focus?: boolean }>(host, 'card.focus', {
      ...(deckId ? { deckId } : {}),
      cardId,
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      setErrorText(res.error?.message || t(lang, '更新考纲重点标记失败', 'Failed to toggle focus'));
      return;
    }
    const nextFocus = typeof res.value?.focus === 'boolean' ? res.value.focus : !focusedCard;
    setFocusedCard(nextFocus);
    onFocusChanged?.(cardId, nextFocus);
    onRefreshSnapshot?.();
    notify(
      nextFocus
        ? t(lang, '已标为考纲重点（优先复习）', 'Marked as Focus (priority review)')
        : t(lang, '已取消考纲重点标记', 'Removed Focus mark'),
      'success',
    );
    onClose();
  }, [busy, deckId, cardId, host, focusedCard, onFocusChanged, onRefreshSnapshot, notify, lang, onClose]);

  const handleExtractTerms = useCallback(async () => {
    if (termsLoading) return;
    setMode('terms');
    setErrorText(null);
    setTermsError(null);
    setTermsLoading(true);
    const res = await tryAction<{ cached?: boolean; terms?: unknown }>(host, 'card.terms', {
      ...(deckId ? { deckId } : {}),
      cardId,
    });
    if (!mountedRef.current) return;
    setTermsLoading(false);
    if (!res.ok || !res.value) {
      setTermsError(res.error?.message || t(lang, '提取核心术语失败', 'Failed to extract technical terms'));
      return;
    }
    setTermsCached(Boolean(res.value.cached));
    setTermsItems(normalizeExtractedTerms(res.value.terms));
  }, [termsLoading, host, deckId, cardId, lang]);

  const handleRevertCard = useCallback(async () => {
    if (busy) return;
    const effectiveDeckId = resolvedDeckId || deckId;
    setBusy(true);
    setErrorText(null);
    const res = await tryAction<{ reverted?: string }>(host, 'card.revert', {
      ...(effectiveDeckId ? { deckId: effectiveDeckId } : {}),
      cardId,
    });
    if (!mountedRef.current) return;
    if (!res.ok) {
      setBusy(false);
      setErrorText(res.error?.message || t(lang, '撤销修改失败', 'Failed to revert last edit'));
      return;
    }
    onCardEdited?.(cardId);
    try {
      const refreshed = await getReview(host, run.id);
      if (!mountedRef.current) return;
      onRunUpdated(refreshed);
    } catch {
      // card.revert succeeded even if run refresh failed
    }
    if (!mountedRef.current) return;
    setBusy(false);
    onRefreshSnapshot?.();
    const reasonSuffix = res.value?.reverted ? ` (${res.value.reverted})` : '';
    notify(
      t(lang, `已撤销上次修改并刷新当前复习${reasonSuffix}`, `Reverted last edit and refreshed review${reasonSuffix}`),
      'success',
    );
    onClose();
  }, [busy, resolvedDeckId, deckId, host, cardId, lang, onCardEdited, run.id, onRunUpdated, onRefreshSnapshot, notify, onClose]);

  const handleSubmitFeedback = useCallback(
    async (vote: 'up' | 'down', tagsOverride?: string[]) => {
      if (busyRef.current || busy) return;
      const effectiveDeckId = resolvedDeckId || deckId;
      const chosenTags = vote === 'down' ? [...new Set(tagsOverride ?? selectedFeedbackTags)] : [];
      busyRef.current = true;
      setBusy(true);
      setErrorText(null);
      setInfoText(null);
      const res = await tryAction<{ vote?: string; tags?: string[]; scheduled?: string[]; fix?: string[] }>(
        host,
        'coach.feedback',
        {
          ...(effectiveDeckId ? { deckId: effectiveDeckId } : {}),
          cardId,
          vote,
          ...(chosenTags.length > 0 ? { tags: chosenTags } : {}),
          rewriteVia: 'assist',
        },
      );
      if (!mountedRef.current) return;
      busyRef.current = false;
      setBusy(false);
      if (!res.ok) {
        const msg = res.error?.message || t(lang, '提交题目反馈失败', 'Failed to submit card feedback');
        setErrorText(msg);
        notify(msg, 'error');
        return;
      }
      setLastFeedbackVote(vote);
      onRefreshSnapshot?.();
      if (vote === 'up') {
        notify(t(lang, '已记录正面题目反馈（不错）', 'Recorded positive feedback (Good)'), 'success');
      } else if (chosenTags.length > 0) {
        notify(
          t(
            lang,
            `已记录问题反馈（${chosenTags.length} 个标签，不触发静默后台改题）`,
            `Feedback recorded (${chosenTags.length} tag(s); no silent AI rewrite)`,
          ),
          'success',
        );
      } else {
        notify(t(lang, '已记录题目问题反馈', 'Recorded card quality downvote'), 'success');
      }
      setMode('menu');
    },
    [busy, resolvedDeckId, deckId, selectedFeedbackTags, host, cardId, lang, notify, onRefreshSnapshot],
  );

  const handleConfirmCoachRevert = useCallback(async () => {
    if (busyRef.current || busy) return;
    setConfirmCoachRevert(false);
    const effectiveDeckId = resolvedDeckId || deckId;
    busyRef.current = true;
    setBusy(true);
    setErrorText(null);
    setInfoText(null);
    const res = await tryAction<{ reverted?: string }>(host, 'coach.revert', {
      ...(effectiveDeckId ? { deckId: effectiveDeckId } : {}),
      cardId,
    });
    if (!mountedRef.current) return;
    if (!res.ok) {
      busyRef.current = false;
      setBusy(false);
      const msg = res.error?.message || t(lang, '撤销改写失败', 'Failed to revert rewrite');
      setErrorText(msg);
      notify(msg, 'error');
      return;
    }
    onCardEdited?.(cardId);
    try {
      const refreshed = await getReview(host, run.id);
      if (!mountedRef.current) return;
      onRunUpdated(refreshed);
    } catch {
      // coach.revert succeeded even if run refresh failed
    }
    await hydrateCardDetails();
    if (!mountedRef.current) return;
    busyRef.current = false;
    setBusy(false);
    onRefreshSnapshot?.();
    const reasonSuffix = res.value?.reverted ? ` (${res.value.reverted})` : '';
    notify(
      t(lang, `已撤销上次改写并刷新当前复习${reasonSuffix}`, `Reverted last rewrite and refreshed review${reasonSuffix}`),
      'success',
    );
    onClose();
  }, [
    busy,
    resolvedDeckId,
    deckId,
    host,
    cardId,
    lang,
    notify,
    onCardEdited,
    run.id,
    onRunUpdated,
    hydrateCardDetails,
    onRefreshSnapshot,
    onClose,
  ]);

  const handleConfirmRetryRewrite = useCallback(async () => {
    if (busyRef.current || busy) return;
    const effectiveDeckId = resolvedDeckId || deckId;
    busyRef.current = true;
    setBusy(true);
    setErrorText(null);
    setInfoText(null);
    const res = await tryAction<unknown>(host, 'coach.rewrite.retry', {
      ...(effectiveDeckId ? { deckId: effectiveDeckId } : {}),
      cardId,
    });
    if (!mountedRef.current) return;
    busyRef.current = false;
    setBusy(false);
    setMode('menu');
    if (!res.ok) {
      const msg = res.error?.message || t(lang, '重试 AI 改题失败', 'Failed to retry AI rewrite');
      setInfoText(msg);
      notify(msg, 'warning');
      return;
    }
    onRefreshSnapshot?.();
    const okMsg = t(lang, '已重新排队 AI 改题任务', 'Re-queued AI rewrite task');
    setInfoText(okMsg);
    notify(okMsg, 'success');
  }, [busy, resolvedDeckId, deckId, host, cardId, lang, notify, onRefreshSnapshot]);

  const openPrereqsMode = useCallback(async () => {
    setMode('prereqs');
    setErrorText(null);
    setPrereqSearchActive(false);
    setPrereqSearchFocused(false);
    setPrereqQuery('');
    setPrereqHits([]);
    setPrereqHitCursor(0);
    setPrereqCursor(0);
    lastSearchedQueryRef.current = '';
    setPrereqsLoading(true);
    await hydrateCardDetails();
    if (!mountedRef.current) return;
    setPrereqsLoading(false);
  }, [hydrateCardDetails]);

  const performPrereqSearch = useCallback(
    async (rawQuery: string, opts?: { focusResultsOnDone?: boolean }) => {
      const trimmed = rawQuery.trim();
      const seq = ++prereqSearchSeqRef.current;
      if (!trimmed) {
        setPrereqSearchLoading(false);
        setPrereqHits([]);
        setPrereqHitCursor(0);
        lastSearchedQueryRef.current = '';
        return;
      }
      setPrereqSearchLoading(true);
      setErrorText(null);
      const res = await tryAction<{ results?: CardSearchHit[] }>(host, 'card.search', {
        query: trimmed,
        limit: 8,
      });
      if (!mountedRef.current || seq !== prereqSearchSeqRef.current) return;
      setPrereqSearchLoading(false);
      if (!res.ok) {
        setErrorText(res.error?.message || t(lang, '搜索题目失败', 'Failed to search cards'));
        return;
      }
      const list = Array.isArray(res.value?.results) ? res.value.results : [];
      const filtered = list.filter((hit) => hit && typeof hit.cardId === 'string' && hit.cardId !== cardId);
      lastSearchedQueryRef.current = trimmed;
      setPrereqHits(filtered);
      setPrereqHitCursor(0);
      if (opts?.focusResultsOnDone && filtered.length > 0) {
        setPrereqSearchFocused(false);
      }
    },
    [host, cardId, lang],
  );

  useEffect(() => {
    if (mode !== 'prereqs' || !prereqSearchActive) return;
    const trimmed = prereqQuery.trim();
    if (!trimmed) {
      prereqSearchSeqRef.current += 1;
      lastSearchedQueryRef.current = '';
      setPrereqSearchLoading(false);
      setPrereqHits([]);
      setPrereqHitCursor(0);
      return;
    }
    const timer = setTimeout(() => {
      void performPrereqSearch(trimmed);
    }, 180);
    return () => clearTimeout(timer);
  }, [mode, prereqSearchActive, prereqQuery, performPrereqSearch]);

  const handleLinkPrereq = useCallback(
    async (hit: CardSearchHit) => {
      if (busy) return;
      const effectiveDeckId = resolvedDeckId || deckId;
      setBusy(true);
      setErrorText(null);
      const res = await tryAction<{ linked?: boolean; existing?: boolean }>(host, 'card.link', {
        ...(effectiveDeckId ? { deckId: effectiveDeckId } : {}),
        cardId,
        requires: {
          cardId: hit.cardId,
          deckId: hit.deckId,
        },
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setBusy(false);
        const msg = res.error?.message || t(lang, '关联前置题目失败', 'Failed to link prerequisite');
        setErrorText(msg);
        notify(msg, 'error');
        return;
      }
      await hydrateCardDetails();
      if (!mountedRef.current) return;
      setBusy(false);
      setPrereqSearchActive(false);
      setPrereqSearchFocused(false);
      setPrereqCursor(0);
      onRefreshSnapshot?.();
      notify(
        res.value?.existing
          ? t(lang, '该前置题目已存在关联', 'Prerequisite already linked')
          : t(lang, '已关联前置题目', 'Prerequisite linked'),
        'success',
      );
    },
    [busy, resolvedDeckId, deckId, host, cardId, lang, notify, hydrateCardDetails, onRefreshSnapshot],
  );

  const handleUnlinkPrereq = useCallback(
    async (item: PrereqItem) => {
      if (busy) return;
      const effectiveDeckId = resolvedDeckId || deckId;
      setBusy(true);
      setErrorText(null);
      const res = await tryAction<{ linked?: boolean }>(host, 'card.link', {
        ...(effectiveDeckId ? { deckId: effectiveDeckId } : {}),
        cardId,
        requires: {
          cardId: item.cardId,
          deckId: item.deckId,
        },
        remove: true,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setBusy(false);
        const msg = res.error?.message || t(lang, '移除前置题目失败', 'Failed to unlink prerequisite');
        setErrorText(msg);
        notify(msg, 'error');
        return;
      }
      const prevLen = prereqs.length;
      await hydrateCardDetails();
      if (!mountedRef.current) return;
      setBusy(false);
      setPrereqCursor((cur) => Math.max(0, Math.min(cur, Math.max(0, prevLen - 2))));
      onRefreshSnapshot?.();
      notify(t(lang, '已移除前置题目关联', 'Prerequisite link removed'), 'success');
    },
    [busy, resolvedDeckId, deckId, host, cardId, lang, notify, prereqs.length, hydrateCardDetails, onRefreshSnapshot],
  );

  const MENU_COUNT = 11;

  const triggerOption = useCallback(
    (idx: number) => {
      setErrorText(null);
      setInfoText(null);
      if (idx === 0) {
        setEditField('prompt');
        setMode('edit');
      } else if (idx === 1) {
        void handleToggleSuspend();
      } else if (idx === 2) {
        setMode('confirm-slay');
      } else if (idx === 3) {
        if (!canAdjustGrade) {
          setErrorText(
            t(
              lang,
              '仅当填空题刚判错或简答题刚完成 AI 批改时可等效改判',
              'Available only after an auto-graded cloze or rubric-graded short answer',
            ),
          );
          return;
        }
        void handleAdjustGrade();
      } else if (idx === 4) {
        void handleToggleFocus();
      } else if (idx === 5) {
        void handleExtractTerms();
      } else if (idx === 6) {
        void handleRevertCard();
      } else if (idx === 7) {
        void openPrereqsMode();
      } else if (idx === 8) {
        setFeedbackTagCursor(0);
        setMode('feedback');
      } else if (idx === 9) {
        if (revisionsCount <= 0) {
          const msg = t(lang, '当前题目暂无可撤销的改写历史', 'No earlier rewrite version exists for this card');
          setInfoText(msg);
          notify(msg, 'info');
          return;
        }
        setConfirmCoachRevert(true);
      } else if (idx === 10) {
        setMode('confirm-retry-rewrite');
      }
    },
    [
      handleToggleSuspend,
      canAdjustGrade,
      handleAdjustGrade,
      handleToggleFocus,
      handleExtractTerms,
      handleRevertCard,
      openPrereqsMode,
      revisionsCount,
      notify,
      lang,
    ],
  );

  useInput(
    (input, key) => {
      if (busyRef.current || busy || termsLoading || prereqsLoading) return;
      if (mode === 'menu') {
        if (key.downArrow || input === 'j') {
          setMenuCursor((prev) => (prev + 1) % MENU_COUNT);
        } else if (key.upArrow || input === 'k') {
          setMenuCursor((prev) => (prev + MENU_COUNT - 1) % MENU_COUNT);
        } else if (/^[1-9]$/.test(input) || input === '0') {
          const idx = input === '0' ? 9 : Number(input) - 1;
          setMenuCursor(idx);
          triggerOption(idx);
        } else if (input === 'R') {
          setMenuCursor(10);
          triggerOption(10);
        } else if (key.return) {
          triggerOption(menuCursor);
        }
        return;
      }
      if (mode === 'feedback') {
        if (key.downArrow || input === 'j') {
          setFeedbackTagCursor((prev) => (prev + 1) % FEEDBACK_TAG_OPTIONS.length);
        } else if (key.upArrow || input === 'k') {
          setFeedbackTagCursor((prev) => (prev + FEEDBACK_TAG_OPTIONS.length - 1) % FEEDBACK_TAG_OPTIONS.length);
        } else if (input === ' ') {
          const tagKey = FEEDBACK_TAG_OPTIONS[feedbackTagCursor]?.key;
          if (tagKey) {
            setSelectedFeedbackTags((prev) =>
              prev.includes(tagKey) ? prev.filter((item) => item !== tagKey) : [...prev, tagKey],
            );
          }
        } else if (/^[1-8]$/.test(input)) {
          const idx = Number(input) - 1;
          setFeedbackTagCursor(idx);
          const tagKey = FEEDBACK_TAG_OPTIONS[idx]?.key;
          if (tagKey) {
            setSelectedFeedbackTags((prev) =>
              prev.includes(tagKey) ? prev.filter((item) => item !== tagKey) : [...prev, tagKey],
            );
          }
        } else if (input === 'u' || input === 'U') {
          void handleSubmitFeedback('up');
        } else if (input === 'd' || input === 'D' || key.return) {
          void handleSubmitFeedback('down');
        }
        return;
      }
      if (mode === 'terms') {
        if (input === 'r') {
          void handleExtractTerms();
        }
        return;
      }
      if (mode === 'prereqs') {
        if (prereqSearchActive) {
          if (prereqSearchFocused) {
            if (key.downArrow && prereqHits.length > 0) {
              setPrereqSearchFocused(false);
              setPrereqHitCursor(0);
            }
            return;
          }
          if (key.downArrow || input === 'j') {
            if (prereqHits.length > 0) {
              setPrereqHitCursor((prev) => (prev + 1) % prereqHits.length);
            }
          } else if (key.upArrow || input === 'k') {
            if (prereqHitCursor === 0 && key.upArrow) {
              setPrereqSearchFocused(true);
            } else if (prereqHits.length > 0) {
              setPrereqHitCursor((prev) => (prev + prereqHits.length - 1) % prereqHits.length);
            }
          } else if (key.tab || input === '/') {
            setPrereqSearchFocused(true);
          } else if (key.return) {
            const target = prereqHits[prereqHitCursor];
            if (target) void handleLinkPrereq(target);
          }
          return;
        }
        if (key.downArrow || input === 'j') {
          if (prereqs.length > 0) {
            setPrereqCursor((prev) => (prev + 1) % prereqs.length);
          }
        } else if (key.upArrow || input === 'k') {
          if (prereqs.length > 0) {
            setPrereqCursor((prev) => (prev + prereqs.length - 1) % prereqs.length);
          }
        } else if (input === 'a' || input === '/' || (key.return && prereqs.length === 0)) {
          setErrorText(null);
          setPrereqSearchActive(true);
          setPrereqSearchFocused(true);
        } else if (input === 'd' || key.delete || key.backspace) {
          const target = prereqs[prereqCursor];
          if (target) void handleUnlinkPrereq(target);
        } else if (input === 'r') {
          void openPrereqsMode();
        }
        return;
      }
      if (mode === 'confirm-slay') {
        if (input === 'y' || input === 'Y' || key.return) {
          void handleConfirmSlay();
        } else if (input === 'n' || input === 'N') {
          setMode('menu');
        }
      }
    },
    { isActive: isActive && mode !== 'edit' && mode !== 'confirm-retry-rewrite' && !confirmCoachRevert && !(mode === 'terms' && termsFollowupEngaged) },
  );

  const cycleEditField = useCallback(() => {
    const order: EditField[] = canEditAnswer ? ['prompt', 'answer', 'explanation'] : ['prompt', 'explanation'];
    setEditField((cur) => {
      const idx = order.indexOf(cur);
      return order[(idx + 1) % order.length];
    });
  }, [canEditAnswer]);

  const { rows } = useStableWindowSize();
  const frameW = Math.max(50, Math.min(82, width - 4));
  const innerW = modalContentWidth(frameW);
  const inputH = height <= 25 ? 2 : 3;
  const subFrameH = mode === 'terms' || mode === 'prereqs' ? Math.max(14, Math.min(28, height - 2)) : undefined;
  const errorLines = errorText ? wrapToRows(`${asciiMode ? 'x' : '✕'} ${errorText}`, Math.max(10, innerW), 2, ell) : [];
  const subBodyH = subFrameH ? Math.max(6, modalChildRows(subFrameH, rows, true)) : 10;
  const prereqsContentH = Math.max(5, subBodyH - (busy ? 1 : 0) - errorLines.length);

  const hints = useMemo<KeyHint[]>(() => {
    if (mode === 'edit') {
      return [
        { key: 'Tab', label: t(lang, '切换字段', 'Field') },
        { key: 'Enter/Ctrl+S', label: t(lang, '保存', 'Save') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (mode === 'confirm-slay') {
      return [
        { key: 'y/Enter', label: t(lang, '确认斩题', 'Confirm') },
        { key: 'n/Esc', label: t(lang, '取消', 'Cancel') },
      ];
    }
    if (mode === 'terms') {
      return [
        { key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '滚动', 'Scroll') },
        { key: 'a', label: t(lang, '后续指令', 'Next step') },
        { key: 'r', label: t(lang, '重试', 'Retry') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (mode === 'prereqs') {
      if (prereqSearchActive) {
        if (prereqSearchFocused) {
          return [
            { key: 'Enter', label: t(lang, '搜索', 'Search') },
            { key: asciiMode ? 'Tab' : 'Tab/↓', label: t(lang, '选结果', 'Results') },
            { key: 'Esc', label: t(lang, '取消', 'Back') },
          ];
        }
        return [
          { key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '选择', 'Select') },
          { key: 'Enter', label: t(lang, '关联', 'Link') },
          { key: 'Tab', label: t(lang, '搜题', 'Search') },
          { key: 'Esc', label: t(lang, '返回', 'Back') },
        ];
      }
      return [
        { key: 'a', label: t(lang, '添加前置', 'Add') },
        { key: 'd', label: t(lang, '移除', 'Unlink') },
        { key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '移动', 'Move') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    if (mode === 'feedback') {
      return [
        { key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '选标签', 'Tag') },
        { key: 'Space/1-8', label: t(lang, '勾选', 'Toggle') },
        { key: 'u', label: t(lang, '点赞', 'Upvote') },
        { key: 'd/Enter', label: t(lang, '提交问题', 'Downvote') },
        { key: 'Esc', label: t(lang, '返回', 'Back') },
      ];
    }
    return [
      { key: '1-9,0,R / Enter', label: t(lang, '执行', 'Select') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }, [mode, lang, asciiMode, prereqSearchActive, prereqSearchFocused]);

  const termLines = useMemo<string[]>(() => {
    if (termsItems.length === 0) return [];
    const textW = Math.max(12, innerW - 2);
    const lines: string[] = [];
    termsItems.forEach((item, idx) => {
      const head = `${idx + 1}. ${item.term}`;
      lines.push(...wrapDisplay(head, textW));
      if (item.definition) {
        lines.push(...wrapDisplay(`   ${item.definition}`, textW));
      }
      if (idx + 1 < termsItems.length) lines.push('');
    });
    return lines;
  }, [termsItems, innerW]);

  const menuItems = [
    {
      key: '1',
      title: t(lang, '编辑题目', 'Edit Question'),
      desc: t(lang, '修改题干、参考答案或解析并刷新队列', 'Edit prompt, reference answer, or explanation'),
      enabled: true,
      badge: t(lang, '可编辑', 'Edit'),
    },
    {
      key: '2',
      title: suspended ? t(lang, '恢复题目', 'Resume Card') : t(lang, '暂停题目', 'Suspend Card'),
      desc: suspended
        ? t(lang, '当前已暂停：恢复到每日复习队列', 'Currently suspended: restore to queue')
        : t(lang, '暂离每日队列但不删除题目与记录', 'Pause from daily queue without deleting'),
      enabled: true,
      badge: suspended ? t(lang, '已暂停', 'Paused') : t(lang, '激活中', 'Active'),
    },
    {
      key: '3',
      title: t(lang, '斩题 / 永久掌握', 'Slay / Mastered'),
      desc: t(lang, '移入斩题组不再复习，并推进下一题', 'Move to Slain deck and advance'),
      enabled: true,
      badge: t(lang, '移出队列', 'Master'),
    },
    {
      key: '4',
      title: t(lang, '判分等效改判', 'Override Grade'),
      desc: canAdjustGrade
        ? t(lang, '将本题自动判分改判为等效/正确', 'Mark current auto-graded answer as equivalent')
        : t(lang, '需在填空错题或 AI 批改简答题后使用', 'Available after auto-graded cloze or open rubric'),
      enabled: canAdjustGrade,
      badge: canAdjustGrade ? t(lang, '可用', 'Ready') : t(lang, '暂不可用', 'N/A'),
    },
    {
      key: '5',
      title: focusedCard ? t(lang, '取消考纲重点', 'Remove Focus Mark') : t(lang, '标为考纲重点', 'Mark as Focus'),
      desc: focusedCard
        ? t(lang, '当前已标为重点：点击移除重点标记', 'Currently marked Focus: clear mark')
        : t(lang, '标为考纲重点，优先安排复习', 'Mark syllabus focus for priority review'),
      enabled: true,
      badge: focusedCard
        ? asciiMode
          ? lang === 'en'
            ? '* Focus'
            : '* 重点'
          : lang === 'en'
            ? '★ Focus'
            : '★ 重点'
        : t(lang, '未标记', 'Normal'),
    },
    {
      key: '6',
      title: t(lang, '提取核心术语 / 生词', 'Extract Technical Terms'),
      desc: t(lang, 'AI 识别本题中的关键专业术语与生词', 'Extract unfamiliar technical terms with AI'),
      enabled: true,
      badge: t(lang, 'AI 提取', 'AI'),
    },
    {
      key: '7',
      title: t(lang, '撤销上次修改', 'Undo Last Edit'),
      desc:
        revisionsCount > 0
          ? t(lang, '恢复题目上一版本内容并刷新当前复习', 'Revert question to previous revision and refresh review')
          : t(lang, '当前暂无可撤销的修改历史', 'No earlier revision recorded for this card'),
      enabled: revisionsCount > 0,
      badge: revisionsCount > 0 ? t(lang, `${revisionsCount} 版`, `${revisionsCount} rev`) : t(lang, '无历史', 'None'),
    },
    {
      key: '8',
      title: t(lang, '前置题目关联', 'Prerequisite Links'),
      desc: t(lang, '查看、搜索并管理本题依赖的前置题目', 'View, search, and link/unlink prerequisite cards'),
      enabled: true,
      badge: prereqs.length > 0 ? t(lang, `${prereqs.length} 题`, `${prereqs.length} linked`) : t(lang, '未关联', 'None'),
    },
    {
      key: '9',
      title: t(lang, '题目质量反馈', 'Card Quality Feedback'),
      desc: t(lang, '点赞或选择问题标签反馈，不触发静默后台改题', 'Upvote or report quality tags safely'),
      enabled: true,
      badge:
        lastFeedbackVote === 'up'
          ? t(lang, '已赞', 'Upvoted')
          : lastFeedbackVote === 'down'
            ? t(lang, '已反馈', 'Flagged')
            : t(lang, '去反馈', 'Rate'),
    },
    {
      key: '0',
      title: t(lang, '撤销上次改写', 'Revert Last Rewrite'),
      desc:
        revisionsCount > 0
          ? t(lang, '确认后回退教练改写并刷新当前复习', 'Confirm revert to previous version and refresh review')
          : t(lang, '当前暂无可撤销的改写历史', 'No earlier rewrite version recorded'),
      enabled: revisionsCount > 0,
      badge: revisionsCount > 0 ? t(lang, `${revisionsCount} 版`, `${revisionsCount} rev`) : t(lang, '无历史', 'None'),
    },
    {
      key: 'R',
      title: t(lang, '重试失败的 AI 改题', 'Retry Failed AI Rewrite'),
      desc: t(lang, '确认后重新排队此前失败的教练改题任务', 'Confirm and re-queue a failed AI rewrite task'),
      enabled: true,
      badge: t(lang, '重试任务', 'Retry'),
    },
  ];

  const placementSummary = useMemo(() => {
    if (!cardPlaceInfo) return null;
    const sep = asciiMode ? ' > ' : ' › ';
    const docTitle = typeof cardPlaceInfo.document?.title === 'string' ? cardPlaceInfo.document.title.trim() : '';
    const chapterTitle = typeof cardPlaceInfo.chapter?.title === 'string' ? cardPlaceInfo.chapter.title.trim() : '';
    const leafTitle = typeof cardPlaceInfo.leaf?.title === 'string' ? cardPlaceInfo.leaf.title.trim() : '';
    const sourceText = docTitle && chapterTitle ? `${docTitle}${sep}${chapterTitle}` : docTitle || chapterTitle;
    const bookText = leafTitle
      ? `${leafTitle}${cardPlaceInfo.leaf?.built === false ? (lang === 'en' ? ' (unbuilt)' : ' (未生成)') : ''}`
      : '';
    const courseText = typeof cardPlaceInfo.course === 'string' ? cardPlaceInfo.course.trim() : '';
    if (!sourceText && !bookText && !courseText) return null;
    return { sourceText, bookText, courseText };
  }, [cardPlaceInfo, asciiMode, lang]);

  const placementRows = placementSummary ? (placementSummary.bookText ? 1 : 0) + (placementSummary.sourceText || (!placementSummary.bookText && placementSummary.courseText) ? 1 : 0) + 1 : 0;
  const menuHeaderRows = placementRows + (busy ? 1 : 0) + errorLines.length + (infoText ? 1 : 0);
  const maxMenuFrameH = Math.max(10, modalFrameHeight(rows, rows));
  const menuHasHints = hints.length > 0;
  const compactMenu = rows <= (placementSummary ? 32 : 28) || height <= (placementSummary ? 32 : 28) || 4 + (menuHasHints ? 1 : 0) + menuHeaderRows + menuItems.length * 2 > maxMenuFrameH;
  const fixedFrameH = mode === 'menu' ? Math.min(maxMenuFrameH, 4 + (menuHasHints ? 1 : 0) + menuHeaderRows + menuItems.length * (compactMenu ? 1 : 2)) : subFrameH;
  const menuItemRowsAvail = Math.max(1, (fixedFrameH !== undefined ? modalChildRows(fixedFrameH, rows, menuHasHints) : menuItems.length) - menuHeaderRows);
  const menuScrollNeeded = compactMenu && menuItemRowsAvail < menuItems.length;
  const menuSlots = menuScrollNeeded ? Math.max(1, menuItemRowsAvail - 1) : menuItems.length;
  const menuStart = menuScrollNeeded ? Math.max(0, Math.min(menuCursor - Math.floor(menuSlots / 2), menuItems.length - menuSlots)) : 0;
  const visibleMenuItems = menuScrollNeeded ? menuItems.slice(menuStart, menuStart + menuSlots) : menuItems;
  const linkedPrereqIds = new Set(prereqs.map((p) => p.cardId));

  // Windowed slices for 'prereqs' lists so 80x24 never overflows
  const showPrereqDetailRow = height >= 28 && !prereqSearchActive && prereqs.length > 0;
  const prereqListRows = Math.max(3, prereqsContentH - 2 - (showPrereqDetailRow ? 1 : 0));
  const prereqStart = Math.max(0, Math.min(prereqCursor - Math.floor(prereqListRows / 2), Math.max(0, prereqs.length - prereqListRows)));
  const visiblePrereqs = prereqs.slice(prereqStart, prereqStart + prereqListRows);
  const selectedPrereq = prereqs[prereqCursor];

  const searchHitRows = Math.max(3, prereqsContentH - 6);
  const hitStart = Math.max(0, Math.min(prereqHitCursor - Math.floor(searchHitRows / 2), Math.max(0, prereqHits.length - searchHitRows)));
  const visibleHits = prereqHits.slice(hitStart, hitStart + searchHitRows);

  const modalTitle =
    mode === 'terms'
      ? t(lang, '核心术语 / 生词提取', 'Technical Terms')
      : mode === 'prereqs'
        ? t(lang, '前置题目关联', 'Prerequisite Links')
        : mode === 'feedback'
          ? t(lang, '题目质量反馈', 'Card Quality Feedback')
          : t(lang, '题目工具箱', 'Card Tools');

  const handleModalClose = () => {
    if (mode === 'menu') {
      onClose();
      return;
    }
    if (mode === 'prereqs' && prereqSearchActive) {
      setPrereqSearchActive(false);
      setPrereqSearchFocused(false);
      setErrorText(null);
      return;
    }
    setErrorText(null);
    setInfoText(null);
    setMode('menu');
  };

  return (
    <>
      <Modal
        title={modalTitle}
        icon={asciiMode ? '*' : '⚙'}
        tone={mode === 'confirm-slay' ? 'error' : mode === 'terms' ? 'ai' : 'accent'}
        subtitle={
          editDirty
            ? t(lang, '未保存', 'unsaved')
            : truncateDisplay(String(run.card?.topic || cardId), 24, ell)
        }
        width={frameW}
        height={fixedFrameH}
        onClose={handleModalClose}
        isActive={isActive && mode !== 'edit' && mode !== 'confirm-retry-rewrite' && !confirmCoachRevert && !confirmDiscardEdit && !(mode === 'prereqs' && prereqSearchActive && prereqSearchFocused) && !(mode === 'terms' && termsFollowupEngaged)}
        hints={hints}
      >
        {mode === 'menu' && placementSummary ? (
          <Box flexDirection="column" width={innerW} marginBottom={0}>
            {placementSummary.bookText ? (
              <Text color={theme.accent} wrap="truncate">
                {truncateDisplay(
                  `${asciiMode ? '*' : '▤'} ${t(lang, '复习全书', 'Review Book')}: ${placementSummary.bookText}`,
                  innerW,
                  ell,
                )}
              </Text>
            ) : null}
            {placementSummary.sourceText ? (
              <Text color={theme.muted} wrap="truncate">
                {truncateDisplay(
                  `${asciiMode ? '#' : '◈'} ${t(lang, '资料出处', 'Source')}: ${placementSummary.sourceText}`,
                  innerW,
                  ell,
                )}
              </Text>
            ) : !placementSummary.bookText && placementSummary.courseText ? (
              <Text color={theme.dim} wrap="truncate">
                {truncateDisplay(
                  `${asciiMode ? '-' : '•'} ${t(lang, '所属课程', 'Course')}: ${placementSummary.courseText} (${t(lang, '暂未关联章节出处', 'no chapter/source link')})`,
                  innerW,
                  ell,
                )}
              </Text>
            ) : null}
            <Divider width={innerW} />
          </Box>
        ) : null}
        {busy ? (
          <Box height={1} marginY={0}>
            <Spinner label={t(lang, `正在提交操作${ell}`, `Applying action${ell}`)} active={isActive && !confirmCoachRevert && mode !== 'confirm-retry-rewrite'} />
          </Box>
        ) : null}

        {errorLines.length > 0 ? (
          <Box flexDirection="column" marginBottom={0}>
            {errorLines.map((line, i) => <Text key={i} color={theme.error} wrap="truncate-end">{line}</Text>)}
          </Box>
        ) : null}

        {infoText ? (
          <Box marginBottom={0}>
            <Text color={theme.accent}>{`${asciiMode ? '-' : '•'} ${truncateDisplay(infoText, innerW - 2, ell)}`}</Text>
          </Box>
        ) : null}

      {mode === 'menu' ? (
        <Box flexDirection="column" marginY={0}>
          {visibleMenuItems.map((item, idx) => {
            const realIdx = menuStart + idx;
            const focused = realIdx === menuCursor;
            return (
              <Box key={item.key} flexDirection="column" height={compactMenu ? 1 : undefined} paddingX={1} overflow="hidden" backgroundColor={focused ? theme.selectionBg : undefined}>
                <Box flexDirection="row" justifyContent="space-between" width={Math.max(20, innerW - 2)}>
                  <Text color={focused ? theme.selectionFg : item.enabled ? theme.text : theme.dim} bold={focused} wrap="truncate">
                    {`${focused ? (asciiMode ? '> ' : '▸ ') : '  '}[${item.key}] ${item.title}`}
                  </Text>
                  <Badge label={item.badge} tone={!item.enabled ? 'neutral' : realIdx === 2 ? 'error' : realIdx === 1 && suspended ? 'warning' : 'accent'} variant="soft" />
                </Box>
                {!compactMenu ? <Text color={focused ? theme.selectionFg : theme.muted}>{`      ${truncateDisplay(item.desc, Math.max(12, innerW - 8))}`}</Text> : null}
              </Box>
            );
          })}
          {menuScrollNeeded ? (
            <Box height={1} width={innerW} justifyContent="space-between" overflow="hidden">
              <Text color={theme.dim} wrap="truncate">{`${asciiMode ? 'Up/Dn' : '↑/↓'} ${menuStart + 1}-${menuStart + visibleMenuItems.length}/${menuItems.length}`}</Text>
              <Text color={theme.dim} wrap="truncate">{menuStart > 0 && menuStart + visibleMenuItems.length < menuItems.length ? (asciiMode ? '^ v' : '▲ ▼') : menuStart > 0 ? (asciiMode ? '^' : '▲') : (asciiMode ? 'v' : '▼')}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}

      {mode === 'terms' ? (
        <Box flexDirection="column" width={innerW} height={subBodyH} overflow="hidden">
          <Box flexDirection="row" justifyContent="space-between" width={innerW} height={1}>
            <Box flexDirection="row" gap={1}>
              <Badge
                label={t(lang, `共 ${termsItems.length} 项`, `${termsItems.length} terms`)}
                tone="ai"
                variant="soft"
              />
              {termsCached ? <Badge label="(cached)" tone="neutral" variant="soft" /> : null}
            </Box>
            <Text color={theme.dim}>{t(lang, '[Esc] 返回菜单', '[Esc] Back')}</Text>
          </Box>
          <Divider width={innerW} />
          {termsLoading ? (
            <Box height={Math.max(3, subBodyH - 2)} alignItems="center" justifyContent="center">
              <Spinner label={t(lang, `正在提取本题核心专业术语${ell}`, `Extracting technical terms${ell}`)} tone="ai" active={isActive} />
            </Box>
          ) : termsError ? (
            <Box height={Math.max(3, subBodyH - 2)} flexDirection="column" justifyContent="center" gap={1}>
              <Text color={theme.error} bold wrap="wrap">
                {`${asciiMode ? '!' : '▲'} ${termsError}`}
              </Text>
              <Text color={theme.muted}>
                {t(
                  lang,
                  '请确认已在设置中配置可用 AI 模型，按 [r] 重试或按 [Esc] 返回工具菜单。',
                  'Ensure a working AI model is configured in Settings. Press [r] to retry or [Esc] to go back.',
                )}
              </Text>
            </Box>
          ) : termsItems.length === 0 ? (
            <EmptyState
              icon={asciiMode ? 'o' : '◌'}
              title={t(lang, '未识别到需要额外解释的生僻术语', 'No unfamiliar technical terms found')}
              hint={t(lang, '本题涉及的术语可能均已掌握，或题干较简明。', 'Terms in this card may already be mastered or self-explanatory.')}
              width={innerW}
              height={Math.max(4, subBodyH - 2)}
            />
          ) : (
            <Box flexDirection="column" width={innerW} height={Math.max(4, subBodyH - 2)} overflow="hidden">
              <ScrollView
                lines={termLines}
                width={innerW}
                height={Math.max(
                  3,
                  subBodyH - 2 - (termsFollowupEngaged ? Math.min(11, Math.max(8, Math.floor((subBodyH - 2) * 0.58))) : 3),
                )}
                isActive={isActive && mode === 'terms' && !termsLoading && !termsFollowupEngaged}
              />
              <NextStepFollowupBar
                host={host}
                run={run}
                cardId={cardId}
                kind={kind}
                toolLabel={t(lang, '生词提取', 'Vocab Extraction')}
                resultContext={termsItems
                  .map((it, idx) => `${idx + 1}. ${it.term}${it.definition ? `: ${it.definition}` : ''}`)
                  .join('\n')}
                width={innerW}
                expandedHeight={Math.min(11, Math.max(8, Math.floor((subBodyH - 2) * 0.58)))}
                isActive={isActive && mode === 'terms' && !termsLoading && termsItems.length > 0}
                onFocusChange={setTermsFollowupEngaged}
              />
            </Box>
          )}
        </Box>
      ) : null}

      {mode === 'prereqs' ? (
        <Box flexDirection="column" width={innerW} height={prereqsContentH} overflow="hidden">
          <Box flexDirection="row" justifyContent="space-between" width={innerW} height={1}>
            <Box flexDirection="row" gap={1}>
              <Badge
                label={
                  prereqSearchActive
                    ? t(lang, `搜索结果 ${prereqHits.length} 题`, `${prereqHits.length} hits`)
                    : t(lang, `已关联 ${prereqs.length} 题`, `${prereqs.length} linked`)
                }
                tone="accent"
                variant="soft"
              />
              {prereqSearchActive ? (
                <Text color={theme.muted}>
                  {t(lang, '输入关键词搜索前置题', 'Search cards to link')}
                </Text>
              ) : null}
            </Box>
            <Text color={theme.dim}>
              {prereqSearchActive ? t(lang, '[Esc] 返回列表', '[Esc] List') : t(lang, '[a] 添加  [d] 移除', '[a] Add  [d] Unlink')}
            </Text>
          </Box>
          <Divider width={innerW} />

          {prereqSearchActive ? (
            <Box flexDirection="column" width={innerW} height={Math.max(3, prereqsContentH - 2)} overflow="hidden">
              <Box
                borderStyle={asciiMode ? 'classic' : 'single'}
                borderColor={prereqSearchFocused ? theme.primary : theme.border}
                paddingX={1}
                width={innerW}
              >
                <TextInput
                  value={prereqQuery}
                  onChange={setPrereqQuery}
                  placeholder={t(lang, `输入题目关键词（至少 1 字）${ell}`, `Type query to search cards${ell}`)}
                  width={Math.max(12, innerW - 4)}
                  isActive={isActive && mode === 'prereqs' && prereqSearchActive && prereqSearchFocused && !busy}
                  onTab={() => {
                    if (prereqHits.length > 0) setPrereqSearchFocused(false);
                    return undefined;
                  }}
                  onSubmit={(val) => {
                    const trimmed = val.trim();
                    if (!trimmed) return;
                    if (lastSearchedQueryRef.current === trimmed && prereqHits.length > 0 && !prereqSearchLoading) {
                      setPrereqSearchFocused(false);
                      setPrereqHitCursor(0);
                    } else {
                      void performPrereqSearch(trimmed, { focusResultsOnDone: true });
                    }
                  }}
                  onCancel={() => {
                    setPrereqSearchActive(false);
                    setPrereqSearchFocused(false);
                    setErrorText(null);
                  }}
                />
              </Box>
              {prereqSearchLoading ? (
                <Box height={Math.max(2, searchHitRows)} alignItems="center" justifyContent="center">
                  <Spinner label={t(lang, `正在搜索题库${ell}`, `Searching cards${ell}`)} active={isActive} />
                </Box>
              ) : prereqQuery.trim().length === 0 ? (
                <EmptyState
                  icon={asciiMode ? '?' : '⌕'}
                  title={t(lang, '输入关键词并按 Enter 搜索题库', 'Type keywords and press Enter to search')}
                  hint={t(lang, '将从其他题目中筛选并关联为当前题的前置依赖', 'Matches other cards (excluding self) to link as prerequisite')}
                  width={innerW}
                  height={Math.max(3, searchHitRows)}
                />
              ) : prereqHits.length === 0 ? (
                <EmptyState
                  icon={asciiMode ? 'o' : '◌'}
                  title={t(lang, '未找到匹配的其他题目', 'No matching cards found')}
                  hint={t(lang, '请换个关键词重试，或按 Esc 返回关联列表', 'Try another query or press Esc to go back')}
                  width={innerW}
                  height={Math.max(3, searchHitRows)}
                />
              ) : (
                <Box flexDirection="column" width={innerW} height={searchHitRows} overflow="hidden">
                  {visibleHits.map((hit, i) => {
                    const realIdx = hitStart + i;
                    const selected = !prereqSearchFocused && realIdx === prereqHitCursor;
                    const already = linkedPrereqIds.has(hit.cardId);
                    const tag = already ? t(lang, '[已关联]', '[linked]') : hit.topic ? `[${truncateDisplay(hit.topic, 14, ell)}]` : '';
                    const tagW = tag ? displayWidth(tag) + 1 : 0;
                    const promptW = Math.max(12, innerW - 6 - tagW);
                    return (
                      <Box
                        key={`${hit.deckId}:${hit.cardId}`}
                        flexDirection="row"
                        justifyContent="space-between"
                        width={innerW}
                        backgroundColor={selected ? theme.selectionBg : undefined}
                      >
                        <Text color={selected ? theme.selectionFg : theme.text} bold={selected} wrap="truncate">
                          {`${selected ? (asciiMode ? '> ' : '▸ ') : '  '}${truncateDisplay(hit.prompt, promptW, ell)}`}
                        </Text>
                        {tag ? (
                          <Text color={selected ? theme.selectionFg : already ? theme.success : theme.muted}>
                            {tag}
                          </Text>
                        ) : null}
                      </Box>
                    );
                  })}
                </Box>
              )}
            </Box>
          ) : prereqsLoading ? (
            <Box height={Math.max(3, prereqsContentH - 2)} alignItems="center" justifyContent="center">
              <Spinner label={t(lang, `正在加载前置题目${ell}`, `Loading prerequisites${ell}`)} active={isActive} />
            </Box>
          ) : prereqs.length === 0 ? (
            <EmptyState
              icon={asciiMode ? '-' : '◇'}
              title={t(lang, '当前题目暂无前置依赖', 'No prerequisites linked yet')}
              hint={t(lang, '按 [a] 搜索题库中的前置题目并关联', 'Press [a] to search cards and link a prerequisite')}
              width={innerW}
              height={Math.max(4, prereqsContentH - 2)}
            />
          ) : (
            <Box flexDirection="column" width={innerW} height={Math.max(3, prereqsContentH - 2)} overflow="hidden">
              <Box flexDirection="column" width={innerW} height={prereqListRows} overflow="hidden">
                {visiblePrereqs.map((item, i) => {
                  const realIdx = prereqStart + i;
                  const selected = realIdx === prereqCursor;
                  const levelTag = item.level ? `[${item.level}]` : item.kind ? `[${item.kind}]` : '';
                  const tagW = levelTag ? displayWidth(levelTag) + 1 : 0;
                  const promptW = Math.max(12, innerW - 9 - tagW);
                  return (
                    <Box
                      key={`${item.deckId}:${item.cardId}`}
                      flexDirection="row"
                      justifyContent="space-between"
                      width={innerW}
                      backgroundColor={selected ? theme.selectionBg : undefined}
                    >
                      <Text color={selected ? theme.selectionFg : theme.text} bold={selected} wrap="truncate">
                        {`${selected ? (asciiMode ? '> ' : '▸ ') : '  '}${realIdx + 1}. ${truncateDisplay(item.prompt, promptW)}`}
                      </Text>
                      {levelTag ? (
                        <Text color={selected ? theme.selectionFg : theme.muted}>
                          {levelTag}
                        </Text>
                      ) : null}
                    </Box>
                  );
                })}
              </Box>
              {showPrereqDetailRow && selectedPrereq ? (
                <Text color={theme.dim} wrap="truncate">
                  {truncateDisplay(
                    `${selectedPrereq.deckTitle || selectedPrereq.deckId}${selectedPrereq.topic ? `${asciiMode ? ' | ' : ' · '}${selectedPrereq.topic}` : ''}`,
                    innerW,
                  )}
                </Text>
              ) : null}
            </Box>
          )}
        </Box>
      ) : null}

      {mode === 'edit' ? (
        <Box flexDirection="column" gap={0}>
          <Text color={theme.accent} bold>
            {t(lang, '1. 题干 (prompt)', '1. Stem (prompt)')}
          </Text>
          <Box
            borderStyle={asciiMode ? 'classic' : 'single'}
            borderColor={editField === 'prompt' ? theme.primary : theme.border}
            paddingX={1}
            width={innerW}
          >
            <TextInput
              value={promptDraft}
              onChange={setPromptDraft}
              multiline
              submitOnEnter
              height={inputH}
              width={Math.max(12, innerW - 4)}
              isActive={isActive && mode === 'edit' && !confirmDiscardEdit && editField === 'prompt' && !busy}
              onTab={() => {
                cycleEditField();
                return undefined;
              }}
              onSubmit={() => void handleSaveEdit()}
              onCancel={requestCancelEdit}
            />
          </Box>

          {canEditAnswer ? (
            <>
              <Text color={theme.accent} bold>
                {t(lang, '2. 参考答案 (answer)', '2. Reference Answer')}
              </Text>
              <Box
                borderStyle={asciiMode ? 'classic' : 'single'}
                borderColor={editField === 'answer' ? theme.primary : theme.border}
                paddingX={1}
                width={innerW}
              >
                <TextInput
                  value={answerDraft}
                  onChange={setAnswerDraft}
                  multiline
                  submitOnEnter
                  height={Math.max(1, inputH - 1)}
                  width={Math.max(12, innerW - 4)}
                  isActive={isActive && mode === 'edit' && !confirmDiscardEdit && editField === 'answer' && !busy}
                  onTab={() => {
                    cycleEditField();
                    return undefined;
                  }}
                  onSubmit={() => void handleSaveEdit()}
                  onCancel={requestCancelEdit}
                />
              </Box>
            </>
          ) : null}

          <Text color={theme.accent} bold>
            {t(
              lang,
              `${canEditAnswer ? '3' : '2'}. 解析 (explanation)`,
              `${canEditAnswer ? '3' : '2'}. Explanation`,
            )}
          </Text>
          <Box
            borderStyle={asciiMode ? 'classic' : 'single'}
            borderColor={editField === 'explanation' ? theme.primary : theme.border}
            paddingX={1}
            width={innerW}
          >
            <TextInput
              value={explanationDraft}
              onChange={setExplanationDraft}
              multiline
              submitOnEnter
              height={inputH}
              width={Math.max(12, innerW - 4)}
              isActive={isActive && mode === 'edit' && !confirmDiscardEdit && editField === 'explanation' && !busy}
              onTab={() => {
                cycleEditField();
                return undefined;
              }}
              onSubmit={() => void handleSaveEdit()}
              onCancel={requestCancelEdit}
            />
          </Box>
        </Box>
      ) : null}

      {mode === 'feedback' ? (
        <Box flexDirection="column" width={innerW} overflow="hidden">
          <Box flexDirection="row" justifyContent="space-between" width={innerW} height={1}>
            <Box flexDirection="row" gap={1}>
              <Badge
                label={t(lang, '[u] 这题不错 (点赞)', '[u] Good (Upvote)')}
                tone={lastFeedbackVote === 'up' ? 'success' : 'accent'}
                variant="soft"
              />
              <Badge
                label={t(
                  lang,
                  `已选 ${selectedFeedbackTags.length} 个标签`,
                  `${selectedFeedbackTags.length} tag(s)`,
                )}
                tone={selectedFeedbackTags.length > 0 ? 'warning' : 'neutral'}
                variant="soft"
              />
            </Box>
            <Text color={theme.dim}>{t(lang, '[Esc] 返回菜单', '[Esc] Back')}</Text>
          </Box>
          <Divider width={innerW} />
          <Box flexDirection="column" width={innerW} overflow="hidden">
            {FEEDBACK_TAG_OPTIONS.map((tag, idx) => {
              const focused = idx === feedbackTagCursor;
              const checked = selectedFeedbackTags.includes(tag.key);
              const boxMark = asciiMode ? (checked ? '[x]' : '[ ]') : checked ? '☑' : '☐';
              const cursorMark = focused ? (asciiMode ? '> ' : '▸ ') : '  ';
              const tagLabel = lang === 'en' ? tag.en : tag.zh;
              return (
                <Box
                  key={tag.key}
                  flexDirection="row"
                  justifyContent="space-between"
                  width={innerW}
                  paddingX={1}
                  backgroundColor={focused ? theme.selectionBg : undefined}
                >
                  <Text
                    color={focused ? theme.selectionFg : checked ? theme.warning : theme.text}
                    bold={focused || checked}
                    wrap="truncate"
                  >
                    {truncateDisplay(`${cursorMark}${boxMark} [${idx + 1}] ${tagLabel}`, Math.max(16, innerW - 2), ell)}
                  </Text>
                </Box>
              );
            })}
          </Box>
          <Divider width={innerW} />
          <Box flexDirection="row" justifyContent="space-between" width={innerW} height={1}>
            <Text color={theme.muted} wrap="truncate">
              {t(
                lang,
                '仅记录反馈，不触发静默后台改题 (rewriteVia: assist)',
                'Safe record only; no silent background AI rewrite',
              )}
            </Text>
            <Text color={theme.accent} bold>
              {t(lang, '[d / Enter] 提交问题', '[d / Enter] Submit')}
            </Text>
          </Box>
        </Box>
      ) : null}

      {mode === 'confirm-slay' ? (
        <Box flexDirection="column" marginY={1} gap={1}>
          <Text color={theme.error} bold>
            {t(lang, '确认永久斩掉这道题？', 'Slay / permanently master this card?')}
          </Text>
          <Text color={theme.text}>
            {t(
              lang,
              '题目将被移入「斩题组」并不再出现在复习计划中，当前队列会自动前进到下一题。',
              'The card will move to the Slain deck and leave future review queues. The current round will advance immediately.',
            )}
          </Text>
          <Divider width={innerW} />
          <Box flexDirection="row" justifyContent="flex-end" gap={2}>
            <Text color={theme.muted}>{t(lang, '[n / Esc] 取消', '[n / Esc] Cancel')}</Text>
            <Text color={theme.error} bold>{t(lang, '[y / Enter] 确认斩题', '[y / Enter] Confirm Slay')}</Text>
          </Box>
        </Box>
      ) : null}
    </Modal>

    {confirmCoachRevert ? (
      <ConfirmDialog
        title={t(lang, '撤销上次改写', 'Revert Last Rewrite')}
        message={t(
          lang,
          `确定通过 coach.revert 将当前题目恢复到上一版本${lastRevisionReason ? `（${lastRevisionReason}）` : ''}？当前改写内容将被回退并刷新复习队列。`,
          `Revert this card to its previous version${lastRevisionReason ? ` (${lastRevisionReason})` : ''} via coach.revert and refresh the active review?`,
        )}
        confirmLabel={t(lang, '确认撤销', 'Revert')}
        cancelLabel={t(lang, '取消', 'Cancel')}
        isActive={isActive && confirmCoachRevert}
        onConfirm={() => void handleConfirmCoachRevert()}
        onCancel={() => setConfirmCoachRevert(false)}
      />
    ) : null}

    {confirmDiscardEdit ? (
      <ConfirmDialog
        title={t(lang, '放弃未保存的题目修改？', 'Discard unsaved card edits?')}
        message={t(
          lang,
          '当前题干/答案/解析仍有未保存的修改。放弃后将恢复原内容并返回工具菜单。',
          'You have unsaved edits to this card. Discarding will restore the original text and return to the menu.',
        )}
        confirmLabel={t(lang, '放弃修改', 'Discard')}
        cancelLabel={t(lang, '继续编辑', 'Keep Editing')}
        danger
        isActive={isActive && confirmDiscardEdit}
        onConfirm={() => {
          setPromptDraft(baselineRef.current.prompt);
          setAnswerDraft(baselineRef.current.answer);
          setExplanationDraft(baselineRef.current.explanation);
          setConfirmDiscardEdit(false);
          setMode('menu');
        }}
        onCancel={() => setConfirmDiscardEdit(false)}
      />
    ) : null}

    {mode === 'confirm-retry-rewrite' ? (
      <ConfirmDialog
        title={t(lang, '重试 AI 改题任务', 'Retry Failed AI Rewrite')}
        message={t(
          lang,
          '确定为本题重新排队此前失败的 AI 改题任务？若取消或本题没有待重试的改题，不会产生模型调用。',
          'Re-queue a failed AI rewrite for this card? Cancelling or having no failed rewrite makes 0 model calls.',
        )}
        confirmLabel={t(lang, '确认重试', 'Retry')}
        cancelLabel={t(lang, '取消', 'Cancel')}
        isActive={isActive && mode === 'confirm-retry-rewrite' && !busy}
        onConfirm={() => void handleConfirmRetryRewrite()}
        onCancel={() => setMode('menu')}
      />
    ) : null}
    </>
  );
});
