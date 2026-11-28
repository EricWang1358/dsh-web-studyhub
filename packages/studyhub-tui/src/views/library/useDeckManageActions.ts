import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { HostClient, PageId } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { truncateDisplay } from '../../render/cjk.js';
import { startReview, tryAction } from '../../host/sample-actions.js';
import {
  buildConvertPatch,
  executeBatchLink,
  executeBatchSlay,
  executeBatchTopicUpdate,
  kindLabel,
  normalizeFolderInput,
  type ConvertDraft,
  type ConvertTargetKind,
  type DeckCardItem,
  type FullDeckDetail,
  type BusyWait,
  type ModalMode,
  type SuppJobResult,
} from './deck-manage-model.js';

export interface BusyLock {
  token: number;
  gen: number;
}

export interface UseDeckManageActionsParams {
  host: HostClient;
  deck: FullDeckDetail | null;
  selectedCard: DeckCardItem | null;
  selectedIds: Set<string>;
  busyRef: MutableRefObject<boolean>;
  mountedRef: MutableRefObject<boolean>;
  deckGenRef: MutableRefObject<number>;
  beginBusy: (wait?: BusyWait) => BusyLock | null;
  endBusy: (token: number) => void;
  lang: 'zh' | 'en';
  ell: string;
  suppSelectedIds: Set<string>;
  suppCount: number;
  suppKind: string;
  convertTargetKind: ConvertTargetKind;
  convertDraft: ConvertDraft;
  setDeck: Dispatch<SetStateAction<FullDeckDetail | null>>;
  setMode: Dispatch<SetStateAction<ModalMode>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setConfirmBatchSlay: Dispatch<SetStateAction<boolean>>;
  setTopicValue: Dispatch<SetStateAction<string>>;
  setFolderValue: Dispatch<SetStateAction<string>>;
  setCourseDraft: Dispatch<SetStateAction<string>>;
  setLinkPrereqCursor: Dispatch<SetStateAction<number>>;
  setLinkError: Dispatch<SetStateAction<string>>;
  setSuppError: Dispatch<SetStateAction<string>>;
  setSuppJobResult: Dispatch<SetStateAction<SuppJobResult | null>>;
  setConvertEditActive: Dispatch<SetStateAction<boolean>>;
  setConvertError: Dispatch<SetStateAction<string>>;
  reloadDeck: (expectedGen?: number) => Promise<FullDeckDetail | null>;
  refreshSnapshot: () => Promise<void>;
  notify: (text: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  navigate: (page: PageId, context?: Record<string, unknown>) => void;
  onClose: () => void;
  onUpdated?: () => void;
}

export function useDeckManageActions(params: UseDeckManageActionsParams) {
  const {
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
  } = params;

  const handleSubmitSupplement = useCallback(async () => {
    if (!deck || busyRef.current) return;
    const sourceIds = [...suppSelectedIds];
    if (sourceIds.length === 0) {
      const msg = t(lang, '请先按 [Space] 勾选至少一份资料', 'Press [Space] to select at least one source');
      setSuppError(msg);
      notify(msg, 'warning');
      return;
    }
    const lock = beginBusy();
    if (!lock) return;
    setSuppError('');
    try {
      const res = await tryAction<{ jobId?: string; id?: string; status?: string }>(host, 'supplement', {
        deckId: deck.id,
        sourceIds,
        count: suppCount,
        kind: suppKind,
      });
      if (!mountedRef.current) return;
      const sameDeck = deckGenRef.current === lock.gen;
      if (!res.ok) {
        const msg = res.error?.message || t(lang, '提交补题任务失败', 'Failed to queue supplement job');
        if (sameDeck) setSuppError(msg);
        notify(msg, 'error');
        return;
      }
      const jobId = String(res.value?.jobId || res.value?.id || 'queued');
      if (sameDeck) {
        setSuppJobResult({
          jobId,
          status: res.value?.status,
          count: suppCount,
          kind: suppKind,
        });
      }
      onUpdated?.();
      notify(
        t(lang, `补题任务已入队 (${jobId})，可按 [t] 查看后台任务`, `Supplement job queued (${jobId}) — press [t] for Tasks`),
        'success',
      );
    } finally {
      endBusy(lock.token);
    }
  }, [
    deck,
    busyRef,
    suppSelectedIds,
    suppCount,
    suppKind,
    host,
    lang,
    notify,
    onUpdated,
    mountedRef,
    deckGenRef,
    beginBusy,
    endBusy,
    setSuppError,
    setSuppJobResult,
  ]);

  const handleSubmitConvert = useCallback(async () => {
    if (!deck || !selectedCard) return;
    const lock = beginBusy();
    if (!lock) return;
    setConvertError('');
    try {
      const patch = buildConvertPatch(selectedCard, convertTargetKind, convertDraft, lang);
      const res = await tryAction<{ deckId?: string; cardId?: string; kind?: string }>(host, 'card.convert', {
        cardId: selectedCard.id,
        deckId: deck.id,
        kind: convertTargetKind,
        patch,
        reason: `Converted from ${selectedCard.kind || 'unknown'} to ${convertTargetKind} in TUI`,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        if (deckGenRef.current === lock.gen) {
          setConvertError(res.error?.message || t(lang, '转换题型失败', 'Card conversion failed'));
        }
        return;
      }
      if (deckGenRef.current === lock.gen) {
        await reloadDeck(lock.gen);
        if (!mountedRef.current) return;
      }
      onUpdated?.();
      if (deckGenRef.current === lock.gen) {
        setConvertEditActive(false);
        setMode('browse');
      }
      notify(
        t(
          lang,
          `已转换为「${kindLabel(convertTargetKind, lang)}」`,
          `Converted card to ${kindLabel(convertTargetKind, lang)}`,
        ),
        'success',
      );
    } finally {
      endBusy(lock.token);
    }
  }, [
    deck,
    selectedCard,
    convertTargetKind,
    convertDraft,
    lang,
    host,
    reloadDeck,
    onUpdated,
    notify,
    mountedRef,
    deckGenRef,
    beginBusy,
    endBusy,
    setConvertError,
    setConvertEditActive,
    setMode,
  ]);

  const handleOpenDraft = useCallback(async () => {
    if (!deck) return;
    const lock = beginBusy('open');
    if (!lock) return;
    try {
      const editRes = await tryAction<{ id: string }>(host, 'deck.edit', { id: deck.id });
      if (!mountedRef.current || deckGenRef.current !== lock.gen) return;
      if (!editRes.ok || !editRes.value?.id) {
        notify(editRes.error?.message || t(lang, '打开草稿失败', 'Failed to open draft'), 'error');
        return;
      }
      onClose();
      navigate('generate', { draftId: editRes.value.id });
    } finally {
      endBusy(lock.token);
    }
  }, [deck, host, notify, lang, onClose, navigate, mountedRef, deckGenRef, beginBusy, endBusy]);

  const handleBatchFocus = useCallback(async () => {
    if (!deck || selectedIds.size === 0) return;
    const targetCards = (deck.cards ?? []).filter((c) => selectedIds.has(c.id));
    if (targetCards.length === 0) return;
    const allFocused = targetCards.every((c) => Boolean(c.focus));
    const nextFocus = !allFocused;
    const lock = beginBusy();
    if (!lock) return;
    let succeeded = 0;
    let failed = 0;
    try {
      for (const card of targetCards) {
        if (!mountedRef.current || deckGenRef.current !== lock.gen) break;
        const res = await tryAction<{ ok?: boolean; focus?: boolean }>(host, 'card.focus', {
          deckId: deck.id,
          cardId: card.id,
          focus: nextFocus,
        });
        if (!mountedRef.current) return;
        if (res.ok) succeeded += 1;
        else failed += 1;
      }
      if (deckGenRef.current === lock.gen) {
        await reloadDeck(lock.gen);
        if (!mountedRef.current) return;
      }
      if (succeeded > 0 || deckGenRef.current === lock.gen) {
        onUpdated?.();
      }
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
    } finally {
      endBusy(lock.token);
    }
  }, [mountedRef, deckGenRef, beginBusy, endBusy, deck, selectedIds, host, reloadDeck, onUpdated, notify, lang]);

  const handleBatchSuspend = useCallback(async () => {
    if (!deck || selectedIds.size === 0) return;
    const targetCards = (deck.cards ?? []).filter((c) => selectedIds.has(c.id));
    if (targetCards.length === 0) return;
    const allSuspended = targetCards.every((c) => Boolean(c.suspended));
    const nextSuspended = !allSuspended;
    const lock = beginBusy();
    if (!lock) return;
    let succeeded = 0;
    let failed = 0;
    let lastError = '';
    try {
      for (const card of targetCards) {
        if (!mountedRef.current || deckGenRef.current !== lock.gen) break;
        const res = await tryAction<{ ok?: boolean }>(host, 'card.suspend', {
          deckId: deck.id,
          cardId: card.id,
          suspended: nextSuspended,
        });
        if (!mountedRef.current) return;
        if (res.ok) succeeded += 1;
        else {
          failed += 1;
          if (res.error?.message) lastError = res.error.message;
        }
      }
      if (deckGenRef.current === lock.gen) {
        await reloadDeck(lock.gen);
        if (!mountedRef.current) return;
      }
      if (succeeded > 0 || deckGenRef.current === lock.gen) {
        onUpdated?.();
      }
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
    } finally {
      endBusy(lock.token);
    }
  }, [mountedRef, deckGenRef, beginBusy, endBusy, deck, selectedIds, host, reloadDeck, onUpdated, notify, lang]);

  const handleBatchSlay = useCallback(async () => {
    if (!deck || deck.systemKind || selectedIds.size === 0) {
      setConfirmBatchSlay(false);
      return;
    }
    const targetIds = (deck.cards ?? []).filter((c) => selectedIds.has(c.id)).map((c) => c.id);
    if (targetIds.length === 0) {
      setConfirmBatchSlay(false);
      return;
    }
    const lock = beginBusy();
    if (!lock) {
      setConfirmBatchSlay(false);
      return;
    }
    setConfirmBatchSlay(false);
    try {
      const result = await executeBatchSlay(host, deck.id, targetIds, lang);
      if (!mountedRef.current) return;
      const sameDeck = deckGenRef.current === lock.gen;
      if (!result.ok) {
        if (result.partial) {
          if (sameDeck) {
            setSelectedIds(new Set());
            await reloadDeck(lock.gen);
          }
          await refreshSnapshot();
          if (!mountedRef.current) return;
          onUpdated?.();
        }
        notify(result.error || t(lang, '批量斩题失败', 'Batch slay failed'), result.partial ? 'warning' : 'error');
        return;
      }
      if (sameDeck) {
        setSelectedIds(new Set());
        await reloadDeck(lock.gen);
      }
      await refreshSnapshot();
      if (!mountedRef.current) return;
      onUpdated?.();
      notify(
        t(
          lang,
          `已原子斩除 ${result.slain} 题并移入「已斩题」（可随时按 [u] 恢复）`,
          `Atomically slain ${result.slain} card(s) to "Slain" (press [u] anytime to restore)`,
        ),
        'success',
      );
    } finally {
      endBusy(lock.token);
    }
  }, [
    mountedRef,
    deckGenRef,
    beginBusy,
    endBusy,
    deck,
    selectedIds,
    host,
    notify,
    lang,
    reloadDeck,
    refreshSnapshot,
    onUpdated,
    setConfirmBatchSlay,
    setSelectedIds,
  ]);

  const handleBatchTopicSubmit = useCallback(
    async (raw: string) => {
      if (!deck || deck.systemKind || selectedIds.size === 0) {
        setMode('browse');
        return;
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        setMode('browse');
        return;
      }
      const targetIds = [...selectedIds];
      if (targetIds.length === 0) {
        setMode('browse');
        return;
      }
      const lock = beginBusy();
      if (!lock) return;
      try {
        const result = await executeBatchTopicUpdate(host, deck.id, targetIds, trimmed, lang);
        if (!mountedRef.current) return;
        const sameDeck = deckGenRef.current === lock.gen;
        if (!result.ok) {
          if (result.partial) {
            if (sameDeck) {
              setSelectedIds(new Set());
              await reloadDeck(lock.gen);
            }
            await refreshSnapshot();
            if (!mountedRef.current) return;
            onUpdated?.();
          }
          if (deckGenRef.current === lock.gen) setMode('browse');
          notify(result.error || t(lang, '批量修改主题失败', 'Batch topic retag failed'), result.partial ? 'warning' : 'error');
          return;
        }
        if (sameDeck) {
          setSelectedIds(new Set());
          setTopicValue('');
          await reloadDeck(lock.gen);
        }
        await refreshSnapshot();
        if (!mountedRef.current) return;
        onUpdated?.();
        if (deckGenRef.current === lock.gen) setMode('browse');
        notify(
          result.failed > 0
            ? t(
                lang,
                `已将 ${result.updated} 题的主题更新为「${trimmed}」（${result.failed} 题失败）`,
                `Retagged ${result.updated} card(s) to "${trimmed}" (${result.failed} failed)`,
              )
            : t(
                lang,
                `已将 ${result.updated} 题的主题更新为「${trimmed}」`,
                `Retagged ${result.updated} card(s) to "${trimmed}"`,
              ),
          result.failed > 0 ? 'warning' : 'success',
        );
      } finally {
        endBusy(lock.token);
      }
    },
    [
      mountedRef,
      deckGenRef,
      beginBusy,
      endBusy,
      deck,
      selectedIds,
      host,
      notify,
      lang,
      reloadDeck,
      refreshSnapshot,
      onUpdated,
      setMode,
      setSelectedIds,
      setTopicValue,
    ],
  );

  const handleBatchLinkSubmit = useCallback(
    async (prereq: DeckCardItem) => {
      if (!deck || deck.systemKind || selectedIds.size === 0) return;
      const targetIds = [...selectedIds];
      const lock = beginBusy();
      if (!lock) return;
      setLinkError('');
      try {
        const result = await executeBatchLink(host, deck.id, targetIds, prereq.id, lang);
        if (!mountedRef.current) return;
        const sameDeck = deckGenRef.current === lock.gen;
        if (!result.ok) {
          if (result.partial) {
            if (sameDeck) {
              setSelectedIds(new Set());
              await reloadDeck(lock.gen);
            }
            await refreshSnapshot();
            if (!mountedRef.current) return;
            onUpdated?.();
          }
          const msg = result.error || t(lang, '批量关联前置题失败', 'Batch prerequisite linking failed');
          if (deckGenRef.current === lock.gen) setLinkError(msg);
          notify(msg, result.partial ? 'warning' : 'error');
          return;
        }
        if (sameDeck) {
          setSelectedIds(new Set());
          setLinkPrereqCursor(0);
          setLinkError('');
          await reloadDeck(lock.gen);
        }
        await refreshSnapshot();
        if (!mountedRef.current) return;
        onUpdated?.();
        if (deckGenRef.current === lock.gen) setMode('browse');
        const prereqLabel = truncateDisplay(
          String(prereq.prompt || prereq.cloze?.text || prereq.id).replace(/\s+/g, ' ').trim(),
          28,
          ell,
        );
        notify(
          result.failed > 0
            ? t(
                lang,
                `已为 ${result.linked} 题关联前置「${prereqLabel}」（${result.failed} 题失败）`,
                `Linked ${result.linked} card(s) to prerequisite "${prereqLabel}" (${result.failed} failed)`,
              )
            : t(
                lang,
                `已为 ${result.linked} 题关联前置「${prereqLabel}」`,
                `Linked ${result.linked} card(s) to prerequisite "${prereqLabel}"`,
              ),
          result.failed > 0 ? 'warning' : 'success',
        );
      } finally {
        endBusy(lock.token);
      }
    },
    [
      mountedRef,
      deckGenRef,
      beginBusy,
      endBusy,
      deck,
      selectedIds,
      host,
      notify,
      lang,
      reloadDeck,
      refreshSnapshot,
      onUpdated,
      ell,
      setLinkError,
      setLinkPrereqCursor,
      setMode,
      setSelectedIds,
    ],
  );

  const handleFolderSubmit = useCallback(
    async (raw: string) => {
      if (!deck) {
        setMode('browse');
        return;
      }
      if (deck.systemKind) {
        setMode('browse');
        notify(t(lang, '系统题组不支持移动目录', 'System decks cannot be moved to a folder'), 'warning');
        return;
      }
      const normalizedFolder = normalizeFolderInput(raw);
      if (normalizedFolder === (deck.folder || '')) {
        setMode('browse');
        return;
      }
      const lock = beginBusy();
      if (!lock) return;
      try {
        const res = await tryAction<{ id?: string; folder?: string }>(host, 'deck.move', {
          id: deck.id,
          folder: raw.trim(),
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          if (deckGenRef.current === lock.gen) setMode('browse');
          notify(res.error?.message || t(lang, '移动目录失败', 'Failed to move folder'), 'error');
          return;
        }
        const savedFolder = typeof res.value?.folder === 'string' ? res.value.folder : normalizedFolder;
        if (deckGenRef.current === lock.gen) {
          setDeck((prev) => (prev ? { ...prev, folder: savedFolder } : prev));
          setFolderValue(savedFolder);
        }
        await refreshSnapshot();
        if (!mountedRef.current) return;
        onUpdated?.();
        if (deckGenRef.current === lock.gen) setMode('browse');
        notify(
          savedFolder
            ? t(lang, `已移动到目录「${savedFolder}」`, `Moved to folder "${savedFolder}"`)
            : t(lang, '已移出目录', 'Cleared deck folder'),
          'success',
        );
      } finally {
        endBusy(lock.token);
      }
    },
    [mountedRef, deckGenRef, beginBusy, endBusy, deck, host, notify, lang, refreshSnapshot, onUpdated, setDeck, setFolderValue, setMode],
  );

  const handleCourseSubmit = useCallback(
    async (raw: string) => {
      if (!deck) return;
      if (deck.systemKind) {
        setMode('browse');
        notify(t(lang, '系统题组不能修改所属课程', 'System decks cannot change course'), 'warning');
        return;
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        notify(t(lang, '课程名称不能为空', 'Course name cannot be empty'), 'warning');
        return;
      }
      if (trimmed.length > 200) {
        notify(t(lang, '课程名称不能超过 200 个字符', 'Course name must be 200 characters or fewer'), 'warning');
        return;
      }
      if (trimmed === (deck.course ?? '').trim()) {
        setMode('browse');
        return;
      }
      const lock = beginBusy();
      if (!lock) return;
      try {
        const res = await tryAction<{ id?: string; course?: string }>(host, 'deck.course', {
          id: deck.id,
          course: trimmed,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          notify(res.error?.message || t(lang, '修改所属课程失败', 'Failed to update deck course'), 'error');
          return;
        }
        const savedCourse = res.value?.course ?? trimmed;
        if (deckGenRef.current === lock.gen) {
          setDeck((prev) => (prev ? { ...prev, course: savedCourse } : prev));
          setCourseDraft(savedCourse);
        }
        await refreshSnapshot();
        if (!mountedRef.current) return;
        onUpdated?.();
        if (deckGenRef.current === lock.gen) setMode('browse');
        notify(
          t(lang, `已将题组归入课程「${savedCourse}」`, `Moved deck to course "${savedCourse}"`),
          'success',
        );
      } finally {
        endBusy(lock.token);
      }
    },
    [mountedRef, deckGenRef, beginBusy, endBusy, deck, host, notify, lang, refreshSnapshot, onUpdated, setDeck, setCourseDraft, setMode],
  );

  const handleRestoreCard = useCallback(async () => {
    if (!deck || !selectedCard) return;
    if (deck.systemKind !== 'slain' && !selectedCard.slain) return;
    const lock = beginBusy();
    if (!lock) return;
    try {
      const res = await tryAction<{ deckId?: string; cardId?: string; title?: string }>(host, 'card.restore', {
        deckId: deck.id,
        cardId: selectedCard.id,
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        notify(res.error?.message || t(lang, '恢复原题组失败', 'Failed to restore card'), 'error');
        return;
      }
      const targetTitle = String(
        res.value?.title || selectedCard.slain?.deckTitle || selectedCard.slain?.deckId || t(lang, '原题组', 'original deck'),
      );
      if (deckGenRef.current === lock.gen) {
        await reloadDeck(lock.gen);
      }
      await refreshSnapshot();
      if (!mountedRef.current) return;
      onUpdated?.();
      notify(t(lang, `已恢复到「${targetTitle}」`, `Restored to "${targetTitle}"`), 'success');
    } finally {
      endBusy(lock.token);
    }
  }, [mountedRef, deckGenRef, beginBusy, endBusy, deck, selectedCard, host, notify, lang, reloadDeck, refreshSnapshot, onUpdated]);

  const handlePracticeCard = useCallback(
    async (card: DeckCardItem) => {
      if (!deck) return;
      const lock = beginBusy('open');
      if (!lock) return;
      try {
        const run = await startReview(host, {
          mode: 'path',
          scope: [{ deckId: deck.id, cardId: card.id }],
          fresh: true,
        });
        if (!mountedRef.current || deckGenRef.current !== lock.gen) return;
        onClose();
        navigate('review', { runId: run.id, deckId: deck.id });
      } catch (err) {
        if (mountedRef.current) {
          notify(err instanceof Error ? err.message : String(err), 'error');
        }
      } finally {
        endBusy(lock.token);
      }
    },
    [deck, host, onClose, navigate, notify, mountedRef, deckGenRef, beginBusy, endBusy],
  );

  return {
    handleSubmitSupplement,
    handleSubmitConvert,
    handleOpenDraft,
    handleBatchFocus,
    handleBatchSuspend,
    handleBatchSlay,
    handleBatchTopicSubmit,
    handleBatchLinkSubmit,
    handleFolderSubmit,
    handleCourseSubmit,
    handleRestoreCard,
    handlePracticeCard,
  };
}
