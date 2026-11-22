import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  VirtualList,
  computeSplit,
  modalContentWidth,
  useTheme,
  type VirtualListRenderContext,
} from '../../components/index.js';
import { displayWidth, truncateDisplay } from '../../render/index.js';
import { tryAction } from '../../host/index.js';
import type { BookNode, BookOpenResult, BookQaListResult } from './types.js';

export interface BookQaModalProps {
  host: HostClient;
  course: string | null;
  isActive: boolean;
  width: number;
  height: number;
  onClose: () => void;
  onChanged?: () => void;
}

interface BookAnswerCardMeta {
  deckId: string;
  cardId: string;
  prompt?: string;
  hid?: string;
  questionType?: { id?: string; label?: string };
  concepts?: Array<{ name: string }>;
}

interface BookOpenWithCards extends BookOpenResult {
  answerCards?: BookAnswerCardMeta[];
}

interface PinnedQaItem {
  id: string;
  kind: 'answerCard' | 'followup';
  cardId: string;
  followupId?: string;
  title: string;
  sectionLabel: string;
  prompt?: string;
  markdown: string;
}

const QA_BLOCK_RE = /<!-- sh:qa card=(\S+) fid=(\S+) -->\r?\n((?:(?!<!-- sh:qa )[\s\S])*?)\r?\n<!-- \/sh:qa -->/g;
const CARD_BLOCK_RE = /<!-- sh:card card=(\S+) -->\r?\n((?:(?!<!-- sh:card )[\s\S])*?)\r?\n<!-- \/sh:card -->/g;

function cleanFollowupTitle(rawBody: string, lang: 'zh' | 'en'): string {
  const lines = rawBody
    .split(/\r?\n/)
    .map((l) => l.replace(/^>\s?/, '').trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const cleaned = first
    .replace(/^\*\*(?:追问|Follow-up)[：:]?\*\*\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || t(lang, '追问笔记', 'Follow-up Q&A');
}

function cleanCardTitle(rawBody: string, prompt: string | undefined, lang: 'zh' | 'en'): string {
  if (prompt && prompt.trim()) return prompt.replace(/\s+/g, ' ').trim();
  const lines = rawBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\*\*(?:分析题答案卡|Answer card)\*\*$/i.test(l));
  const first = (lines[0] ?? '').replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim();
  return first || t(lang, '分析题答案卡', 'Answer Card');
}

function collectPinnedItems(
  qaList: BookQaListResult | null,
  bookOpen: BookOpenWithCards | null,
  lang: 'zh' | 'en',
): PinnedQaItem[] {
  const promptByCard = new Map<string, string>();
  for (const ac of bookOpen?.answerCards ?? []) {
    if (ac.cardId && ac.prompt) promptByCard.set(ac.cardId, ac.prompt);
  }

  const parsedFollowups = new Map<string, { cardId: string; body: string; sectionLabel: string }>();
  const parsedCards = new Map<string, { cardId: string; body: string; sectionLabel: string }>();

  const scanText = (text: string | undefined, sectionLabel: string) => {
    if (!text) return;
    for (const m of text.matchAll(QA_BLOCK_RE)) {
      const cardId = m[1];
      const fid = m[2];
      const body = m[3]?.trim() ?? '';
      if (!parsedFollowups.has(fid)) {
        parsedFollowups.set(fid, { cardId, body, sectionLabel });
      }
    }
    for (const m of text.matchAll(CARD_BLOCK_RE)) {
      const cardId = m[1];
      const body = m[2]?.trim() ?? '';
      if (!parsedCards.has(cardId)) {
        parsedCards.set(cardId, { cardId, body, sectionLabel });
      }
    }
  };

  const walkNodes = (nodes: BookNode[] | undefined) => {
    for (const node of nodes ?? []) {
      for (const q of node.questions ?? []) {
        if (q.cardId && q.prompt && !promptByCard.has(q.cardId)) {
          promptByCard.set(q.cardId, q.prompt);
        }
      }
      if (node.qa) {
        const label = `${node.number ? `${node.number} ` : ''}${node.title}`;
        scanText(node.qa, label);
      }
      if (node.children?.length) walkNodes(node.children);
    }
  };

  if (bookOpen?.status === 'ok') {
    walkNodes(bookOpen.nodes);
    if (bookOpen.unplaced?.text) {
      scanText(bookOpen.unplaced.text, bookOpen.unplaced.title || t(lang, '未归位', 'Unplaced'));
    }
  }

  const items: PinnedQaItem[] = [];
  const cardIds = qaList?.answerCardIds ?? [...parsedCards.keys()];
  const followupIds = qaList?.followupIds ?? [...parsedFollowups.keys()];

  for (const cardId of cardIds) {
    const found = parsedCards.get(cardId);
    const prompt = promptByCard.get(cardId);
    const body =
      found?.body ||
      t(
        lang,
        `**分析题答案卡**\n\n> 卡片 ID: \`${cardId}\`（请在对应知识点的复习全书正文查看完整内容）`,
        `**Answer card**\n\n> Card ID: \`${cardId}\``,
      );
    const sectionLabel = found?.sectionLabel || t(lang, '复习全书', 'Review Book');
    items.push({
      id: `card:${cardId}`,
      kind: 'answerCard',
      cardId,
      title: cleanCardTitle(body, prompt, lang),
      sectionLabel,
      prompt,
      markdown: body,
    });
  }

  for (const fid of followupIds) {
    const found = parsedFollowups.get(fid);
    const cardId = found?.cardId ?? '';
    const prompt = cardId ? promptByCard.get(cardId) : undefined;
    const body =
      found?.body ||
      t(
        lang,
        `> **追问 ID：** \`${fid}\``,
        `> **Follow-up ID:** \`${fid}\``,
      );
    const sectionLabel = found?.sectionLabel || t(lang, '复习全书', 'Review Book');
    items.push({
      id: `qa:${fid}`,
      kind: 'followup',
      cardId,
      followupId: fid,
      title: cleanFollowupTitle(body, lang),
      sectionLabel,
      prompt,
      markdown: body,
    });
  }

  return items;
}

export const BookQaModal = memo(function BookQaModal({
  host,
  course,
  isActive,
  width,
  height,
  onClose,
  onChanged,
}: BookQaModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const mathUnicode = useTuiStore((s) => s.preferences.mathUnicode);
  const notify = useTuiStore((s) => s.notify);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qaList, setQaList] = useState<BookQaListResult | null>(null);
  const [bookOpen, setBookOpen] = useState<BookOpenWithCards | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activePane, setActivePane] = useState<'left' | 'right'>('left');
  const [confirmTarget, setConfirmTarget] = useState<PinnedQaItem | null>(null);

  const mountedRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadData = useCallback(async () => {
    const seq = ++seqRef.current;
    setError(null);
    const courseArgs = course !== null && course !== undefined ? { course } : {};
    const [qaRes, openRes] = await Promise.all([
      tryAction<BookQaListResult>(host, 'book.qa.list', courseArgs),
      tryAction<BookOpenWithCards>(host, 'course.book.open', { ...courseArgs, language: lang }),
    ]);
    if (!mountedRef.current || seq !== seqRef.current) return;
    if (qaRes.ok && qaRes.value) {
      setQaList(qaRes.value);
    } else {
      setQaList(null);
      setError(qaRes.error?.message || t(lang, '读取全书精选问答失败', 'Failed to load pinned Q&As'));
    }
    if (openRes.ok && openRes.value) {
      setBookOpen(openRes.value);
    } else {
      setBookOpen(null);
    }
    setLoading(false);
  }, [host, course, lang]);

  useEffect(() => {
    setLoading(true);
    void loadData();
  }, [loadData]);

  const items = useMemo(() => collectPinnedItems(qaList, bookOpen, lang), [qaList, bookOpen, lang]);

  useEffect(() => {
    if (items.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
    } else if (selectedIndex >= items.length) {
      setSelectedIndex(items.length - 1);
    }
  }, [items.length, selectedIndex]);

  const selectedItem = items[selectedIndex] ?? null;
  const effectiveCourse = bookOpen?.course ?? course ?? qaList?.courses?.[0] ?? null;

  const removeSelected = useCallback(
    async (item: PinnedQaItem) => {
      if (busy) return;
      setBusy(true);
      const args: Record<string, unknown> =
        item.kind === 'answerCard'
          ? {
              ...(effectiveCourse !== null ? { course: effectiveCourse } : {}),
              cardId: item.cardId,
              answerCard: true,
            }
          : {
              ...(effectiveCourse !== null ? { course: effectiveCourse } : {}),
              followupId: item.followupId,
            };
      const res = await tryAction<{ status?: string }>(host, 'book.qa.remove', args);
      if (!mountedRef.current) return;
      if (!res.ok) {
        setBusy(false);
        notify(res.error?.message || t(lang, '移出复习全书失败', 'Failed to remove from Review Book'), 'error');
        return;
      }
      await loadData();
      if (!mountedRef.current) return;
      setBusy(false);
      onChanged?.();
      notify(
        item.kind === 'answerCard'
          ? t(lang, '已从复习全书移出该答题卡', 'Removed answer card from Review Book')
          : t(lang, '已从复习全书移出该追问', 'Removed follow-up from Review Book'),
        'success',
      );
    },
    [busy, effectiveCourse, host, lang, loadData, notify, onChanged],
  );

  const frameW = Math.max(46, Math.min(104, width - 2));
  const frameH = Math.max(16, Math.min(34, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);
  const contentH = Math.max(6, bodyH - 2);
  const split = computeSplit(innerW, { leftWidth: 0.4, minLeft: 24, minRight: 30, breakpoint: 66 });

  useInput(
    (input, key) => {
      if (loading || busy || confirmTarget) return;
      if (key.tab || (split.narrow && (key.leftArrow || key.rightArrow || input === 'h' || input === 'l'))) {
        if (key.leftArrow || input === 'h') setActivePane('left');
        else if (key.rightArrow || input === 'l') setActivePane('right');
        else setActivePane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (input === 'd' && selectedItem) {
        setConfirmTarget(selectedItem);
        return;
      }
      if (input === 'r') {
        setLoading(true);
        void loadData();
      }
    },
    { isActive: isActive && !loading && !busy && !confirmTarget },
  );

  const ell = asciiMode ? '...' : '…';
  const cardCount = items.filter((it) => it.kind === 'answerCard').length;
  const qaCount = items.filter((it) => it.kind === 'followup').length;

  const hints = useMemo<KeyHint[]>(() => {
    const out: KeyHint[] = [];
    if (items.length > 0) {
      out.push({ key: 'Tab', label: t(lang, '切换窗格', 'Pane') });
      out.push({ key: 'd', label: t(lang, '移出全书', 'Remove') });
    }
    out.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    out.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return out;
  }, [items.length, lang]);

  const previewMarkdown = useMemo(() => {
    if (!selectedItem) return '';
    const parts: string[] = [];
    parts.push(`## ${selectedItem.sectionLabel}`);
    if (selectedItem.prompt) {
      const cleanPrompt = selectedItem.prompt.replace(/\s+/g, ' ').trim();
      parts.push(`> **${t(lang, '关联题目', 'Question')}:** ${cleanPrompt}`);
    }
    parts.push(selectedItem.markdown);
    return parts.join('\n\n');
  }, [selectedItem, lang]);

  const renderRow = useCallback(
    (item: PinnedQaItem, ctx: VirtualListRenderContext) => {
      const tag = item.kind === 'answerCard' ? t(lang, '[卡]', '[Card]') : t(lang, '[问]', '[Q&A]');
      const tagW = displayWidth(tag);
      const avail = Math.max(6, ctx.width - tagW - 1);
      const title = truncateDisplay(item.title, avail, ell);
      const tagColor = ctx.selected
        ? theme.selectionFg
        : item.kind === 'answerCard'
          ? theme.accent
          : theme.ai;
      return (
        <Text color={ctx.selected ? theme.selectionFg : theme.text} bold={ctx.selected}>
          <Text color={tagColor}>{tag}</Text>
          {` ${title}`}
        </Text>
      );
    },
    [lang, ell, theme],
  );

  return (
    <Modal
      title={t(lang, '全书精选问答与答题卡', 'Book Pinned Q&A & Answer Cards')}
      icon={asciiMode ? '#' : '✎'}
      tone="ai"
      subtitle={effectiveCourse ?? undefined}
      width={frameW}
      height={frameH}
      onClose={confirmTarget ? undefined : onClose}
      isActive={isActive && !confirmTarget}
      hints={hints}
    >
      {loading ? (
        <Box height={bodyH} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, '正在读取全书精选问答与答题卡…', 'Loading pinned Q&As & answer cards…')} active={isActive} />
        </Box>
      ) : error && !qaList ? (
        <EmptyState
          icon={asciiMode ? '!' : '✕'}
          title={t(lang, '无法读取全书精选问答', 'Cannot load pinned Q&As')}
          hint={error}
          actions={[
            { key: 'r', label: t(lang, '重试', 'Retry') },
            { key: 'Esc', label: t(lang, '关闭', 'Close') },
          ]}
          width={innerW}
          height={bodyH}
        />
      ) : (
        <Box flexDirection="column" height={bodyH} overflow="hidden">
          {/* Header summary row (1 row) */}
          <Box height={1} flexDirection="row" justifyContent="space-between" overflow="hidden" flexShrink={0}>
            <Box gap={1} overflow="hidden">
              <Badge label={t(lang, `答题卡 ${cardCount}`, `Cards ${cardCount}`)} tone={cardCount > 0 ? 'accent' : 'muted'} variant="soft" />
              <Badge label={t(lang, `追问 ${qaCount}`, `Q&As ${qaCount}`)} tone={qaCount > 0 ? 'ai' : 'muted'} variant="soft" />
            </Box>
            <Box flexShrink={0}>{busy ? <Spinner label={t(lang, '移出中…', 'Removing…')} active={isActive} /> : null}</Box>
          </Box>

          <Divider width={innerW} />

          {/* Body: EmptyState or SplitPane */}
          {items.length === 0 ? (
            <Box height={contentH} overflow="hidden" flexShrink={0}>
              <EmptyState
                icon={asciiMode ? '#' : '✎'}
                title={t(lang, '当前课程暂无已收录的答题卡或追问', 'No pinned Answer Cards or Q&As yet')}
                hint={t(
                  lang,
                  '在刷题复习页按 [A] 打开答题卡并加入复习全书，或在 AI 追问中将问答加入全书。',
                  'Press [A] in Review to build & pin an Answer Card, or pin an AI follow-up to the Review Book.',
                )}
                width={innerW}
                height={contentH}
              />
            </Box>
          ) : (
            <Box height={contentH} overflow="hidden" flexShrink={0}>
              <SplitPane
                width={innerW}
                height={contentH}
                leftWidth={0.4}
                minLeft={24}
                minRight={30}
                breakpoint={66}
                activePane={activePane}
                leftLabel={t(lang, '精选列表', 'Pinned Items')}
                rightLabel={t(lang, '内容预览', 'Preview')}
                left={(sz) => (
                  <Panel
                    title={t(lang, '已收录条目', 'Pinned')}
                    badge={items.length}
                    focused={activePane === 'left'}
                    width={sz.width}
                    height={sz.height}
                    paddingX={0}
                  >
                    <VirtualList
                      items={items}
                      width={Math.max(10, sz.width - 2)}
                      height={Math.max(3, sz.height - 2)}
                      selectedIndex={selectedIndex}
                      onChange={setSelectedIndex}
                      onSelect={() => setActivePane('right')}
                      isActive={isActive && !confirmTarget && !busy && activePane === 'left'}
                      keyExtractor={(it) => it.id}
                      renderItem={renderRow}
                    />
                  </Panel>
                )}
                right={(sz) => (
                  <Panel
                    title={selectedItem ? truncateDisplay(selectedItem.sectionLabel, Math.max(10, sz.width - 10), ell) : t(lang, '预览', 'Preview')}
                    subtitle={t(lang, 'd 移出', 'd:Remove')}
                    focused={activePane === 'right'}
                    width={sz.width}
                    height={sz.height}
                    paddingX={1}
                  >
                    <MarkdownView
                      markdown={previewMarkdown}
                      width={Math.max(12, sz.width - 4)}
                      height={Math.max(3, sz.height - 2)}
                      isActive={isActive && !confirmTarget && !busy && activePane === 'right'}
                      mathUnicode={mathUnicode}
                      ascii={asciiMode}
                    />
                  </Panel>
                )}
              />
            </Box>
          )}
        </Box>
      )}

      {confirmTarget ? (
        <ConfirmDialog
          title={
            confirmTarget.kind === 'answerCard'
              ? t(lang, '移出分析题答案卡', 'Remove Answer Card')
              : t(lang, '移出追问笔记', 'Remove Follow-up Q&A')
          }
          message={t(
            lang,
            `确定从复习全书移出「${truncateDisplay(confirmTarget.title, 42, ell)}」吗？（原题目和卡片记录仍会保留）`,
            `Remove "${truncateDisplay(confirmTarget.title, 42, ell)}" from Review Book? (The card itself is kept.)`,
          )}
          confirmLabel={t(lang, '移出', 'Remove')}
          cancelLabel={t(lang, '取消', 'Cancel')}
          danger
          isActive={isActive && Boolean(confirmTarget)}
          onConfirm={() => {
            const target = confirmTarget;
            setConfirmTarget(null);
            void removeSelected(target);
          }}
          onCancel={() => setConfirmTarget(null)}
        />
      ) : null}
    </Modal>
  );
});
