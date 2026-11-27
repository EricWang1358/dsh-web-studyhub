import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, StudySnapshot } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { Divider, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { useTheme } from '../../theme/tokens.js';
import { displayWidth, padDisplay, truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import { runAtomicSteps } from '../../host/tx-write.js';
import { listCourses } from '../../shell/data.js';
import {
  CONVERT_TARGETS,
  MAX_MULTI_SELECT,
  SUPPLEMENT_COUNTS,
  SUPPLEMENT_KINDS,
  buildDeckManageHints,
  buildDeckManageModalTitle,
  buildDeckManageSubtitle,
  buildDefaultConvertDraft,
  filterDeckCards,
  kindLabel,
  sortAvailableSupplementDocs,
  summarizeCardMarkdown,
  type ConvertDraft,
  type ConvertTargetKind,
  type DeckCardItem,
  type FullDeckDetail,
  type ModalMode,
  type SuppJobResult,
} from './deck-manage-model.js';
import { useDeckManageActions } from './useDeckManageActions.js';
import {
  DeckManageBrowseMetaStrip,
  DeckManageConvertPanel,
  DeckManageInputBar,
  DeckManageLinkPanel,
  DeckManageSupplementPanel,
} from './DeckManagePanels.js';

export {
  CARD_BATCH_MAX,
  chunkItems,
  executeBatchSlay,
  executeBatchTopicUpdate,
  executeBatchLink,
  type BatchLinkResult,
  type BatchSlayResult,
  type BatchTopicResult,
  type DeckCardItem,
  type FullDeckDetail,
} from './deck-manage-model.js';

export interface DeckManageModalProps {
  host: HostClient;
  deckId: string;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onUpdated?: () => void;
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
  const [folderValue, setFolderValue] = useState('');
  const [courseDraft, setCourseDraft] = useState('');
  const [topicValue, setTopicValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewScrollTop, setPreviewScrollTop] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBatchSlay, setConfirmBatchSlay] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const deckGenRef = useRef(0);
  const busyTokenRef = useRef(0);

  // Batch prerequisite link sub-mode state ([L])
  const [linkPrereqCursor, setLinkPrereqCursor] = useState(0);
  const [linkError, setLinkError] = useState('');

  // Supplement sub-mode state ([+])
  const [suppSelectedIds, setSuppSelectedIds] = useState<Set<string>>(() => new Set());
  const [suppSourceCursor, setSuppSourceCursor] = useState(0);
  const [suppCountIdx, setSuppCountIdx] = useState(1); // default 5
  const [suppKindIdx, setSuppKindIdx] = useState(0); // default 'mixed'
  const [suppError, setSuppError] = useState('');
  const [suppJobResult, setSuppJobResult] = useState<SuppJobResult | null>(null);

  // Convert card kind sub-mode state ([k])
  const [convertKindIdx, setConvertKindIdx] = useState(0);
  const convertKindIdxRef = useRef(0);
  const [convertDraft, setConvertDraft] = useState<ConvertDraft>({
    primaryText: '',
    secondaryText: '',
    tfIsTrue: true,
  });
  const [convertEditActive, setConvertEditActive] = useState(false);
  const [convertError, setConvertError] = useState('');

  const beginBusy = useCallback((): { token: number; gen: number } | null => {
    if (busyRef.current || busy) return null;
    const token = busyTokenRef.current + 1;
    busyTokenRef.current = token;
    busyRef.current = true;
    setBusy(true);
    return { token, gen: deckGenRef.current };
  }, [busy]);

  const endBusy = useCallback((token: number) => {
    if (busyTokenRef.current !== token) return;
    busyRef.current = false;
    if (mountedRef.current) setBusy(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    deckGenRef.current += 1;
    busyTokenRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setMode('browse');
    setSearchQuery('');
    setSelectedIndex(0);
    setPreviewScrollTop(0);
    setSelectedIds(new Set());
    setConfirmBatchSlay(false);
    setRenameValue('');
    setFolderValue('');
    setCourseDraft('');
    setTopicValue('');
    setLinkPrereqCursor(0);
    setLinkError('');
    setSuppSelectedIds(new Set());
    setSuppSourceCursor(0);
    setSuppCountIdx(1);
    setSuppKindIdx(0);
    setSuppError('');
    setSuppJobResult(null);
    convertKindIdxRef.current = 0;
    setConvertKindIdx(0);
    setConvertEditActive(false);
    setConvertError('');
  }, [deckId]);

  const reloadDeck = useCallback(async (expectedGen?: number): Promise<FullDeckDetail | null> => {
    const startGen = expectedGen ?? deckGenRef.current;
    const res = await tryAction<FullDeckDetail>(host, 'deck.get', { id: deckId });
    if (!mountedRef.current || deckGenRef.current !== startGen) return null;
    if (res.ok && res.value) {
      setDeck(res.value);
      setRenameValue(res.value.title || '');
      setFolderValue(res.value.folder || '');
      setCourseDraft(res.value.course || '');
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

  const refreshSnapshot = useCallback(async () => {
    const snapRes = await tryAction<StudySnapshot>(host, 'snapshot');
    if (mountedRef.current && snapRes.ok && snapRes.value && typeof snapRes.value === 'object') {
      useTuiStore.getState().setSnapshot(snapRes.value);
    }
  }, [host]);

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
        setFolderValue(res.value.folder || '');
        setCourseDraft(res.value.course || '');
      } else {
        setError(res.error?.message || t(lang, '读取题组失败', 'Failed to load deck'));
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [host, deckId, lang]);

  const filteredCards = useMemo(() => filterDeckCards(deck?.cards ?? [], searchQuery), [deck?.cards, searchQuery]);

  useEffect(() => {
    if (selectedIndex >= filteredCards.length) {
      setSelectedIndex(Math.max(0, filteredCards.length - 1));
    }
  }, [filteredCards.length, selectedIndex]);

  const selectedCard = filteredCards[selectedIndex] ?? null;

  const linkCandidates = useMemo(
    () => (deck?.cards ?? []).filter((c) => !selectedIds.has(c.id)),
    [deck?.cards, selectedIds],
  );

  useEffect(() => {
    if (linkPrereqCursor >= linkCandidates.length) {
      setLinkPrereqCursor(Math.max(0, linkCandidates.length - 1));
    }
  }, [linkCandidates.length, linkPrereqCursor]);

  const availableDocs = useMemo(
    () => sortAvailableSupplementDocs(snapshot, deck?.course),
    [snapshot, deck?.course],
  );

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

  const openConvertMode = useCallback(() => {
    if (!selectedCard) return;
    const targets = CONVERT_TARGETS.filter((k) => k !== selectedCard.kind);
    const firstKind = targets[0] ?? 'flashcard';
    convertKindIdxRef.current = 0;
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
        (convertKindIdxRef.current + delta + availableConvertTargets.length) % availableConvertTargets.length;
      const nextKind = availableConvertTargets[nextIdx];
      convertKindIdxRef.current = nextIdx;
      setConvertKindIdx(nextIdx);
      setConvertDraft(buildDefaultConvertDraft(selectedCard, nextKind, lang));
      setConvertEditActive(false);
      setConvertError('');
    },
    [selectedCard, availableConvertTargets, lang],
  );

  // Kept co-located with DeckManageModal so atomic edit-draft rollback ('draft.delete') stays auditable here (#1394).
  const handleRenameSubmit = useCallback(
    async (raw: string) => {
      const nextTitle = raw.trim();
      if (!deck || !nextTitle || nextTitle === deck.title) {
        setMode('browse');
        return;
      }
      const lock = beginBusy();
      if (!lock) return;
      try {
        const editDraftWarning = t(
          lang,
          '该题组已有未发布的编辑草稿，请先在「创建题组」处理后再重命名',
          'This deck has an unpublished edit draft; resolve it in Generate before renaming',
        );
        const snapRes = await tryAction<{ drafts?: Array<{ id?: string; editingDeckId?: string }> }>(host, 'snapshot');
        if (!mountedRef.current || deckGenRef.current !== lock.gen) return;
        const draftsToCheck =
          snapRes.ok && Array.isArray(snapRes.value?.drafts)
            ? snapRes.value.drafts
            : (useTuiStore.getState().snapshot?.drafts ?? []);
        if (draftsToCheck.some((d) => (d as { editingDeckId?: string }).editingDeckId === deck.id)) {
          setMode('browse');
          notify(editDraftWarning, 'warning');
          return;
        }
        const tx = await runAtomicSteps([
          {
            name: 'deck.edit',
            run: async () => {
              const editRes = await tryAction<Record<string, unknown> & { draftVersion?: number }>(host, 'deck.edit', {
                id: deck.id,
              });
              if (!editRes.ok || !editRes.value) {
                return { ok: false, error: editRes.error?.message || t(lang, '无法创建编辑草稿', 'Could not create edit draft') };
              }
              if ((editRes.value.draftVersion ?? 1) !== 1) {
                return { ok: false, error: editDraftWarning };
              }
              return { ok: true, value: editRes.value };
            },
            rollback: async (val) => {
              const orphanDraftId =
                typeof (val as { id?: unknown } | undefined)?.id === 'string'
                  ? String((val as { id: string }).id)
                  : '';
              if (orphanDraftId) {
                await tryAction(host, 'draft.delete', { id: orphanDraftId }).catch(() => {});
              }
            },
          },
          {
            name: 'draft.save',
            run: async (prev) => {
              const editVal = prev[0] as Record<string, unknown>;
              const draft = { ...editVal, title: nextTitle };
              const saveRes = await tryAction<{ id: string; draftVersion?: number }>(host, 'draft.save', { deck: draft });
              if (!saveRes.ok || !saveRes.value) {
                return { ok: false, error: saveRes.error?.message || t(lang, '保存标题失败', 'Failed to save title') };
              }
              return { ok: true, value: saveRes.value };
            },
          },
        ]);
        if (!mountedRef.current) return;
        if (!tx.ok) {
          if (deckGenRef.current === lock.gen) setMode('browse');
          notify(tx.error, tx.error === editDraftWarning ? 'warning' : 'error');
          return;
        }
        const savedDraft = tx.results[1] as { id: string; draftVersion?: number };
        const pubRes = await tryAction(host, 'draft.publish.quick', {
          id: savedDraft.id,
          draftVersion: savedDraft.draftVersion,
        });
        if (!mountedRef.current) return;
        const sameDeck = deckGenRef.current === lock.gen;
        if (sameDeck) setMode('browse');
        if (pubRes.ok) {
          if (sameDeck) setDeck((prev) => (prev ? { ...prev, title: nextTitle } : prev));
          onUpdated?.();
          notify(t(lang, `已重命名为「${nextTitle}」`, `Renamed to "${nextTitle}"`), 'success');
        } else {
          notify(
            t(lang, '已保存草稿，请在创建/编辑页完成发布', 'Draft saved; finish publishing in Generate'),
            'warning',
          );
          if (sameDeck) {
            onClose();
            navigate('generate', { draftId: savedDraft.id });
          }
        }
      } finally {
        endBusy(lock.token);
      }
    },
    [deck, host, lang, notify, onUpdated, onClose, navigate, beginBusy, endBusy],
  );

  const actions = useDeckManageActions({
    host,
    deck,
    selectedCard,
    selectedIds,
    busyRef,
    mountedRef,
    deckGenRef,
    beginBusy,
    endBusy,
    lang,
    ell,
    suppSelectedIds,
    suppCount,
    suppKind,
    convertTargetKind,
    convertDraft,
    setDeck,
    setMode,
    setSelectedIds,
    setConfirmBatchSlay,
    setTopicValue,
    setFolderValue,
    setCourseDraft,
    setLinkPrereqCursor,
    setLinkError,
    setSuppError,
    setSuppJobResult,
    setConvertEditActive,
    setConvertError,
    reloadDeck,
    refreshSnapshot,
    notify,
    navigate,
    onClose,
    onUpdated,
  });

  const frameW = Math.max(48, Math.min(100, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const isSlainDeck = deck?.systemKind === 'slain';
  const hasSlainCard = Boolean(selectedCard?.slain);
  const hasBrowseMetaStrip =
    mode === 'browse' &&
    Boolean(searchQuery || selectedIds.size > 0 || isSlainDeck || hasSlainCard || (!deck?.systemKind && deck?.folder));

  const courseHints = useMemo(
    () => listCourses(snapshot).map((c) => c.key).filter(Boolean).slice(0, 6),
    [snapshot],
  );
  const inputRows =
    mode === 'search' || mode === 'rename' || mode === 'folder' || mode === 'topic'
      ? 3
      : mode === 'course'
        ? courseHints.length > 0
          ? 5
          : 4
        : 0;
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
          void actions.handleSubmitSupplement();
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
          void actions.handleSubmitConvert();
        }
        return;
      }

      if (mode !== 'browse') return;

      const total = filteredCards.length;
      if (key.downArrow || (!key.ctrl && !key.meta && input === 'j')) {
        if (total > 0) {
          setSelectedIndex((i) => Math.min(total - 1, i + 1));
          setPreviewScrollTop(0);
        }
      } else if (key.upArrow) {
        if (total > 0) {
          setSelectedIndex((i) => Math.max(0, i - 1));
          setPreviewScrollTop(0);
        }
      } else if (!key.ctrl && !key.meta && input === 'J') {
        setPreviewScrollTop((tTop) => tTop + 2);
      } else if (!key.ctrl && !key.meta && input === 'K') {
        setPreviewScrollTop((tTop) => Math.max(0, tTop - 2));
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
        if (selectedCard) void actions.handlePracticeCard(selectedCard);
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
        void actions.handleBatchFocus();
      } else if (input === 'S' && selectedIds.size > 0) {
        void actions.handleBatchSuspend();
      } else if (!key.ctrl && !key.meta && input === 'T' && selectedIds.size > 0) {
        if (deck.systemKind) {
          notify(t(lang, '系统题组不支持批量改主题', 'System decks do not support batch topic retag'), 'warning');
        } else {
          setTopicValue('');
          setMode('topic');
        }
      } else if (!key.ctrl && !key.meta && input === 'L' && selectedIds.size > 0) {
        if (deck.systemKind) {
          notify(t(lang, '系统题组不支持批量关联前置', 'System decks do not support batch prerequisite linking'), 'warning');
        } else {
          setLinkPrereqCursor(0);
          setLinkError('');
          setMode('link');
        }
      } else if (!key.ctrl && !key.meta && input === 'X' && selectedIds.size > 0) {
        if (deck.systemKind) {
          notify(t(lang, '系统题组不支持批量斩题', 'System decks do not support batch slay'), 'warning');
        } else {
          setConfirmBatchSlay(true);
        }
      } else if (input === 'x' && selectedIds.size > 0) {
        setSelectedIds(new Set());
      } else if (input === '/' || input === 'f') {
        setMode('search');
      } else if (input === 'c' && searchQuery) {
        setSearchQuery('');
      } else if (input === 'n') {
        setRenameValue(deck.title || '');
        setMode('rename');
      } else if (!key.ctrl && !key.meta && input === 'C') {
        if (busy || busyRef.current || !deck) return;
        if (deck.systemKind) {
          notify(t(lang, '系统题组不能修改所属课程', 'System decks cannot change course'), 'warning');
        } else {
          setCourseDraft(deck.course ?? '');
          setError('');
          setMode('course');
        }
      } else if (!key.ctrl && !key.meta && input === 'm') {
        if (deck.systemKind) {
          notify(t(lang, '系统题组不支持移动目录', 'System decks cannot be moved to a folder'), 'warning');
        } else {
          setFolderValue(deck.folder || '');
          setMode('folder');
        }
      } else if (!key.ctrl && !key.meta && input === 'u') {
        if (deck.systemKind === 'slain' || selectedCard?.slain) {
          void actions.handleRestoreCard();
        }
      } else if (input === 'e') {
        void actions.handleOpenDraft();
      } else if (input === 'p') {
        onClose();
        navigate('review', { deckId: deck.id });
      } else if (input === '+') {
        openSupplementMode();
      } else if (input === 'k') {
        openConvertMode();
      }
    },
    { isActive: isActive && !confirmBatchSlay && (mode === 'browse' || mode === 'supplement' || mode === 'convert') && !loading && !busy },
  );

  const hints = useMemo(
    () =>
      buildDeckManageHints({
        mode,
        lang,
        suppJobResult,
        convertEditActive,
        convertTargetKind,
        selectedCount: selectedIds.size,
        isSlainDeck,
        hasSystemKind: Boolean(deck?.systemKind),
        hasSlainCard,
      }),
    [mode, lang, suppJobResult, convertEditActive, convertTargetKind, selectedIds.size, isSlainDeck, deck?.systemKind, hasSlainCard],
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
      const topic = card.topic ? `${truncateDisplay(card.topic, 14, ell)}${asciiMode ? ' - ' : ' · '}` : '';
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
    if (busyRef.current) return;
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
    setLinkError('');
    setLinkPrereqCursor(0);
    setConvertError('');
    setConvertEditActive(false);
    setMode('browse');
  }, [mode, convertEditActive, onClose]);

  const modalTitle = buildDeckManageModalTitle(mode, deck, lang);
  const modalSubtitle = buildDeckManageSubtitle({
    mode,
    lang,
    suppSelectedCount: suppSelectedIds.size,
    selectedCount: selectedIds.size,
    selectedCard,
    convertTargetKind,
    deck,
    filteredCount: filteredCards.length,
    asciiMode,
  });

  return (
    <>
      <Modal
        title={modalTitle}
        icon={asciiMode ? '#' : '▤'}
        subtitle={modalSubtitle}
        width={frameW}
        height={frameH}
        onClose={handleModalClose}
        isActive={isActive && !confirmBatchSlay && (mode === 'browse' || mode === 'link' || mode === 'supplement' || (mode === 'convert' && !convertEditActive))}
        hints={hints}
      >
        <DeckManageInputBar
          mode={mode}
          lang={lang}
          asciiMode={asciiMode}
          ell={ell}
          theme={theme}
          isActive={isActive}
          busy={busy}
          innerW={innerW}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          renameValue={renameValue}
          onRenameChange={setRenameValue}
          onRenameSubmit={(val) => {
            void handleRenameSubmit(val);
          }}
          folderValue={folderValue}
          onFolderChange={setFolderValue}
          onFolderSubmit={(val) => {
            void actions.handleFolderSubmit(val);
          }}
          courseDraft={courseDraft}
          onCourseChange={setCourseDraft}
          onCourseSubmit={(val) => {
            void actions.handleCourseSubmit(val);
          }}
          onCourseCancel={() => {
            setError('');
            setMode('browse');
          }}
          courseHints={courseHints}
          topicValue={topicValue}
          onTopicChange={setTopicValue}
          onTopicSubmit={(val) => {
            void actions.handleBatchTopicSubmit(val);
          }}
          selectedCount={selectedIds.size}
          onBackToBrowse={() => setMode('browse')}
        />

        {hasBrowseMetaStrip ? (
          <DeckManageBrowseMetaStrip
            lang={lang}
            ell={ell}
            theme={theme}
            innerW={innerW}
            selectedCount={selectedIds.size}
            isSlainDeck={isSlainDeck}
            hasSlainCard={hasSlainCard}
            deck={deck}
            selectedCard={selectedCard}
            searchQuery={searchQuery}
          />
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
          <DeckManageSupplementPanel
            deck={deck}
            deckId={deckId}
            lang={lang}
            asciiMode={asciiMode}
            ell={ell}
            theme={theme}
            bodyH={bodyH}
            innerW={innerW}
            isActive={isActive}
            busy={busy}
            suppJobResult={suppJobResult}
            suppCount={suppCount}
            suppKind={suppKind}
            suppError={suppError}
            availableDocs={availableDocs}
            suppSourceCursor={suppSourceCursor}
            suppSelectedIds={suppSelectedIds}
            onCursorChange={setSuppSourceCursor}
            onSubmit={() => {
              void actions.handleSubmitSupplement();
            }}
          />
        ) : mode === 'convert' && selectedCard ? (
          <DeckManageConvertPanel
            selectedCard={selectedCard}
            availableConvertTargets={availableConvertTargets}
            convertKindIdx={convertKindIdx}
            convertTargetKind={convertTargetKind}
            convertDraft={convertDraft}
            convertEditActive={convertEditActive}
            convertError={convertError}
            lang={lang}
            asciiMode={asciiMode}
            ell={ell}
            theme={theme}
            bodyH={bodyH}
            innerW={innerW}
            isActive={isActive}
            busy={busy}
            onPrimaryTextChange={(val) => {
              setConvertDraft((prev) => ({ ...prev, primaryText: val }));
              setConvertError('');
            }}
            onCloseEdit={() => setConvertEditActive(false)}
          />
        ) : mode === 'link' ? (
          <DeckManageLinkPanel
            selectedCount={selectedIds.size}
            linkCandidates={linkCandidates}
            linkPrereqCursor={linkPrereqCursor}
            linkError={linkError}
            lang={lang}
            asciiMode={asciiMode}
            ell={ell}
            theme={theme}
            bodyH={bodyH}
            innerW={innerW}
            isActive={isActive}
            busy={busy}
            onCursorChange={setLinkPrereqCursor}
            onSelectPrereq={(card) => {
              void actions.handleBatchLinkSubmit(card);
            }}
          />
        ) : (
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            <VirtualList
              items={filteredCards}
              height={hasBrowseMetaStrip ? Math.max(3, listH - 1) : listH}
              width={innerW}
              selectedIndex={selectedIndex}
              onChange={(idx) => setSelectedIndex(idx)}
              isActive={false}
              highlightSelected={false}
              keyExtractor={(c) => c.id}
              renderItem={renderCardRow}
              emptyText={
                isSlainDeck && !searchQuery
                  ? t(lang, '斩题组已清空', 'No slain cards remaining')
                  : t(lang, '没有匹配的题目', 'No matching cards')
              }
              emptyHint={searchQuery ? t(lang, '按 [c] 清除筛选', 'Press [c] to clear filter') : undefined}
            />
            <Divider width={innerW} />
            <Box height={previewH} width={innerW} overflow="hidden">
              {selectedCard ? (
                <MarkdownView
                  markdown={previewMarkdown}
                  width={innerW}
                  height={previewH}
                  scrollTop={previewScrollTop}
                  onScroll={setPreviewScrollTop}
                />
              ) : (
                <Text color={theme.muted}>{t(lang, '选择一道题查看详情', 'Select a card to preview')}</Text>
              )}
            </Box>
          </Box>
        )}
      </Modal>

      {confirmBatchSlay && deck && !deck.systemKind ? (
        <ConfirmDialog
          title={t(lang, '确认批量斩题', 'Confirm Batch Slay')}
          message={t(
            lang,
            `确定将已选的 ${selectedIds.size} 道题原子移入「已斩题 / Slain」题组？移入后不会在日常复习中出现，可随时在「已斩题」中按 [u] 恢复。`,
            `Atomically move the ${selectedIds.size} selected card(s) to the "已斩题 / Slain" deck? They will be excluded from daily reviews and can be restored anytime via [u].`,
          )}
          confirmLabel={t(lang, '确认斩题', 'Slay')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          isActive={isActive && !busy}
          width={Math.min(64, Math.max(44, width - 6))}
          onConfirm={() => {
            void actions.handleBatchSlay();
          }}
          onCancel={() => setConfirmBatchSlay(false)}
        />
      ) : null}
    </>
  );
});
