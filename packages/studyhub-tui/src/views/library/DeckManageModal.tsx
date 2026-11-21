import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import {
  Badge,
  MarkdownView,
  Modal,
  Spinner,
  TextInput,
  VirtualList,
  modalContentWidth,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { padDisplay, truncateDisplay } from '../../render/index.js';
import { startReview, tryAction } from '../../host/index.js';

export interface DeckCardItem {
  id: string;
  kind?: string;
  topic?: string;
  prompt?: string;
  answer?: string;
  options?: Array<{ id: string; text: string; correct?: boolean }>;
  cloze?: { text?: string; answers?: Array<{ id: string; value: string }> };
  explanation?: string;
  flag?: string;
  suspended?: boolean;
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

type ModalMode = 'browse' | 'search' | 'rename';

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

function summarizeCardMarkdown(card: DeckCardItem, lang: 'zh' | 'en'): string {
  const parts: string[] = [];
  if (card.topic) parts.push(`**${t(lang, '主题', 'Topic')}:** ${card.topic}`);
  parts.push(card.prompt || card.cloze?.text || t(lang, '(无题干)', '(No prompt)'));

  if (Array.isArray(card.options) && card.options.length > 0) {
    parts.push('');
    for (const opt of card.options) {
      parts.push(`- ${opt.correct ? '✓' : '○'} ${opt.text}`);
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
    parts.push(`> ⚑ ${t(lang, '标记', 'Flagged')}: ${card.flag}`);
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

  const handleRenameSubmit = useCallback(
    async (raw: string) => {
      const nextTitle = raw.trim();
      if (!deck || !nextTitle || nextTitle === deck.title) {
        setMode('browse');
        return;
      }
      setBusy(true);
      const editRes = await tryAction<Record<string, unknown>>(host, 'deck.edit', { id: deck.id });
      if (!editRes.ok || !editRes.value) {
        setBusy(false);
        setMode('browse');
        notify(editRes.error?.message || t(lang, '无法创建编辑草稿', 'Could not create edit draft'), 'error');
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

  useInput(
    (input) => {
      if (mode !== 'browse' || loading || busy || !deck) return;
      if (input === '/' || input === 'f') {
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
      }
    },
    { isActive: isActive && mode === 'browse' && !loading && !busy },
  );

  const frameW = Math.max(48, Math.min(100, width - 4));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const inputRows = mode === 'browse' ? 0 : 3;
  const bodyH = Math.max(6, frameH - 6 - inputRows);
  const listH = Math.max(4, Math.floor(bodyH * 0.52));
  const previewH = Math.max(3, bodyH - listH - 1);

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
          : [
              { key: 'Enter', label: t(lang, '练此题', 'Practice Card') },
              { key: 'p', label: t(lang, '练整组', 'Practice Deck') },
              { key: '/', label: t(lang, '搜索', 'Search') },
              { key: 'n', label: t(lang, '重命名', 'Rename') },
              { key: 'e', label: t(lang, '草稿编辑', 'Edit Draft') },
              { key: 'Esc', label: t(lang, '关闭', 'Close') },
            ],
    [mode, lang],
  );

  const renderCardRow = useCallback(
    (card: DeckCardItem, ctx: VirtualListRenderContext) => {
      const num = `${String(ctx.index + 1).padStart(2, ' ')}.`;
      const kind = `[${kindLabel(card.kind, lang)}]`;
      const flag = card.flag ? ' ⚑' : '';
      const susp = card.suspended ? ' [⏸]' : '';
      const topic = card.topic ? `${truncateDisplay(card.topic, 14)} · ` : '';
      const prefix = `${num} ${kind} `;
      const tail = `${flag}${susp}`;
      const avail = Math.max(6, ctx.width - prefix.length - tail.length);
      const stem = `${topic}${String(card.prompt || card.cloze?.text || '').replace(/\s+/g, ' ')}`;
      const line = padDisplay(truncateDisplay(stem, avail), avail);
      const fg = ctx.selected ? theme.selectionFg : card.suspended ? theme.dim : theme.text;
      return (
        <Text color={fg} bold={ctx.selected}>
          <Text color={ctx.selected ? theme.selectionFg : theme.muted}>{num} </Text>
          <Text color={ctx.selected ? theme.selectionFg : theme.accent}>{kind} </Text>
          {line}
          {flag ? <Text color={ctx.selected ? theme.selectionFg : theme.warning}>{flag}</Text> : null}
          {susp ? <Text color={theme.dim}>{susp}</Text> : null}
        </Text>
      );
    },
    [lang, theme],
  );

  const previewMarkdown = useMemo(
    () => (selectedCard ? summarizeCardMarkdown(selectedCard, lang) : ''),
    [selectedCard, lang],
  );

  return (
    <Modal
      title={deck?.title ? `${t(lang, '题组管理', 'Manage Deck')}: ${deck.title}` : t(lang, '题组管理', 'Manage Deck')}
      icon="▤"
      subtitle={
        deck
          ? `${filteredCards.length}/${deck.cards.length} ${t(lang, '题', 'cards')}`
          : undefined
      }
      width={frameW}
      height={frameH}
      onClose={mode === 'browse' ? onClose : () => setMode('browse')}
      isActive={isActive && mode === 'browse'}
      hints={hints}
    >
      {mode === 'search' ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color={theme.accent}>{t(lang, '搜索题目 (题干 / 知识点 / 题型):', 'Filter cards:')}</Text>
          <Box borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
            <TextInput
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={() => setMode('browse')}
              onCancel={() => setMode('browse')}
              isActive={isActive && mode === 'search'}
              width={Math.max(12, innerW - 6)}
              placeholder={t(lang, '输入关键字…', 'Type keyword…')}
            />
          </Box>
        </Box>
      ) : null}

      {mode === 'rename' ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color={theme.accent}>{t(lang, '输入新题组标题 (通过 deck.edit 保存):', 'New deck title (via deck.edit):')}</Text>
          <Box borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
            <TextInput
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={(val) => {
                void handleRenameSubmit(val);
              }}
              onCancel={() => setMode('browse')}
              isActive={isActive && mode === 'rename' && !busy}
              width={Math.max(12, innerW - 6)}
              placeholder={t(lang, '输入题组名称…', 'Deck title…')}
            />
          </Box>
        </Box>
      ) : null}

      {searchQuery && mode === 'browse' ? (
        <Box height={1} flexDirection="row" gap={1} flexShrink={0}>
          <Badge label={`${t(lang, '筛选', 'Filter')}: ${searchQuery}`} tone="info" variant="soft" />
          <Text color={theme.dim}>{t(lang, '([c] 清除)', '([c] clear)')}</Text>
        </Box>
      ) : null}

      {loading ? (
        <Box height={bodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在读取题组卡片…', 'Loading deck cards…')} active={isActive} />
        </Box>
      ) : error ? (
        <Box height={bodyH} flexDirection="column" paddingY={1}>
          <Text color={theme.error} bold>{error}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <VirtualList
            items={filteredCards}
            height={searchQuery && mode === 'browse' ? Math.max(3, listH - 1) : listH}
            width={innerW}
            selectedIndex={selectedIndex}
            onChange={(idx) => setSelectedIndex(idx)}
            onSelect={(card) => {
              void handlePracticeCard(card);
            }}
            isActive={isActive && mode === 'browse' && !busy}
            keyExtractor={(c) => c.id}
            renderItem={renderCardRow}
            emptyText={t(lang, '没有匹配的题目', 'No matching cards')}
            emptyHint={searchQuery ? t(lang, '按 [c] 清除筛选', 'Press [c] to clear filter') : undefined}
          />
          <Text color={theme.border}>{'─'.repeat(innerW)}</Text>
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
