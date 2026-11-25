import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, Spinner } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { Panel } from '../../components/Panel.js';
import { SplitPane, computeSplit } from '../../components/SplitPane.js';
import { LAYOUT_BP } from '../../components/layout-tokens.js';
import { VirtualList, type VirtualListRenderContext } from '../../components/VirtualList.js';
import { displayWidth, truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import type { BookNode, BookOpenResult, BookQaListResult } from './types.js';

export interface BookQaModalProps {
  host: HostClient;
  course: string | null;
  selectedNodeId?: string | null;
  selectedHid?: string | null;
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

interface OutlineQaPlace {
  sourceId?: string;
  start?: number;
  end?: number;
  quote?: string;
  title?: string;
}

interface OutlineQaItem {
  kind: 'card' | 'qa-card' | 'passage' | string;
  question: string;
  answer: string;
  at?: string | null;
  place?: OutlineQaPlace | null;
  prompt?: string;
  followupId?: string;
  id?: string;
}

interface CourseOutlineQaResult {
  status?: 'ok' | 'empty';
  course?: string | null;
  items?: OutlineQaItem[];
  cards?: { total?: number; read?: number; capped?: boolean; limit?: number };
}

interface PinnedQaItem {
  id: string;
  kind: 'answerCard' | 'followup' | 'sectionCard' | 'sectionQaCard' | 'sectionPassage';
  removable: boolean;
  cardId: string;
  followupId?: string;
  title: string;
  sectionLabel: string;
  prompt?: string;
  placeTitle?: string;
  placeQuote?: string;
  markdown: string;
}

function resolveOutlineNode(
  nodes: BookNode[] | undefined,
  selectedNodeId: string | null | undefined,
  selectedHid: string | null | undefined,
): { key: string | null; label: string | null } {
  const walk = (list: BookNode[] | undefined): BookNode | null => {
    for (const node of list ?? []) {
      if (
        (selectedHid && node.hid === selectedHid) ||
        (selectedNodeId && (node.key === selectedNodeId || node.hid === selectedNodeId || node.key === `bk:${selectedNodeId}`))
      ) {
        return node;
      }
      const child = walk(node.children);
      if (child) return child;
    }
    return null;
  };
  const found = walk(nodes);
  if (found) {
    const label = `${found.number ? `${found.number} ` : ''}${found.title}`.trim();
    const key = found.key && found.key.startsWith('bk:') ? found.key : null;
    return { key, label: label || null };
  }
  if (selectedNodeId && selectedNodeId.trim()) {
    const trimmed = selectedNodeId.trim();
    return {
      key: trimmed.startsWith('bk:') ? trimmed : `bk:${trimmed}`,
      label: null,
    };
  }
  return { key: null, label: null };
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

function collectQaItems(
  qaList: BookQaListResult | null,
  bookOpen: BookOpenWithCards | null,
  outlineQaItems: OutlineQaItem[],
  sectionTitle: string | null,
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
  const pinnedFollowupSet = new Set(followupIds);

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
      removable: true,
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
      removable: true,
      cardId,
      followupId: fid,
      title: cleanFollowupTitle(body, lang),
      sectionLabel,
      prompt,
      markdown: body,
    });
  }

  const secLabel = sectionTitle || t(lang, '本节问答', 'Section Q&A');
  outlineQaItems.forEach((entry, idx) => {
    if (entry.kind === 'card' && entry.followupId && pinnedFollowupSet.has(entry.followupId)) {
      return;
    }
    const qText = String(entry.question ?? '').replace(/\s+/g, ' ').trim();
    const aText = String(entry.answer ?? '').trim();
    const mappedKind: PinnedQaItem['kind'] =
      entry.kind === 'passage'
        ? 'sectionPassage'
        : entry.kind === 'qa-card'
          ? 'sectionQaCard'
          : 'sectionCard';
    const fallbackTitle =
      mappedKind === 'sectionPassage'
        ? t(lang, '原文批注问答', 'Passage annotation')
        : mappedKind === 'sectionQaCard'
          ? t(lang, '阅读问答卡', 'Reader Q&A card')
          : t(lang, '关联追问', 'Card follow-up');
    const title = qText || fallbackTitle;
    const mdParts: string[] = [];
    if (qText) mdParts.push(`**${t(lang, '问题', 'Question')}:** ${qText}`);
    if (aText) mdParts.push(aText);
    items.push({
      id: `outline-qa:${entry.kind}:${entry.followupId ?? entry.id ?? idx}`,
      kind: mappedKind,
      removable: false,
      cardId: '',
      followupId: entry.followupId,
      title,
      sectionLabel: secLabel,
      prompt: entry.prompt,
      placeTitle: entry.place?.title,
      placeQuote: entry.place?.quote,
      markdown: mdParts.join('\n\n') || fallbackTitle,
    });
  });

  return items;
}

export const BookQaModal = memo(function BookQaModal({
  host,
  course,
  selectedNodeId,
  selectedHid,
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
  const [outlineQaItems, setOutlineQaItems] = useState<OutlineQaItem[]>([]);
  const [sectionTitle, setSectionTitle] = useState<string | null>(null);
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
    const directKey =
      selectedNodeId && selectedNodeId.trim().startsWith('bk:') ? selectedNodeId.trim() : null;
    const [qaRes, openRes, directOutlineRes] = await Promise.all([
      tryAction<BookQaListResult>(host, 'book.qa.list', courseArgs),
      tryAction<BookOpenWithCards>(host, 'course.book.open', { ...courseArgs, language: lang }),
      directKey
        ? tryAction<CourseOutlineQaResult>(host, 'course.outline.qa', {
            ...courseArgs,
            keys: [directKey],
          })
        : Promise.resolve(null),
    ]);
    if (!mountedRef.current || seq !== seqRef.current) return;
    if (qaRes.ok && qaRes.value) {
      setQaList(qaRes.value);
    } else {
      setQaList(null);
      setError(qaRes.error?.message || t(lang, '读取全书精选问答失败', 'Failed to load pinned Q&As'));
    }
    const nextBookOpen = openRes.ok && openRes.value ? openRes.value : null;
    setBookOpen(nextBookOpen);

    const resolvedNode = resolveOutlineNode(nextBookOpen?.nodes, selectedNodeId, selectedHid);
    setSectionTitle(resolvedNode.label);

    let nextOutlineItems: OutlineQaItem[] = [];
    if (directOutlineRes && directOutlineRes.ok && Array.isArray(directOutlineRes.value?.items)) {
      nextOutlineItems = directOutlineRes.value.items;
    } else if (resolvedNode.key && resolvedNode.key !== directKey) {
      const outlineRes = await tryAction<CourseOutlineQaResult>(host, 'course.outline.qa', {
        ...(nextBookOpen?.course ? { course: nextBookOpen.course } : courseArgs),
        keys: [resolvedNode.key],
      });
      if (!mountedRef.current || seq !== seqRef.current) return;
      if (outlineRes.ok && Array.isArray(outlineRes.value?.items)) {
        nextOutlineItems = outlineRes.value.items;
      }
    }
    setOutlineQaItems(nextOutlineItems);
    setLoading(false);
  }, [host, course, lang, selectedNodeId, selectedHid]);

  useEffect(() => {
    setLoading(true);
    void loadData();
  }, [loadData]);

  const items = useMemo(
    () => collectQaItems(qaList, bookOpen, outlineQaItems, sectionTitle, lang),
    [qaList, bookOpen, outlineQaItems, sectionTitle, lang],
  );

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
  const split = computeSplit(innerW, { leftWidth: 0.4, minLeft: 24, minRight: 30, breakpoint: LAYOUT_BP.SPLIT_MODAL });

  useInput(
    (input, key) => {
      if (loading || busy || confirmTarget) return;
      if (key.tab || (split.narrow && (key.leftArrow || key.rightArrow || input === 'h' || input === 'l'))) {
        if (key.leftArrow || input === 'h') setActivePane('left');
        else if (key.rightArrow || input === 'l') setActivePane('right');
        else setActivePane((p) => (p === 'left' ? 'right' : 'left'));
        return;
      }
      if (input === 'd' && selectedItem?.removable) {
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
  const sectionQaCount = items.filter(
    (it) => it.kind === 'sectionCard' || it.kind === 'sectionQaCard' || it.kind === 'sectionPassage',
  ).length;

  const hints = useMemo<KeyHint[]>(() => {
    const out: KeyHint[] = [];
    if (items.length > 0) {
      out.push({ key: 'Tab', label: t(lang, '切换窗格', 'Pane') });
    }
    if (selectedItem?.removable) {
      out.push({ key: 'd', label: t(lang, '移出全书', 'Remove') });
    }
    out.push({ key: 'r', label: t(lang, '刷新', 'Refresh') });
    out.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return out;
  }, [items.length, selectedItem?.removable, lang]);

  const previewMarkdown = useMemo(() => {
    if (!selectedItem) return '';
    const parts: string[] = [];
    parts.push(`## ${selectedItem.sectionLabel}`);
    if (selectedItem.prompt) {
      const cleanPrompt = selectedItem.prompt.replace(/\s+/g, ' ').trim();
      parts.push(`> **${t(lang, '关联题目', 'Question')}:** ${cleanPrompt}`);
    }
    if (selectedItem.placeTitle || selectedItem.placeQuote) {
      const placeHead = selectedItem.placeTitle ? `**${selectedItem.placeTitle}**` : t(lang, '原文引用', 'Source');
      const placeQuote = selectedItem.placeQuote ? `: ${selectedItem.placeQuote.replace(/\s+/g, ' ').trim()}` : '';
      parts.push(`> ${placeHead}${placeQuote}`);
    }
    parts.push(selectedItem.markdown);
    return parts.join('\n\n');
  }, [selectedItem, lang]);

  const renderRow = useCallback(
    (item: PinnedQaItem, ctx: VirtualListRenderContext) => {
      const tag =
        item.kind === 'answerCard'
          ? t(lang, '[卡]', '[Card]')
          : item.kind === 'followup'
            ? t(lang, '[问]', '[Q&A]')
            : item.kind === 'sectionPassage'
              ? t(lang, '[注]', '[Note]')
              : item.kind === 'sectionQaCard'
                ? t(lang, '[答]', '[QCard]')
                : t(lang, '[节]', '[Sec]');
      const tagW = displayWidth(tag);
      const avail = Math.max(6, ctx.width - tagW - 1);
      const title = truncateDisplay(item.title, avail, ell);
      const tagColor = ctx.selected
        ? theme.selectionFg
        : item.kind === 'answerCard'
          ? theme.accent
          : item.kind === 'followup'
            ? theme.ai
            : theme.info;
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
          <Spinner label={t(lang, `正在读取全书精选与本节问答${ell}`, `Loading pinned & section Q&As${ell}`)} active={isActive} />
        </Box>
      ) : error && !qaList && items.length === 0 ? (
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
              <Badge label={t(lang, `精选追问 ${qaCount}`, `Pinned ${qaCount}`)} tone={qaCount > 0 ? 'ai' : 'muted'} variant="soft" />
              {(sectionQaCount > 0 || selectedNodeId || selectedHid) ? (
                <Badge label={t(lang, `本节问答 ${sectionQaCount}`, `Section ${sectionQaCount}`)} tone={sectionQaCount > 0 ? 'info' : 'muted'} variant="soft" />
              ) : null}
            </Box>
            <Box flexShrink={0}>{busy ? <Spinner label={t(lang, `移出中${ell}`, `Removing${ell}`)} active={isActive} /> : null}</Box>
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
                  '在刷题复习页按 [A] 打开答题卡并加入复习全书，或在阅读器/AI 追问中记录问答。',
                  'Press [A] in Review to pin an Answer Card, or record follow-ups and reader annotations.',
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
                breakpoint={LAYOUT_BP.SPLIT_MODAL}
                activePane={activePane}
                leftLabel={t(lang, '问答列表', 'Q&A Items')}
                rightLabel={t(lang, '内容预览', 'Preview')}
                left={(sz) => (
                  <Panel
                    title={t(lang, '问答条目', 'Q&A')}
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
                    subtitle={selectedItem?.removable ? t(lang, 'd 移出', 'd:Remove') : t(lang, '只读查看', 'Inspect')}
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
