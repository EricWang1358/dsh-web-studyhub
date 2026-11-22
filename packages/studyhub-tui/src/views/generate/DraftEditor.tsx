import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  ConfirmDialog,
  Divider,
  EmptyState,
  MarkdownView,
  Modal,
  Panel,
  Spinner,
  SplitPane,
  TextInput,
  VirtualList,
  modalContentWidth,
  useClaimKeys,
  useFooterHints,
  useInputCapture,
  useTheme,
} from '../../components/index.js';
import { useShellActions } from '../../shell/actions.js';
import { truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/sample-actions.js';

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

type DraftOverlay =
  | 'none'
  | 'pick-draft'
  | 'edit-card'
  | 'delete-card'
  | 'delete-draft'
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
  const [lastRemoved, setLastRemoved] = useState<{
    draftId: string;
    index: number;
    card: DraftCard;
  } | null>(null);

  useEffect(() => {
    if (initialDraftId) setSelectedDraftId(initialDraftId);
  }, [initialDraftId]);

  useEffect(() => {
    setLastRemoved((prev) => (prev && prev.draftId === selectedDraftId ? prev : null));
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

  useEffect(() => {
    if (draft && cardIndex >= draft.cards.length) {
      setCardIndex(Math.max(0, draft.cards.length - 1));
    }
  }, [draft, cardIndex]);

  const selectedCard: DraftCard | undefined = draft?.cards[cardIndex];

  const saveDraftCards = useCallback(
    async (nextCards: DraftCard[], msg: string): Promise<boolean> => {
      if (!draft || busy) return false;
      setBusy(true);
      const updated = { ...draft, cards: nextCards };
      const res = await tryAction<FullDraft>(host, 'draft.save', { deck: updated });
      setBusy(false);
      if (!res.ok) {
        notify(res.error?.message || t(lang, '保存草稿失败', 'Save draft failed'), 'error');
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
    if (!draft || !selectedCard || busy) return;
    if (draft.cards.length <= 1) {
      setOverlay('none');
      notify(t(lang, '最后一道题请使用 [D] 删除整份草稿', 'Use [D] to delete the whole draft'), 'warning');
      return;
    }
    const removed = { draftId: draft.id, index: cardIndex, card: selectedCard };
    const next = draft.cards.filter((_, idx) => idx !== cardIndex);
    setOverlay('none');
    const ok = await saveDraftCards(
      next,
      t(lang, '已移除该题目（按 [u] 撤销）', 'Removed card from draft (press [u] to undo)'),
    );
    if (ok) {
      setLastRemoved(removed);
    }
  }, [busy, cardIndex, draft, lang, notify, saveDraftCards, selectedCard]);

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
      setCardIndex(insertAt);
    }
  }, [busy, draft, lang, lastRemoved, saveDraftCards]);

  const checkSimilar = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    setBusyLabel(t(lang, '查重中…', 'Checking…'));
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
  }, [busy, draft, host, lang, notify]);

  const repairDraft = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    setBusyLabel(t(lang, '修题中…', 'Repairing…'));
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
  }, [busy, draft, host, lang, loadDraft, notify, refresh]);

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

  const mainListActive = isActive && overlay === 'none';
  const canUndoRemove = Boolean(draft && lastRemoved && lastRemoved.draftId === draft.id);
  useClaimKeys(
    canUndoRemove
      ? ['e', 'x', 'u', 's', 'S', 'R', 'P', 'D', 'd', 'n']
      : ['e', 'x', 's', 'S', 'R', 'P', 'D', 'd', 'n'],
    mainListActive,
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
      { key: 'P', label: t(lang, '发布', 'Publish') },
      { key: 'D', label: t(lang, '删草稿', 'Del') },
    ],
    [lang, canUndoRemove],
  );
  useFooterHints(hints, isActive);

  useInput(
    (input, key) => {
      if (overlay === 'edit-card') {
        if (key.ctrl && input === 'n') {
          setEditField((f) => (f === 'prompt' ? 'explanation' : 'prompt'));
        } else if (key.ctrl && input === 's' && draft && selectedCard) {
          const next = draft.cards.map((c, idx) =>
            idx === cardIndex ? { ...c, prompt: editPrompt, explanation: editExplanation } : c,
          );
          setOverlay('none');
          void saveDraftCards(next, t(lang, '题目修改已保存', 'Card updated'));
        }
        return;
      }

      if (!mainListActive) return;

      if (input === 'd' && draftsList.length > 0) {
        const idx = Math.max(0, draftsList.findIndex((item) => item.id === selectedDraftId));
        setDraftPickerIdx(idx);
        setOverlay('pick-draft');
        return;
      }

      if (!draft) return;

      if (input === 'u' && lastRemoved && lastRemoved.draftId === draft.id) {
        void undoRemoveCard();
        return;
      }

      if (!selectedCard) return;

      if (input === 'e') {
        setEditPrompt(String(selectedCard.prompt || ''));
        setEditExplanation(String(selectedCard.explanation || ''));
        setEditField('prompt');
        setOverlay('edit-card');
      } else if (input === 'x') {
        if (draft.cards.length <= 1) {
          notify(t(lang, '最后一道题请使用 [D] 删除整份草稿', 'Use [D] to delete the whole draft'), 'warning');
          return;
        }
        setOverlay('delete-card');
      } else if (input === 'R') {
        void repairDraft();
      } else if (input === 'S' || input === 's') {
        void checkSimilar();
      } else if (input === 'P') {
        setOverlay('publish-confirm');
      } else if (input === 'D') {
        setOverlay('delete-draft');
      }
    },
    { isActive },
  );

  const cardMarkdown = useMemo(() => {
    if (!selectedCard) return '';
    const parts: string[] = [];
    parts.push(`### ${selectedCard.prompt || ''}`);
    if (Array.isArray(selectedCard.options) && selectedCard.options.length > 0) {
      parts.push(
        selectedCard.options
          .map((opt, idx) => {
            const mark = opt.correct ? '✓' : '○';
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
  }, [selectedCard, lang]);

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

  const headerH = 2;
  const bodyH = Math.max(4, height - headerH);

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

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Draft Header Bar */}
      <Box height={headerH} width={width} paddingX={1} flexDirection="column">
        <Box flexDirection="row" alignItems="center">
          <Text bold color={theme.primary}>
            {truncateDisplay(
              String(draft?.title || draftsList.find((d) => d.id === selectedDraftId)?.title || selectedDraftId),
              Math.max(12, width - 44),
              ell,
            )}
          </Text>
          <Text> </Text>
          {draft?.course ? <Badge label={draft.course} tone="accent" variant="soft" /> : null}
          <Text> </Text>
          <Badge label={`${draft?.cards.length ?? 0} ${t(lang, '题', 'cards')}`} tone="info" variant="soft" />
          {rejectedCount > 0 ? (
            <>
              <Text> </Text>
              <Badge label={`${rejectedCount} ${t(lang, '待修', 'fix')}`} tone="warning" variant="soft" />
            </>
          ) : null}
          <Box flexGrow={1} />
          {busy ? <Spinner label={busyLabel || t(lang, '处理中…', 'Working…')} active={isActive} /> : (
            <Text color={theme.dim}>{t(lang, `[d] 切换 (${draftsList.length})  [R] 修题  [S] 查重  [P] 发布`, `[d] Switch (${draftsList.length})  [R] Repair  [S] Similar  [P] Publish`)}</Text>
          )}
        </Box>
        <Text color={theme.dim}>
          {truncateDisplay(
            t(lang, '审校草稿题干、选项与解析；[R] 后台修题  [S] 查重  [P] 发布到学习库', 'Review stems & explanations; [R] Repair  [S] Similar  [P] Publish'),
            Math.max(20, width - 2),
            ell,
          )}
        </Text>
      </Box>

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
              badge={draft?.cards.length ?? 0}
              width={lw}
              height={lh}
              focused={mainListActive}
            >
              {loading ? (
                <Spinner label={t(lang, '加载草稿…', 'Loading draft…')} active={isActive} />
              ) : (
                <VirtualList
                  items={draft?.cards ?? []}
                  height={Math.max(1, lh - 2)}
                  width={Math.max(12, lw - 4)}
                  selectedIndex={cardIndex}
                  onChange={(idx) => setCardIndex(idx)}
                  isActive={mainListActive}
                  keyExtractor={(c, i) => `${c.id}-${i}`}
                  renderItem={(card, ctx) => {
                    const kindLabel = kindLabelFor(card.kind, lang);
                    const warn = similarMap.has(card.id) ? (asciiMode ? '! ' : '⚠ ') : '';
                    const pointer = ctx.selected ? (asciiMode ? '> ' : '▸ ') : '  ';
                    const prefix = `${ctx.index + 1}. [${kindLabel}] `;
                    const stemMax = Math.max(8, ctx.width - prefix.length - (warn ? 2 : 0) - 3);
                    return (
                      <Box flexDirection="row" width={ctx.width}>
                        <Text color={ctx.selected ? theme.primary : theme.muted}>{pointer}</Text>
                        {warn ? <Text color={theme.warning}>{warn}</Text> : null}
                        <Text color={theme.accent}>{prefix}</Text>
                        <Text color={theme.text} bold={ctx.selected}>
                          {truncateDisplay(String(card.prompt || '').replace(/\s+/g, ' '), stemMax, ell)}
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
              title={selectedCard ? `#${cardIndex + 1} ${kindLabelFor(selectedCard.kind, lang)}` : t(lang, '详情', 'Detail')}
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
          title={t(lang, `编辑第 ${cardIndex + 1} 题`, `Edit Card #${cardIndex + 1}`)}
          width={72}
          isActive={isActive}
          onClose={() => setOverlay('none')}
          hints={[
            { key: 'Ctrl+N', label: t(lang, '切换字段', 'Switch field') },
            { key: 'Ctrl+S', label: t(lang, '保存', 'Save') },
            { key: 'Esc', label: t(lang, '取消', 'Cancel') },
          ]}
        >
          <Text color={editField === 'prompt' ? theme.primary : theme.muted} bold={editField === 'prompt'}>
            {t(lang, '题干 (Prompt):', 'Stem (Prompt):')}
          </Text>
          <TextInput
            value={editPrompt}
            onChange={setEditPrompt}
            onCancel={() => setOverlay('none')}
            multiline
            height={4}
            width={modalContentWidth(72) - 4}
            isActive={isActive && editField === 'prompt'}
          />
          <Box marginTop={1}>
            <Text color={editField === 'explanation' ? theme.primary : theme.muted} bold={editField === 'explanation'}>
              {t(lang, '解析 (Explanation):', 'Explanation:')}
            </Text>
          </Box>
          <TextInput
            value={editExplanation}
            onChange={setEditExplanation}
            onCancel={() => setOverlay('none')}
            multiline
            height={5}
            width={modalContentWidth(72) - 4}
            isActive={isActive && editField === 'explanation'}
          />
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
            `确定从草稿移除第 ${cardIndex + 1} 题「${truncateDisplay(String(selectedCard.prompt || '').replace(/\s+/g, ' '), 48, ell)}」吗？`,
            `Remove card #${cardIndex + 1} "${truncateDisplay(String(selectedCard.prompt || '').replace(/\s+/g, ' '), 48, ell)}" from this draft?`,
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
                    const foundIdx = draft.cards.findIndex((c) => c.id === item.cardId);
                    const fallbackIdx = Number.isInteger(item.n)
                      ? Math.max(0, Math.min(draft.cards.length - 1, item.n - 1))
                      : 0;
                    setCardIndex(foundIdx >= 0 ? foundIdx : fallbackIdx);
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
