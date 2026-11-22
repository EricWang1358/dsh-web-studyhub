import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  Divider,
  MarkdownView,
  Modal,
  Spinner,
  TextInput,
  VirtualList,
  modalContentWidth,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/index.js';
import { startReview, tryAction } from '../../host/index.js';
import { formatLabel, groupSourcesFromSnapshot, type DocumentGroup } from '../sources/source-helpers.js';

export interface DeckCardItem {
  id: string;
  kind?: string;
  topic?: string;
  prompt?: string;
  answer?: string;
  hint?: string;
  rubric?: string;
  options?: Array<{ id: string; text: string; correct?: boolean; explanation?: string }>;
  cloze?: { text?: string; answers?: Array<{ id: string; value: string }> };
  explanation?: string;
  flag?: string;
  suspended?: boolean;
  focus?: boolean;
}

export interface FullDeckDetail {
  id: string;
  title: string;
  course?: string;
  folder?: string;
  archived?: boolean;
  systemKind?: string;
  cards: DeckCardItem[];
}

export interface DeckManageModalProps {
  host: HostClient;
  deckId: string;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onUpdated?: () => void;
}

type ModalMode = 'browse' | 'search' | 'rename' | 'supplement' | 'convert';

const SUPPLEMENT_COUNTS = [3, 5, 10, 15] as const;
const SUPPLEMENT_KINDS = ['mixed', 'quiz', 'multi', 'truefalse', 'flashcard', 'open', 'cloze'] as const;
const CONVERT_TARGETS = ['flashcard', 'open', 'truefalse', 'quiz', 'cloze'] as const;
const MAX_MULTI_SELECT = 100;
type ConvertTargetKind = (typeof CONVERT_TARGETS)[number];

interface ConvertDraft {
  primaryText: string;
  secondaryText: string;
  tfIsTrue: boolean;
}

function supplementKindLabel(kind: string, lang: 'zh' | 'en'): string {
  if (kind === 'mixed') return lang === 'en' ? 'Mixed' : '混合';
  return kindLabel(kind, lang);
}

function buildDefaultConvertDraft(
  card: DeckCardItem,
  targetKind: ConvertTargetKind,
  lang: 'zh' | 'en',
): ConvertDraft {
  const baseAnswer = String(
    card.answer ||
      card.options?.find((o) => o.correct)?.text ||
      card.cloze?.answers?.map((a) => a.value).join(', ') ||
      '',
  ).trim();
  if (targetKind === 'flashcard') {
    return {
      primaryText: baseAnswer || (lang === 'en' ? 'Key takeaway' : '核心答案要点'),
      secondaryText: '',
      tfIsTrue: true,
    };
  }
  if (targetKind === 'open') {
    const defaultRubric = baseAnswer
      ? lang === 'en'
        ? `Score full marks when covering: ${baseAnswer}`
        : `答出以下核心要点即可满分：${baseAnswer}`
      : lang === 'en'
        ? 'Accurate explanation of core concept and reasoning.'
        : '准确阐述核心概念、关键依据与结论。';
    return {
      primaryText: String(card.rubric || '').trim() || defaultRubric,
      secondaryText: '',
      tfIsTrue: true,
    };
  }
  if (targetKind === 'truefalse') {
    const tfIsTrue = !/^(false|no|错|错误|否|x|0)$/i.test(baseAnswer);
    return { primaryText: '', secondaryText: '', tfIsTrue };
  }
  if (targetKind === 'quiz') {
    return {
      primaryText: baseAnswer || (lang === 'en' ? 'Correct answer' : '正确选项内容'),
      secondaryText: '',
      tfIsTrue: true,
    };
  }
  // cloze
  const ansVal = baseAnswer || (lang === 'en' ? 'key term' : '关键概念');
  const rawPrompt = String(card.cloze?.text || card.prompt || '')
    .replace(/\{\{[^{}]+\}\}/g, '')
    .trim();
  let clozeText = `${rawPrompt || (lang === 'en' ? 'Fill in the blank:' : '请填空：')} {{b1}}`;
  if (rawPrompt && ansVal.length >= 2) {
    const idx = rawPrompt.toLowerCase().indexOf(ansVal.toLowerCase());
    if (idx >= 0) {
      clozeText = `${rawPrompt.slice(0, idx)}{{b1}}${rawPrompt.slice(idx + ansVal.length)}`;
    }
  }
  return {
    primaryText: clozeText,
    secondaryText: ansVal,
    tfIsTrue: true,
  };
}

function buildConvertPatch(
  card: DeckCardItem,
  targetKind: ConvertTargetKind,
  draft: ConvertDraft,
  lang: 'zh' | 'en',
): Record<string, unknown> {
  const cleanPromptFromCloze =
    card.kind === 'cloze' && !String(card.prompt || '').trim() && card.cloze?.text
      ? card.cloze.text.replace(/\{\{[^{}]+\}\}/g, '____')
      : undefined;

  if (targetKind === 'flashcard') {
    const ans = draft.primaryText.trim() || String(card.answer || '').trim();
    const patch: Record<string, unknown> = { answer: ans };
    if (cleanPromptFromCloze) patch.prompt = cleanPromptFromCloze;
    if (card.hint && ans && card.hint.trim().toLowerCase() === ans.toLowerCase()) {
      patch.hint = lang === 'en' ? 'Recall the core definition.' : '回想核心定义与要点。';
    }
    return patch;
  }

  if (targetKind === 'open') {
    const rubric = draft.primaryText.trim();
    const patch: Record<string, unknown> = { rubric };
    if (cleanPromptFromCloze) patch.prompt = cleanPromptFromCloze;
    if (!String(card.answer || '').trim() && rubric) patch.answer = rubric;
    return patch;
  }

  if (targetKind === 'truefalse') {
    const trueText = lang === 'en' ? 'True' : '对';
    const falseText = lang === 'en' ? 'False' : '错';
    const expl = String(card.explanation || '').trim();
    const options = [
      {
        id: 'true',
        text: trueText,
        correct: draft.tfIsTrue,
        explanation: draft.tfIsTrue
          ? expl || (lang === 'en' ? 'This statement is true.' : '该陈述正确。')
          : lang === 'en'
            ? 'Incorrect; the statement is false.'
            : '该陈述与事实不符。',
      },
      {
        id: 'false',
        text: falseText,
        correct: !draft.tfIsTrue,
        explanation: !draft.tfIsTrue
          ? expl || (lang === 'en' ? 'This statement is false.' : '该陈述错误。')
          : lang === 'en'
            ? 'Incorrect; the statement is true.'
            : '该陈述实际上正确。',
      },
    ];
    const ans = draft.tfIsTrue ? trueText : falseText;
    const patch: Record<string, unknown> = { options, answer: ans };
    if (cleanPromptFromCloze) patch.prompt = cleanPromptFromCloze;
    if (card.hint && card.hint.trim().toLowerCase() === ans.toLowerCase()) {
      patch.hint = lang === 'en' ? 'Evaluate whether the statement holds.' : '判断该命题是否成立。';
    }
    return patch;
  }

  if (targetKind === 'quiz') {
    const correctText = draft.primaryText.trim() || (lang === 'en' ? 'Correct answer' : '正确选项');
    let options: Array<{ id: string; text: string; correct: boolean; explanation: string }>;
    if (Array.isArray(card.options) && card.options.length >= 3 && card.options.length <= 6) {
      let pickedCorrect = false;
      const seenTexts = new Set<string>();
      options = card.options.map((o, idx) => {
        const isCorrect = !pickedCorrect && Boolean(o.correct);
        if (isCorrect) pickedCorrect = true;
        let text = isCorrect ? correctText : String(o.text || `Option ${idx + 1}`).trim();
        if (seenTexts.has(text.toLowerCase())) text = `${text} (${idx + 1})`;
        seenTexts.add(text.toLowerCase());
        return {
          id: String(o.id || String.fromCharCode(65 + idx)),
          text,
          correct: isCorrect,
          explanation:
            String(o.explanation || '').trim() ||
            (isCorrect
              ? String(card.explanation || '').trim() || (lang === 'en' ? 'Correct answer.' : '正确选项。')
              : lang === 'en'
                ? 'Distractor option.'
                : '干扰选项。'),
        };
      });
      if (!pickedCorrect && options.length > 0) {
        options[0] = { ...options[0], text: correctText, correct: true };
      }
    } else {
      const d1Base = lang === 'en' ? 'Distractor option B' : '干扰选项 B';
      const d2Base = lang === 'en' ? 'Distractor option C' : '干扰选项 C';
      const d1 = d1Base.toLowerCase() === correctText.toLowerCase() ? `${d1Base} (2)` : d1Base;
      const d2 = d2Base.toLowerCase() === correctText.toLowerCase() ? `${d2Base} (3)` : d2Base;
      options = [
        {
          id: 'A',
          text: correctText,
          correct: true,
          explanation: String(card.explanation || '').trim() || (lang === 'en' ? 'Correct answer.' : '正确选项。'),
        },
        {
          id: 'B',
          text: d1,
          correct: false,
          explanation: lang === 'en' ? 'Incorrect alternative B.' : '干扰项 B，不符合题意。',
        },
        {
          id: 'C',
          text: d2,
          correct: false,
          explanation: lang === 'en' ? 'Incorrect alternative C.' : '干扰项 C，不符合题意。',
        },
      ];
    }
    const patch: Record<string, unknown> = { options, answer: correctText };
    if (cleanPromptFromCloze) patch.prompt = cleanPromptFromCloze;
    if (card.hint && card.hint.trim().toLowerCase() === correctText.toLowerCase()) {
      patch.hint = lang === 'en' ? 'Eliminate the distractors.' : '结合题干排除干扰项。';
    }
    return patch;
  }

  // cloze
  const rawText = draft.primaryText.trim();
  const primaryVal =
    draft.secondaryText.trim() || String(card.answer || '').trim() || (lang === 'en' ? 'answer' : '答案');
  const markers: string[] = [];
  for (const m of rawText.matchAll(/\{\{([^{}]+)\}\}/g)) {
    if (m[1] && !markers.includes(m[1])) markers.push(m[1]);
  }
  const answers = (markers.length > 0 ? markers : ['b1']).map((id, idx) => ({
    id,
    value: idx === 0 ? primaryVal : String(card.cloze?.answers?.find((a) => a.id === id)?.value || primaryVal),
  }));
  return {
    cloze: { text: rawText, answers },
    answer: primaryVal,
  };
}

function kindLabel(kind: string | undefined, lang: 'zh' | 'en'): string {
  switch (kind) {
    case 'quiz':
    case 'single':
    case 'mcq':
      return lang === 'en' ? 'MCQ' : '单选';
    case 'multi':
    case 'multiple':
      return lang === 'en' ? 'Multi' : '多选';
    case 'truefalse':
    case 'true_false':
    case 'boolean':
      return lang === 'en' ? 'T/F' : '判断';
    case 'cloze':
    case 'fill_blank':
      return lang === 'en' ? 'Cloze' : '填空';
    case 'open':
    case 'short_answer':
      return lang === 'en' ? 'Open' : '简答';
    case 'flashcard':
    case 'card':
      return lang === 'en' ? 'Card' : '闪卡';
    case 'task':
      return lang === 'en' ? 'Task' : '动手';
    default:
      return kind || '?';
  }
}

function summarizeCardMarkdown(card: DeckCardItem, lang: 'zh' | 'en', asciiMode = false): string {
  const parts: string[] = [];
  if (card.topic) parts.push(`**${t(lang, '主题', 'Topic')}:** ${card.topic}`);
  parts.push(card.prompt || card.cloze?.text || t(lang, '(无题干)', '(No prompt)'));

  if (Array.isArray(card.options) && card.options.length > 0) {
    parts.push('');
    for (const opt of card.options) {
      const mark = asciiMode ? (opt.correct ? '+' : 'o') : opt.correct ? '✓' : '○';
      parts.push(`- ${mark} ${opt.text}`);
    }
  } else if (card.cloze?.answers?.length) {
    parts.push('');
    parts.push(`**${t(lang, '答案', 'Answers')}:** ${card.cloze.answers.map((a) => a.value).join(' | ')}`);
  } else if (card.answer) {
    parts.push('');
    parts.push(`**${t(lang, '参考答案', 'Answer')}:** ${card.answer}`);
  }

  if (card.flag) {
    parts.push('');
    parts.push(`> ${asciiMode ? '!' : '⚑'} ${t(lang, '标记', 'Flagged')}: ${card.flag}`);
  }
  return parts.join('\n');
}

export const DeckManageModal = memo(function DeckManageModal({
  host,
  deckId,
  isActive,
  width,
  height,
  onClose,
  onUpdated,
}: DeckManageModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const navigate = useTuiStore((s) => s.navigate);
  const notify = useTuiStore((s) => s.notify);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deck, setDeck] = useState<FullDeckDetail | null>(null);
  const [mode, setMode] = useState<ModalMode>('browse');
  const [searchQuery, setSearchQuery] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [deckId]);

  // Supplement sub-mode state ([+])
  const [suppSelectedIds, setSuppSelectedIds] = useState<Set<string>>(() => new Set());
  const [suppSourceCursor, setSuppSourceCursor] = useState(0);
  const [suppCountIdx, setSuppCountIdx] = useState(1); // default 5
  const [suppKindIdx, setSuppKindIdx] = useState(0); // default 'mixed'
  const [suppError, setSuppError] = useState('');
  const [suppJobResult, setSuppJobResult] = useState<{
    jobId: string;
    status?: string;
    count: number;
    kind: string;
  } | null>(null);

  // Convert card kind sub-mode state ([k])
  const [convertKindIdx, setConvertKindIdx] = useState(0);
  const [convertDraft, setConvertDraft] = useState<ConvertDraft>({
    primaryText: '',
    secondaryText: '',
    tfIsTrue: true,
  });
  const [convertEditActive, setConvertEditActive] = useState(false);
  const [convertError, setConvertError] = useState('');

  const reloadDeck = useCallback(async (): Promise<FullDeckDetail | null> => {
    const res = await tryAction<FullDeckDetail>(host, 'deck.get', { id: deckId });
    if (res.ok && res.value) {
      setDeck(res.value);
      setRenameValue(res.value.title || '');
      const validIds = new Set((res.value.cards ?? []).map((c) => c.id));
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set<string>();
        for (const id of prev) {
          if (validIds.has(id)) next.add(id);
          else changed = true;
        }
        return changed ? next : prev;
      });
      return res.value;
    }
    return null;
  }, [host, deckId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      const res = await tryAction<FullDeckDetail>(host, 'deck.get', { id: deckId });
      if (!alive) return;
      if (res.ok && res.value) {
        setDeck(res.value);
        setRenameValue(res.value.title || '');
      } else {
        setError(res.error?.message || t(lang, '读取题组失败', 'Failed to load deck'));
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [host, deckId, lang]);

  const filteredCards = useMemo(() => {
    const cards = deck?.cards ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) => {
      const text = `${c.topic ?? ''} ${c.prompt ?? ''} ${c.cloze?.text ?? ''} ${c.kind ?? ''} ${c.id}`.toLowerCase();
      return text.includes(q);
    });
  }, [deck?.cards, searchQuery]);

  useEffect(() => {
    if (selectedIndex >= filteredCards.length) {
      setSelectedIndex(Math.max(0, filteredCards.length - 1));
    }
  }, [filteredCards.length, selectedIndex]);

  const selectedCard = filteredCards[selectedIndex] ?? null;

  // Available active sources sorted course-matched first for [+] supplement
  const availableDocs = useMemo<DocumentGroup[]>(() => {
    const docs = groupSourcesFromSnapshot(snapshot).filter((d) => !d.archived);
    const deckCourse = deck?.course?.trim();
    if (!deckCourse) return docs;
    return [...docs].sort((a, b) => {
      const aMatch = a.courses.includes(deckCourse) ? 0 : 1;
      const bMatch = b.courses.includes(deckCourse) ? 0 : 1;
      return aMatch - bMatch;
    });
  }, [snapshot, deck?.course]);

  const availableConvertTargets = useMemo<ConvertTargetKind[]>(() => {
    const cur = selectedCard?.kind;
    return CONVERT_TARGETS.filter((k) => k !== cur);
  }, [selectedCard?.kind]);

  const convertTargetKind: ConvertTargetKind =
    availableConvertTargets[convertKindIdx % Math.max(1, availableConvertTargets.length)] ?? 'flashcard';

  const suppCount = SUPPLEMENT_COUNTS[suppCountIdx] ?? 5;
  const suppKind = SUPPLEMENT_KINDS[suppKindIdx] ?? 'mixed';

  const openSupplementMode = useCallback(() => {
    if (!deck) return;
    if (deck.archived || deck.systemKind) {
      notify(t(lang, '仅活跃普通题组支持直接补题', 'Only active ordinary decks can be supplemented'), 'warning');
      return;
    }
    setSuppSelectedIds(new Set());
    setSuppSourceCursor(0);
    setSuppCountIdx(1);
    setSuppKindIdx(0);
    setSuppError('');
    setSuppJobResult(null);
    setMode('supplement');
  }, [deck, lang, notify]);

  const handleSubmitSupplement = useCallback(async () => {
    if (!deck || busy) return;
    const sourceIds = [...suppSelectedIds];
    if (sourceIds.length === 0) {
      const msg = t(lang, '请先按 [Space] 勾选至少一份资料', 'Press [Space] to select at least one source');
      setSuppError(msg);
      notify(msg, 'warning');
      return;
    }
    setBusy(true);
    setSuppError('');
    const res = await tryAction<{ jobId?: string; id?: string; status?: string }>(host, 'supplement', {
      deckId: deck.id,
      sourceIds,
      count: suppCount,
      kind: suppKind,
    });
    setBusy(false);
    if (!res.ok) {
      const msg = res.error?.message || t(lang, '提交补题任务失败', 'Failed to queue supplement job');
      setSuppError(msg);
      notify(msg, 'error');
      return;
    }
    const jobId = String(res.value?.jobId || res.value?.id || 'queued');
    setSuppJobResult({
      jobId,
      status: res.value?.status,
      count: suppCount,
      kind: suppKind,
    });
    onUpdated?.();
    notify(
      t(lang, `补题任务已入队 (${jobId})，可按 [t] 查看后台任务`, `Supplement job queued (${jobId}) — press [t] for Tasks`),
      'success',
    );
  }, [deck, busy, suppSelectedIds, suppCount, suppKind, host, lang, notify, onUpdated]);

  const openConvertMode = useCallback(() => {
    if (!selectedCard) return;
    const targets = CONVERT_TARGETS.filter((k) => k !== selectedCard.kind);
    const firstKind = targets[0] ?? 'flashcard';
    setConvertKindIdx(0);
    setConvertDraft(buildDefaultConvertDraft(selectedCard, firstKind, lang));
    setConvertEditActive(false);
    setConvertError('');
    setMode('convert');
  }, [selectedCard, lang]);

  const cycleConvertKind = useCallback(
    (delta: number) => {
      if (!selectedCard || availableConvertTargets.length === 0) return;
      const nextIdx =
        (convertKindIdx + delta + availableConvertTargets.length) % availableConvertTargets.length;
      const nextKind = availableConvertTargets[nextIdx];
      setConvertKindIdx(nextIdx);
      setConvertDraft(buildDefaultConvertDraft(selectedCard, nextKind, lang));
      setConvertEditActive(false);
      setConvertError('');
    },
    [selectedCard, availableConvertTargets, convertKindIdx, lang],
  );

  const handleSubmitConvert = useCallback(async () => {
    if (!deck || !selectedCard || busy) return;
    setBusy(true);
    setConvertError('');
    const patch = buildConvertPatch(selectedCard, convertTargetKind, convertDraft, lang);
    const res = await tryAction<{ deckId?: string; cardId?: string; kind?: string }>(host, 'card.convert', {
      cardId: selectedCard.id,
      deckId: deck.id,
      kind: convertTargetKind,
      patch,
      reason: `Converted from ${selectedCard.kind || 'unknown'} to ${convertTargetKind} in TUI`,
    });
    if (!res.ok) {
      setBusy(false);
      setConvertError(res.error?.message || t(lang, '转换题型失败', 'Card conversion failed'));
      return;
    }
    await reloadDeck();
    onUpdated?.();
    setBusy(false);
    setConvertEditActive(false);
    setMode('browse');
    notify(
      t(
        lang,
        `已转换为「${kindLabel(convertTargetKind, lang)}」`,
        `Converted card to ${kindLabel(convertTargetKind, lang)}`,
      ),
      'success',
    );
  }, [deck, selectedCard, busy, convertTargetKind, convertDraft, lang, host, reloadDeck, onUpdated, notify]);

  const handleRenameSubmit = useCallback(
    async (raw: string) => {
      const nextTitle = raw.trim();
      if (!deck || !nextTitle || nextTitle === deck.title) {
        setMode('browse');
        return;
      }
      setBusy(true);
      const editDraftWarning = t(
        lang,
        '该题组已有未发布的编辑草稿，请先在「创建题组」处理后再重命名',
        'This deck has an unpublished edit draft; resolve it in Generate before renaming',
      );
      const snapRes = await tryAction<{ drafts?: Array<{ id?: string; editingDeckId?: string }> }>(host, 'snapshot');
      const draftsToCheck = snapRes.ok && Array.isArray(snapRes.value?.drafts)
        ? snapRes.value.drafts
        : (useTuiStore.getState().snapshot?.drafts ?? []);
      if (draftsToCheck.some((d) => (d as { editingDeckId?: string }).editingDeckId === deck.id)) {
        setBusy(false);
        setMode('browse');
        notify(editDraftWarning, 'warning');
        return;
      }
      const editRes = await tryAction<Record<string, unknown> & { draftVersion?: number }>(host, 'deck.edit', { id: deck.id });
      if (!editRes.ok || !editRes.value) {
        setBusy(false);
        setMode('browse');
        notify(editRes.error?.message || t(lang, '无法创建编辑草稿', 'Could not create edit draft'), 'error');
        return;
      }
      if ((editRes.value.draftVersion ?? 1) !== 1) {
        setBusy(false);
        setMode('browse');
        notify(editDraftWarning, 'warning');
        return;
      }
      const draft = { ...editRes.value, title: nextTitle };
      const saveRes = await tryAction<{ id: string; draftVersion?: number }>(host, 'draft.save', { deck: draft });
      if (!saveRes.ok || !saveRes.value) {
        setBusy(false);
        setMode('browse');
        notify(saveRes.error?.message || t(lang, '保存标题失败', 'Failed to save title'), 'error');
        return;
      }
      const pubRes = await tryAction(host, 'draft.publish.quick', {
        id: saveRes.value.id,
        draftVersion: saveRes.value.draftVersion,
      });
      setBusy(false);
      setMode('browse');
      if (pubRes.ok) {
        setDeck((prev) => (prev ? { ...prev, title: nextTitle } : prev));
        onUpdated?.();
        notify(t(lang, `已重命名为「${nextTitle}」`, `Renamed to "${nextTitle}"`), 'success');
      } else {
        notify(
          t(lang, '已保存草稿，请在创建/编辑页完成发布', 'Draft saved; finish publishing in Generate'),
          'warning',
        );
        onClose();
        navigate('generate', { draftId: saveRes.value.id });
      }
    },
    [deck, host, lang, notify, onUpdated, onClose, navigate],
  );

  const handleOpenDraft = useCallback(async () => {
    if (!deck || busy) return;
    setBusy(true);
    const editRes = await tryAction<{ id: string }>(host, 'deck.edit', { id: deck.id });
    setBusy(false);
    if (!editRes.ok || !editRes.value?.id) {
      notify(editRes.error?.message || t(lang, '打开草稿失败', 'Failed to open draft'), 'error');
      return;
    }
    onClose();
    navigate('generate', { draftId: editRes.value.id });
  }, [deck, busy, host, notify, lang, onClose, navigate]);

  const handleBatchFocus = useCallback(async () => {
    if (busyRef.current || busy || !deck || selectedIds.size === 0) return;
    const targetCards = (deck.cards ?? []).filter((c) => selectedIds.has(c.id));
    if (targetCards.length === 0) return;
    const allFocused = targetCards.every((c) => Boolean(c.focus));
    const nextFocus = !allFocused;
    busyRef.current = true;
    setBusy(true);
    let succeeded = 0;
    let failed = 0;
    for (const card of targetCards) {
      const res = await tryAction<{ ok?: boolean; focus?: boolean }>(host, 'card.focus', {
        deckId: deck.id,
        cardId: card.id,
        focus: nextFocus,
      });
      if (!mountedRef.current) {
        busyRef.current = false;
        return;
      }
      if (res.ok) succeeded += 1;
      else failed += 1;
    }
    await reloadDeck();
    if (!mountedRef.current) {
      busyRef.current = false;
      return;
    }
    onUpdated?.();
    busyRef.current = false;
    setBusy(false);
    if (succeeded > 0) {
      notify(
        nextFocus
          ? t(
              lang,
              `已将 ${succeeded} 题标为重点${failed > 0 ? `（${failed} 题失败）` : ''}`,
              `Marked ${succeeded} card(s) as Focus${failed > 0 ? ` (${failed} failed)` : ''}`,
            )
          : t(
              lang,
              `已取消 ${succeeded} 题的重点标记${failed > 0 ? `（${failed} 题失败）` : ''}`,
              `Removed Focus from ${succeeded} card(s)${failed > 0 ? ` (${failed} failed)` : ''}`,
            ),
        failed > 0 ? 'warning' : 'success',
      );
    } else if (failed > 0) {
      notify(t(lang, '批量更新重点标记失败', 'Failed to update Focus marks'), 'error');
    }
  }, [busy, deck, selectedIds, host, reloadDeck, onUpdated, notify, lang]);

  const handleBatchSuspend = useCallback(async () => {
    if (busyRef.current || busy || !deck || selectedIds.size === 0) return;
    const targetCards = (deck.cards ?? []).filter((c) => selectedIds.has(c.id));
    if (targetCards.length === 0) return;
    const allSuspended = targetCards.every((c) => Boolean(c.suspended));
    const nextSuspended = !allSuspended;
    busyRef.current = true;
    setBusy(true);
    let succeeded = 0;
    let failed = 0;
    let lastError = '';
    for (const card of targetCards) {
      const res = await tryAction<{ ok?: boolean }>(host, 'card.suspend', {
        deckId: deck.id,
        cardId: card.id,
        suspended: nextSuspended,
      });
      if (!mountedRef.current) {
        busyRef.current = false;
        return;
      }
      if (res.ok) succeeded += 1;
      else {
        failed += 1;
        if (res.error?.message) lastError = res.error.message;
      }
    }
    await reloadDeck();
    if (!mountedRef.current) {
      busyRef.current = false;
      return;
    }
    onUpdated?.();
    busyRef.current = false;
    setBusy(false);
    if (succeeded > 0) {
      notify(
        nextSuspended
          ? t(
              lang,
              `已暂停 ${succeeded} 题${failed > 0 ? `（${failed} 题失败）` : ''}`,
              `Suspended ${succeeded} card(s)${failed > 0 ? ` (${failed} failed)` : ''}`,
            )
          : t(
              lang,
              `已恢复 ${succeeded} 题${failed > 0 ? `（${failed} 题失败）` : ''}`,
              `Resumed ${succeeded} card(s)${failed > 0 ? ` (${failed} failed)` : ''}`,
            ),
        failed > 0 ? 'warning' : 'success',
      );
    } else if (failed > 0) {
      notify(lastError || t(lang, '批量暂停/恢复失败', 'Failed to update suspend status'), 'error');
    }
  }, [busy, deck, selectedIds, host, reloadDeck, onUpdated, notify, lang]);

  const handlePracticeCard = useCallback(
    async (card: DeckCardItem) => {
      if (!deck || busy) return;
      setBusy(true);
      try {
        const run = await startReview(host, {
          mode: 'path',
          scope: [{ deckId: deck.id, cardId: card.id }],
          fresh: true,
        });
        onClose();
        navigate('review', { runId: run.id, deckId: deck.id });
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setBusy(false);
      }
    },
    [deck, busy, host, onClose, navigate, notify],
  );

  const frameW = Math.max(48, Math.min(100, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const inputRows = mode === 'search' || mode === 'rename' ? 3 : 0;
  const bodyH = Math.max(6, frameH - 6 - inputRows);
  const listH = Math.max(4, Math.floor(bodyH * 0.52));
  const previewH = Math.max(3, bodyH - listH - 1);

  useInput(
    (input, key) => {
      if (!deck || loading || busy) return;

      if (mode === 'supplement') {
        if (suppJobResult) {
          if (input === 't' || key.return) {
            const jobId = suppJobResult.jobId;
            onClose();
            navigate('tasks', jobId && jobId !== 'queued' ? { jobId } : {});
          }
          return;
        }
        if (input === ' ') {
          const doc = availableDocs[suppSourceCursor];
          if (doc) {
            setSuppError('');
            setSuppSelectedIds((prev) => {
              const next = new Set(prev);
              const allPicked = doc.sourceIds.every((id) => next.has(id));
              for (const id of doc.sourceIds) {
                if (allPicked) next.delete(id);
                else next.add(id);
              }
              return next;
            });
          }
        } else if (input === 'a') {
          setSuppError('');
          setSuppSelectedIds((prev) =>
            prev.size > 0 ? new Set() : new Set(availableDocs.flatMap((d) => d.sourceIds)),
          );
        } else if (input === '+' || input === '=' || input === '>' || input === '.') {
          setSuppCountIdx((i) => (i + 1) % SUPPLEMENT_COUNTS.length);
        } else if (input === '-' || input === '<' || input === ',') {
          setSuppCountIdx((i) => (i - 1 + SUPPLEMENT_COUNTS.length) % SUPPLEMENT_COUNTS.length);
        } else if (key.tab || input === 't') {
          setSuppKindIdx((i) => (i + 1) % SUPPLEMENT_KINDS.length);
        } else if (key.ctrl && input === 's') {
          void handleSubmitSupplement();
        }
        return;
      }

      if (mode === 'convert') {
        if (convertEditActive) return;
        if (key.tab || key.rightArrow || input === 'l') {
          cycleConvertKind(1);
        } else if (key.leftArrow || input === 'h') {
          cycleConvertKind(-1);
        } else if (input === ' ' && convertTargetKind === 'truefalse') {
          setConvertDraft((prev) => ({ ...prev, tfIsTrue: !prev.tfIsTrue }));
          setConvertError('');
        } else if (input === 'e' && convertTargetKind !== 'truefalse') {
          setConvertEditActive(true);
        } else if (key.return || (key.ctrl && input === 's')) {
          void handleSubmitConvert();
        }
        return;
      }

      if (mode !== 'browse') return;

      const total = filteredCards.length;
      if (key.downArrow || (!key.ctrl && !key.meta && input === 'j')) {
        if (total > 0) setSelectedIndex((i) => Math.min(total - 1, i + 1));
      } else if (key.upArrow) {
        if (total > 0) setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (key.ctrl && input === 'd') {
        if (total > 0) setSelectedIndex((i) => Math.min(total - 1, i + Math.max(1, Math.floor(listH / 2))));
      } else if (key.ctrl && input === 'u') {
        if (total > 0) setSelectedIndex((i) => Math.max(0, i - Math.max(1, Math.floor(listH / 2))));
      } else if (key.pageDown || (key.ctrl && input === 'f')) {
        if (total > 0) setSelectedIndex((i) => Math.min(total - 1, i + Math.max(1, listH - 1)));
      } else if (key.pageUp || (key.ctrl && input === 'b')) {
        if (total > 0) setSelectedIndex((i) => Math.max(0, i - Math.max(1, listH - 1)));
      } else if (key.home || (!key.ctrl && !key.meta && input === 'g')) {
        if (total > 0) setSelectedIndex(0);
      } else if (key.end || (!key.ctrl && !key.meta && input === 'G')) {
        if (total > 0) setSelectedIndex(total - 1);
      } else if (key.return) {
        if (selectedCard) void handlePracticeCard(selectedCard);
      } else if (input === ' ') {
        if (!selectedCard) return;
        if (!selectedIds.has(selectedCard.id) && selectedIds.size >= MAX_MULTI_SELECT) {
          notify(
            t(lang, `最多同时选择 ${MAX_MULTI_SELECT} 道题`, `Up to ${MAX_MULTI_SELECT} cards can be selected`),
            'warning',
          );
          return;
        }
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(selectedCard.id)) next.delete(selectedCard.id);
          else next.add(selectedCard.id);
          return next;
        });
      } else if (input === 'F' && selectedIds.size > 0) {
        void handleBatchFocus();
      } else if (input === 'S' && selectedIds.size > 0) {
        void handleBatchSuspend();
      } else if (input === 'x' && selectedIds.size > 0) {
        setSelectedIds(new Set());
      } else if (input === '/' || input === 'f') {
        setMode('search');
      } else if (input === 'c' && searchQuery) {
        setSearchQuery('');
      } else if (input === 'n') {
        setRenameValue(deck.title || '');
        setMode('rename');
      } else if (input === 'e') {
        void handleOpenDraft();
      } else if (input === 'p') {
        onClose();
        navigate('review', { deckId: deck.id });
      } else if (input === '+') {
        openSupplementMode();
      } else if (input === 'k') {
        openConvertMode();
      }
    },
    { isActive: isActive && (mode === 'browse' || mode === 'supplement' || mode === 'convert') && !loading && !busy },
  );

  const hints = useMemo<KeyHint[]>(
    () =>
      mode === 'search'
        ? [
            { key: 'Enter', label: t(lang, '应用筛选', 'Apply') },
            { key: 'Esc', label: t(lang, '返回列表', 'Back') },
          ]
        : mode === 'rename'
          ? [
              { key: 'Enter', label: t(lang, '保存名称', 'Save') },
              { key: 'Esc', label: t(lang, '取消', 'Cancel') },
            ]
          : mode === 'supplement'
            ? suppJobResult
              ? [
                  { key: 't', label: t(lang, '查看任务', 'View Tasks') },
                  { key: 'Esc', label: t(lang, '返回题组', 'Back') },
                ]
              : [
                  { key: 'Space', label: t(lang, '勾选资料', 'Toggle') },
                  { key: '+/-', label: t(lang, '题数', 'Count') },
                  { key: 'Tab/t', label: t(lang, '题型', 'Kind') },
                  { key: 'Enter', label: t(lang, '提交补题', 'Queue') },
                  { key: 'Esc', label: t(lang, '返回', 'Back') },
                ]
            : mode === 'convert'
              ? convertEditActive
                ? [
                    { key: 'Enter', label: t(lang, '确认修改', 'Done') },
                    { key: 'Esc', label: t(lang, '取消编辑', 'Cancel') },
                  ]
                : [
                    { key: 'Tab', label: t(lang, '换题型', 'Kind') },
                    ...(convertTargetKind === 'truefalse'
                      ? [{ key: 'Space', label: t(lang, '对/错', 'T/F') }]
                      : [{ key: 'e', label: t(lang, '改字段', 'Edit') }]),
                    { key: 'Enter', label: t(lang, '确认转换', 'Convert') },
                    { key: 'Esc', label: t(lang, '取消', 'Cancel') },
                  ]
              : selectedIds.size > 0
                ? [
                    { key: 'Space', label: t(lang, '多选', 'Select') },
                    { key: 'F', label: t(lang, '重点', 'Focus') },
                    { key: 'S', label: t(lang, '暂停/恢复', 'Suspend') },
                    { key: 'x', label: t(lang, '清空', 'Clear') },
                    { key: 'Esc', label: t(lang, '关闭', 'Close') },
                  ]
                : [
                    { key: 'Space', label: t(lang, '多选', 'Select') },
                    { key: 'Enter', label: t(lang, '练此题', 'Practice') },
                    { key: 'p', label: t(lang, '练整组', 'Deck') },
                    { key: '+', label: t(lang, '补题', 'Supplement') },
                    { key: 'k', label: t(lang, '转题型', 'Convert') },
                    { key: '/', label: t(lang, '搜索', 'Search') },
                    { key: 'n', label: t(lang, '改名', 'Rename') },
                    { key: 'e', label: t(lang, '草稿', 'Draft') },
                    { key: 'Esc', label: t(lang, '关闭', 'Close') },
                  ],
    [mode, lang, suppJobResult, convertEditActive, convertTargetKind, selectedIds.size],
  );

  const renderCardRow = useCallback(
    (card: DeckCardItem, ctx: VirtualListRenderContext) => {
      const isChecked = selectedIds.has(card.id);
      const checkBox = selectedIds.size > 0 ? (isChecked ? (asciiMode ? '[x] ' : '[✓] ') : '[ ] ') : '';
      const num = `${String(ctx.index + 1).padStart(2, ' ')}.`;
      const kind = `[${kindLabel(card.kind, lang)}]`;
      const foc = card.focus ? (asciiMode ? ' *' : ' ★') : '';
      const flag = card.flag ? (asciiMode ? ' !' : ' ⚑') : '';
      const susp = card.suspended ? (asciiMode ? ' [||]' : ' [⏸]') : '';
      const topic = card.topic ? `${truncateDisplay(card.topic, 14, ell)} · ` : '';
      const prefix = `${num} ${kind} `;
      const tail = `${foc}${flag}${susp}`;
      const avail = Math.max(6, ctx.width - displayWidth(checkBox) - displayWidth(prefix) - displayWidth(tail));
      const stem = `${topic}${String(card.prompt || card.cloze?.text || '').replace(/\s+/g, ' ')}`;
      const line = padDisplay(truncateDisplay(stem, avail, ell), avail);
      const fg = ctx.selected ? theme.selectionFg : card.suspended ? theme.dim : theme.text;
      const rowBg = ctx.selected
        ? isActive && mode === 'browse' && !busy
          ? theme.selectionBg
          : theme.surface
        : undefined;
      return (
        <Box width={ctx.width} backgroundColor={rowBg}>
          <Text color={fg} bold={ctx.selected}>
            {checkBox ? (
              <Text color={ctx.selected ? theme.selectionFg : isChecked ? theme.success : theme.muted} bold={isChecked}>
                {checkBox}
              </Text>
            ) : null}
            <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{num} </Text>
            <Text color={ctx.selected ? theme.selectionFg : theme.accent}>{kind} </Text>
            {line}
            {foc ? <Text color={ctx.selected ? theme.selectionFg : theme.primary}>{foc}</Text> : null}
            {flag ? <Text color={ctx.selected ? theme.selectionFg : theme.warning}>{flag}</Text> : null}
            {susp ? <Text color={theme.dim}>{susp}</Text> : null}
          </Text>
        </Box>
      );
    },
    [lang, theme, asciiMode, ell, isActive, mode, busy, selectedIds],
  );

  const previewMarkdown = useMemo(
    () => (selectedCard ? summarizeCardMarkdown(selectedCard, lang, asciiMode) : ''),
    [selectedCard, lang, asciiMode],
  );

  const handleModalClose = useCallback(() => {
    if (mode === 'browse') {
      onClose();
      return;
    }
    if (mode === 'convert' && convertEditActive) {
      setConvertEditActive(false);
      return;
    }
    setSuppError('');
    setSuppJobResult(null);
    setConvertError('');
    setConvertEditActive(false);
    setMode('browse');
  }, [mode, convertEditActive, onClose]);

  const modalTitle =
    mode === 'supplement'
      ? `${t(lang, '题组补题', 'Supplement Deck')}: ${deck?.title || ''}`
      : mode === 'convert'
        ? t(lang, '转换题型', 'Convert Card Kind')
        : deck?.title
          ? `${t(lang, '题组管理', 'Manage Deck')}: ${deck.title}`
          : t(lang, '题组管理', 'Manage Deck');

  return (
    <Modal
      title={modalTitle}
      icon={asciiMode ? '#' : '▤'}
      subtitle={
        mode === 'supplement'
          ? `${suppSelectedIds.size} ${t(lang, '页已选', 'pg')}`
          : mode === 'convert' && selectedCard
            ? `${kindLabel(selectedCard.kind, lang)} -> ${kindLabel(convertTargetKind, lang)}`
            : deck
              ? `${filteredCards.length}/${deck.cards.length} ${t(lang, '题', 'cards')}${selectedIds.size > 0 ? ` · [${t(lang, `已选 ${selectedIds.size}`, `${selectedIds.size} sel`)}]` : ''}`
              : undefined
      }
      width={frameW}
      height={frameH}
      onClose={handleModalClose}
      isActive={isActive && (mode === 'browse' || mode === 'supplement' || (mode === 'convert' && !convertEditActive))}
      hints={hints}
    >
      {mode === 'search' ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color={theme.accent}>{t(lang, '搜索题目 (题干 / 知识点 / 题型):', 'Filter cards:')}</Text>
          <Box borderStyle={asciiMode ? 'classic' : 'round'} borderColor={theme.borderActive} paddingX={1}>
            <TextInput
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={() => setMode('browse')}
              onCancel={() => setMode('browse')}
              isActive={isActive && mode === 'search'}
              width={Math.max(12, innerW - 6)}
              placeholder={t(lang, `输入关键字${ell}`, `Type keyword${ell}`)}
            />
          </Box>
        </Box>
      ) : null}

      {mode === 'rename' ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color={theme.accent}>{t(lang, '输入新题组标题 (通过 deck.edit 保存):', 'New deck title (via deck.edit):')}</Text>
          <Box borderStyle={asciiMode ? 'classic' : 'round'} borderColor={theme.borderActive} paddingX={1}>
            <TextInput
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={(val) => {
                void handleRenameSubmit(val);
              }}
              onCancel={() => setMode('browse')}
              isActive={isActive && mode === 'rename' && !busy}
              width={Math.max(12, innerW - 6)}
              placeholder={t(lang, `输入题组名称${ell}`, `Deck title${ell}`)}
            />
          </Box>
        </Box>
      ) : null}

      {mode === 'browse' && (searchQuery || selectedIds.size > 0) ? (
        <Box height={1} flexDirection="row" gap={1} flexShrink={0} overflow="hidden">
          {selectedIds.size > 0 ? (
            <>
              <Badge label={t(lang, `已选 ${selectedIds.size}`, `${selectedIds.size} sel`)} tone="primary" variant="soft" />
              <Text color={theme.dim}>
                {truncateDisplay(
                  t(lang, '[F]重点  [S]暂停/恢复  [x]清空', '[F]Focus  [S]Suspend  [x]Clear'),
                  Math.max(10, innerW - 14),
                  ell,
                )}
              </Text>
            </>
          ) : null}
          {searchQuery ? (
            <>
              <Badge label={`${t(lang, '筛选', 'Filter')}: ${searchQuery}`} tone="info" variant="soft" />
              <Text color={theme.dim}>{t(lang, '([c] 清除)', '([c] clear)')}</Text>
            </>
          ) : null}
        </Box>
      ) : null}

      {loading ? (
        <Box height={bodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在读取题组卡片${ell}`, `Loading deck cards${ell}`)} active={isActive} />
        </Box>
      ) : error ? (
        <Box height={bodyH} flexDirection="column" paddingY={1}>
          <Text color={theme.error} bold>{error}</Text>
        </Box>
      ) : mode === 'supplement' ? (
        <Box flexDirection="column" height={bodyH} width={innerW} overflow="hidden">
          {suppJobResult ? (
            <Box flexDirection="column" paddingY={1} gap={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Badge label={asciiMode ? '+ QUEUED' : '✓ 已入队'} tone="success" variant="solid" />
                <Text color={theme.text} bold>
                  {`Job ID: ${suppJobResult.jobId}`}
                </Text>
              </Box>
              <Text color={theme.accent}>
                {t(
                  lang,
                  `目标题组：${deck?.title || deckId}  ·  题数：${suppJobResult.count}  ·  题型：${supplementKindLabel(suppJobResult.kind, lang)}`,
                  `Target: ${deck?.title || deckId}  ·  Count: ${suppJobResult.count}  ·  Kind: ${supplementKindLabel(suppJobResult.kind, lang)}`,
                )}
              </Text>
              <Text color={theme.muted}>
                {t(
                  lang,
                  '后台补题任务已提交。按 [t] 或 [Enter] 前往「后台任务」监控进度，或按 [Esc] 返回题组列表。',
                  'Supplement job queued. Press [t] or [Enter] to monitor in TasksView, or [Esc] to return.',
                )}
              </Text>
            </Box>
          ) : (
            <>
              <Box flexDirection="row" height={1} alignItems="center" gap={1}>
                <Text color={theme.accent} bold>{t(lang, '补题参数:', 'Options:')}</Text>
                <Badge label={`${t(lang, '题数', 'Count')}: ${suppCount}`} tone="primary" variant="soft" />
                <Badge
                  label={`${t(lang, '题型', 'Kind')}: ${supplementKindLabel(suppKind, lang)}`}
                  tone="accent"
                  variant="soft"
                />
                <Box flexGrow={1} />
                {busy ? <Spinner label={t(lang, `提交中${ell}`, `Queuing${ell}`)} active={isActive} /> : (
                  <Text color={theme.dim}>{t(lang, '[a] 全选  [Enter] 提交', '[a] All  [Enter] Submit')}</Text>
                )}
              </Box>
              <Box height={1}>
                <Text color={theme.dim}>
                  {truncateDisplay(
                    t(
                      lang,
                      '按 [Space] 勾选资料（同课程优先显示），[+/-] 调题数，[Tab/t] 切题型',
                      'Press [Space] to select sources (course-matched first), [+/-] count, [Tab/t] kind',
                    ),
                    innerW,
                    ell,
                  )}
                </Text>
              </Box>
              {suppError ? (
                <Box height={1}>
                  <Text color={theme.error}>{truncateDisplay(suppError, innerW, ell)}</Text>
                </Box>
              ) : null}
              <Divider width={innerW} />
              <VirtualList
                items={availableDocs}
                height={Math.max(3, bodyH - 3 - (suppError ? 1 : 0))}
                width={innerW}
                selectedIndex={suppSourceCursor}
                onChange={(idx) => setSuppSourceCursor(idx)}
                onSelect={() => {
                  void handleSubmitSupplement();
                }}
                isActive={isActive && mode === 'supplement' && !suppJobResult && !busy}
                keyExtractor={(doc) => doc.key}
                emptyText={t(lang, '暂无可用资料', 'No active sources available')}
                emptyHint={t(lang, '请先在「资料」页导入或取消归档资料', 'Import or unarchive sources in Sources view')}
                renderItem={(doc, ctx) => {
                  const pickedCount = doc.sourceIds.filter((id) => suppSelectedIds.has(id)).length;
                  const mark =
                    pickedCount === doc.sourceIds.length && doc.sourceIds.length > 0
                      ? asciiMode
                        ? '[x]'
                        : '[✓]'
                      : pickedCount > 0
                        ? '[~]'
                        : '[ ]';
                  const matched = Boolean(deck?.course && doc.courses.includes(deck.course));
                  const matchTag = matched ? (asciiMode ? ' *' : ' ★') : '';
                  const fmt = `[${formatLabel(doc.format)}]`;
                  const pages = `${doc.pageCount}p`;
                  const titleBudget = Math.max(8, ctx.width - mark.length - fmt.length - pages.length - matchTag.length - 4);
                  return (
                    <Box flexDirection="row" width={ctx.width}>
                      <Text color={pickedCount > 0 ? theme.success : theme.muted}>{`${mark} `}</Text>
                      <Text color={theme.accent}>{`${fmt} `}</Text>
                      <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
                        {truncateDisplay(doc.title, titleBudget, ell)}
                      </Text>
                      {matched ? <Text color={theme.warning}>{matchTag}</Text> : null}
                      <Box flexGrow={1} />
                      <Text color={theme.dim}>{pages}</Text>
                    </Box>
                  );
                }}
              />
            </>
          )}
        </Box>
      ) : mode === 'convert' && selectedCard ? (
        <Box flexDirection="column" height={bodyH} width={innerW} overflow="hidden">
          <Box flexDirection="row" height={1} alignItems="center" gap={1}>
            <Text color={theme.muted}>{t(lang, '原题型:', 'From:')}</Text>
            <Badge label={kindLabel(selectedCard.kind, lang)} tone="muted" variant="outline" />
            <Text color={theme.muted}>{asciiMode ? '->' : '→'}</Text>
            <Text color={theme.muted}>{t(lang, '目标:', 'To:')}</Text>
            {availableConvertTargets.map((k, idx) => (
              <Badge
                key={k}
                label={kindLabel(k, lang)}
                tone={idx === convertKindIdx ? 'primary' : 'muted'}
                variant={idx === convertKindIdx ? 'solid' : 'outline'}
              />
            ))}
          </Box>
          <Box height={1}>
            <Text color={theme.dim}>
              {truncateDisplay(
                `${t(lang, '题干:', 'Prompt:')} ${String(selectedCard.prompt || selectedCard.cloze?.text || '').replace(/\s+/g, ' ')}`,
                innerW,
                ell,
              )}
            </Text>
          </Box>
          <Divider width={innerW} />
          {convertTargetKind === 'truefalse' ? (
            <Box flexDirection="column" gap={1} paddingY={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text color={theme.accent} bold>{t(lang, '正确答案 ([Space] 切换):', 'Correct Answer ([Space] toggle):')}</Text>
                <Badge
                  label={convertDraft.tfIsTrue ? t(lang, '对 (True)', 'True') : t(lang, '错 (False)', 'False')}
                  tone={convertDraft.tfIsTrue ? 'success' : 'warning'}
                  variant="solid"
                />
              </Box>
              <Text color={theme.muted}>
                {t(
                  lang,
                  '将自动生成标准 true/false 双选项并保留原题解析与复习记录引用。',
                  'Generates standard true/false options automatically while preserving explanation and links.',
                )}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column" gap={0}>
              <Text color={convertEditActive ? theme.primary : theme.accent} bold>
                {convertTargetKind === 'open'
                  ? t(lang, '评分标准 patch.rubric ([e] 编辑):', 'Scoring Rubric patch.rubric ([e] edit):')
                  : convertTargetKind === 'flashcard'
                    ? t(lang, '参考答案 patch.answer ([e] 编辑):', 'Flashcard Answer patch.answer ([e] edit):')
                    : convertTargetKind === 'quiz'
                      ? t(lang, '正确选项文本 (自动补齐干扰项, [e] 编辑):', 'Correct Option Text (auto-fills distractors, [e] edit):')
                      : t(lang, '填空题干 patch.cloze.text (含 {{b1}} 标记, [e] 编辑):', 'Cloze Text patch.cloze.text (with {{b1}}, [e] edit):')}
              </Text>
              <Box
                borderStyle={asciiMode ? 'classic' : 'round'}
                borderColor={convertEditActive ? theme.borderActive : theme.border}
                paddingX={1}
              >
                <TextInput
                  value={convertDraft.primaryText}
                  onChange={(val) => {
                    setConvertDraft((prev) => ({ ...prev, primaryText: val }));
                    setConvertError('');
                  }}
                  onSubmit={() => setConvertEditActive(false)}
                  onCancel={() => setConvertEditActive(false)}
                  isActive={isActive && mode === 'convert' && convertEditActive && !busy}
                  width={Math.max(12, innerW - 6)}
                />
              </Box>
              {convertTargetKind === 'cloze' ? (
                <Text color={theme.dim}>
                  {truncateDisplay(
                    `${t(lang, '填空答案 b1:', 'Blank b1 answer:')} ${convertDraft.secondaryText}`,
                    innerW,
                    ell,
                  )}
                </Text>
              ) : null}
            </Box>
          )}
          {convertError ? (
            <Box marginTop={1}>
              <Text color={theme.error}>{truncateDisplay(convertError, innerW * 2, ell)}</Text>
            </Box>
          ) : null}
          {busy ? (
            <Box marginTop={1}>
              <Spinner label={t(lang, `正在转换题型${ell}`, `Converting card kind${ell}`)} active={isActive} />
            </Box>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <VirtualList
            items={filteredCards}
            height={(searchQuery || selectedIds.size > 0) && mode === 'browse' ? Math.max(3, listH - 1) : listH}
            width={innerW}
            selectedIndex={selectedIndex}
            onChange={(idx) => setSelectedIndex(idx)}
            isActive={false}
            highlightSelected={false}
            keyExtractor={(c) => c.id}
            renderItem={renderCardRow}
            emptyText={t(lang, '没有匹配的题目', 'No matching cards')}
            emptyHint={searchQuery ? t(lang, '按 [c] 清除筛选', 'Press [c] to clear filter') : undefined}
          />
          <Divider width={innerW} />
          <Box height={previewH} width={innerW} overflow="hidden">
            {selectedCard ? (
              <MarkdownView markdown={previewMarkdown} width={innerW} height={previewH} />
            ) : (
              <Text color={theme.muted}>{t(lang, '选择一道题查看详情', 'Select a card to preview')}</Text>
            )}
          </Box>
        </Box>
      )}
    </Modal>
  );
});
