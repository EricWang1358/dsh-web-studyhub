import type { HostClient, KeyHint, StudySnapshot } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { tryAction } from '../../host/sample-actions.js';
import { groupSourcesFromSnapshot, type DocumentGroup } from '../sources/source-helpers.js';

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
  slain?: {
    deckId?: string;
    deckTitle?: string;
    suspended?: boolean;
    at?: string;
  };
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

export type ModalMode =
  | 'browse'
  | 'search'
  | 'rename'
  | 'folder'
  | 'course'
  | 'topic'
  | 'link'
  | 'supplement'
  | 'convert';

export const SUPPLEMENT_COUNTS = [3, 5, 10, 15] as const;
export const SUPPLEMENT_KINDS = ['mixed', 'quiz', 'multi', 'truefalse', 'flashcard', 'open', 'cloze'] as const;
export const CONVERT_TARGETS = ['flashcard', 'open', 'truefalse', 'quiz', 'cloze'] as const;
export const CARD_BATCH_MAX = 100;
export const MAX_MULTI_SELECT = 1000;

export type ConvertTargetKind = (typeof CONVERT_TARGETS)[number];

export interface ConvertDraft {
  primaryText: string;
  secondaryText: string;
  tfIsTrue: boolean;
}

export interface SuppJobResult {
  jobId: string;
  status?: string;
  count: number;
  kind: string;
}

/** Split a list into sequential slices no larger than `maxSize` to satisfy backend batch caps. */
export function chunkItems<T>(items: readonly T[], maxSize: number): T[][] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const size = Math.max(1, Math.floor(maxSize));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface BatchSlayResult {
  ok: boolean;
  slain: number;
  partial: boolean;
  error?: string;
}

export async function executeBatchSlay(
  host: HostClient,
  deckId: string,
  targetIds: readonly string[],
  lang: 'zh' | 'en',
): Promise<BatchSlayResult> {
  const chunks = chunkItems(targetIds, CARD_BATCH_MAX);
  let slain = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const res = await tryAction<{ updated?: number; slain?: number }>(host, 'card.review.batch', {
      atomic: true,
      items: chunk.map((cardId) => ({ deckId, cardId, slay: true })),
    });
    if (!res.ok) {
      const baseErr = res.error?.message || t(lang, '批量斩题失败', 'Batch slay failed');
      const error =
        slain > 0
          ? t(
              lang,
              `已斩除 ${slain}/${targetIds.length} 题，第 ${i + 1}/${chunks.length} 批失败：${baseErr}`,
              `Slain ${slain}/${targetIds.length} card(s); batch ${i + 1}/${chunks.length} failed: ${baseErr}`,
            )
          : baseErr;
      return { ok: false, slain, partial: slain > 0, error };
    }
    slain += typeof res.value?.slain === 'number' ? res.value.slain : chunk.length;
  }
  return { ok: true, slain, partial: false };
}

export interface BatchTopicResult {
  ok: boolean;
  updated: number;
  failed: number;
  partial: boolean;
  error?: string;
}

export async function executeBatchTopicUpdate(
  host: HostClient,
  deckId: string,
  targetIds: readonly string[],
  topic: string,
  lang: 'zh' | 'en',
): Promise<BatchTopicResult> {
  const chunks = chunkItems(targetIds, CARD_BATCH_MAX);
  let updated = 0;
  let failed = 0;
  let firstError = '';
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const res = await tryAction<{
      updated?: number;
      failed?: number;
      results?: Array<{ cardId?: string; ok: boolean; error?: string }>;
    }>(host, 'card.update.batch', {
      updates: chunk.map((cardId) => ({
        deckId,
        cardId,
        patch: { topic },
        reason: 'Batch topic retag from TUI',
      })),
    });
    if (!res.ok) {
      const baseErr = res.error?.message || t(lang, '批量修改主题失败', 'Batch topic retag failed');
      const error =
        updated > 0
          ? t(
              lang,
              `已更新 ${updated}/${targetIds.length} 题主题，第 ${i + 1}/${chunks.length} 批失败：${baseErr}`,
              `Retagged ${updated}/${targetIds.length} card(s); batch ${i + 1}/${chunks.length} failed: ${baseErr}`,
            )
          : baseErr;
      return { ok: false, updated, failed, partial: updated > 0, error };
    }
    const chunkUpdated = typeof res.value?.updated === 'number' ? res.value.updated : chunk.length;
    const chunkFailed = typeof res.value?.failed === 'number' ? res.value.failed : 0;
    updated += chunkUpdated;
    failed += chunkFailed;
    if (!firstError && chunkFailed > 0) {
      firstError = res.value?.results?.find((r) => !r.ok && r.error)?.error || '';
    }
  }
  if (updated === 0) {
    return {
      ok: false,
      updated: 0,
      failed,
      partial: false,
      error: firstError || t(lang, '批量修改主题失败', 'Batch topic retag failed'),
    };
  }
  return { ok: true, updated, failed, partial: false };
}

export interface BatchLinkResult {
  ok: boolean;
  linked: number;
  failed: number;
  partial: boolean;
  error?: string;
}

export async function executeBatchLink(
  host: HostClient,
  deckId: string,
  targetIds: readonly string[],
  prereqCardId: string,
  lang: 'zh' | 'en',
): Promise<BatchLinkResult> {
  const links = targetIds
    .filter((id) => id !== prereqCardId)
    .map((cardId) => ({
      deckId,
      cardId,
      requires: { deckId, cardId: prereqCardId },
    }));
  if (links.length === 0) {
    return {
      ok: false,
      linked: 0,
      failed: 0,
      partial: false,
      error: t(lang, '没有可关联的目标题目（不能将题目设为自身前置）', 'No target cards to link (cannot link a card to itself)'),
    };
  }
  const chunks = chunkItems(links, CARD_BATCH_MAX);
  let linked = 0;
  let failed = 0;
  let firstError = '';
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const res = await tryAction<{
      linked?: number;
      failed?: number;
      results?: Array<{ index?: number; cardId?: string; requires?: string; ok: boolean; error?: string }>;
    }>(host, 'card.link.batch', { links: chunk });
    if (!res.ok) {
      const baseErr = res.error?.message || t(lang, '批量关联前置题失败', 'Batch prerequisite linking failed');
      const error =
        linked > 0
          ? t(
              lang,
              `已关联 ${linked}/${links.length} 题，第 ${i + 1}/${chunks.length} 批失败：${baseErr}`,
              `Linked ${linked}/${links.length} card(s); batch ${i + 1}/${chunks.length} failed: ${baseErr}`,
            )
          : baseErr;
      return { ok: false, linked, failed, partial: linked > 0, error };
    }
    const chunkLinked = typeof res.value?.linked === 'number' ? res.value.linked : 0;
    const chunkFailed = typeof res.value?.failed === 'number' ? res.value.failed : 0;
    linked += chunkLinked;
    failed += chunkFailed;
    if (!firstError && chunkFailed > 0) {
      firstError = res.value?.results?.find((r) => !r.ok && r.error)?.error || '';
    }
  }
  if (linked === 0) {
    return {
      ok: false,
      linked: 0,
      failed,
      partial: false,
      error: firstError || t(lang, '批量关联前置题失败', 'Batch prerequisite linking failed'),
    };
  }
  return { ok: true, linked, failed, partial: false };
}

export function kindLabel(kind: string | undefined, lang: 'zh' | 'en'): string {
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

export function supplementKindLabel(kind: string, lang: 'zh' | 'en'): string {
  if (kind === 'mixed') return lang === 'en' ? 'Mixed' : '混合';
  return kindLabel(kind, lang);
}

export function buildDefaultConvertDraft(
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

export function buildConvertPatch(
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

export function summarizeCardMarkdown(card: DeckCardItem, lang: 'zh' | 'en', asciiMode = false): string {
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
  if (card.slain) {
    const origin = card.slain.deckTitle || card.slain.deckId || t(lang, '原题组', 'Original deck');
    parts.push('');
    parts.push(`> ${t(lang, '斩题来源', 'Slain origin')}: ${origin}`);
  }
  return parts.join('\n');
}

export function filterDeckCards(cards: readonly DeckCardItem[], searchQuery: string): DeckCardItem[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return [...cards];
  return cards.filter((c) => {
    const text = `${c.topic ?? ''} ${c.prompt ?? ''} ${c.cloze?.text ?? ''} ${c.kind ?? ''} ${c.id}`.toLowerCase();
    return text.includes(q);
  });
}

export function sortAvailableSupplementDocs(
  snapshot: StudySnapshot | null | undefined,
  deckCourse: string | undefined,
): DocumentGroup[] {
  const docs = groupSourcesFromSnapshot(snapshot).filter((d) => !d.archived);
  const trimmedCourse = deckCourse?.trim();
  if (!trimmedCourse) return docs;
  return [...docs].sort((a, b) => {
    const aMatch = a.courses.includes(trimmedCourse) ? 0 : 1;
    const bMatch = b.courses.includes(trimmedCourse) ? 0 : 1;
    return aMatch - bMatch;
  });
}

export function normalizeFolderInput(raw: string): string {
  return raw
    .split('/')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, 200);
}

export interface DeckManageHintsInput {
  mode: ModalMode;
  lang: 'zh' | 'en';
  suppJobResult: SuppJobResult | null;
  convertEditActive: boolean;
  convertTargetKind: ConvertTargetKind;
  selectedCount: number;
  isSlainDeck: boolean;
  hasSystemKind: boolean;
  hasSlainCard: boolean;
}

export function buildDeckManageHints(input: DeckManageHintsInput): KeyHint[] {
  const {
    mode,
    lang,
    suppJobResult,
    convertEditActive,
    convertTargetKind,
    selectedCount,
    isSlainDeck,
    hasSystemKind,
    hasSlainCard,
  } = input;

  if (mode === 'search') {
    return [
      { key: 'Enter', label: t(lang, '应用筛选', 'Apply') },
      { key: 'Esc', label: t(lang, '返回列表', 'Back') },
    ];
  }
  if (mode === 'rename') {
    return [
      { key: 'Enter', label: t(lang, '保存名称', 'Save') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ];
  }
  if (mode === 'folder') {
    return [
      { key: 'Enter', label: t(lang, '保存目录', 'Save') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ];
  }
  if (mode === 'course') {
    return [
      { key: 'Enter', label: t(lang, '保存课程', 'Save') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ];
  }
  if (mode === 'topic') {
    return [
      { key: 'Enter', label: t(lang, '应用主题', 'Apply') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ];
  }
  if (mode === 'link') {
    return [
      { key: 'j/k', label: t(lang, '移动', 'Move') },
      { key: 'Enter', label: t(lang, '确认关联', 'Link') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ];
  }
  if (mode === 'supplement') {
    return suppJobResult
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
        ];
  }
  if (mode === 'convert') {
    return convertEditActive
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
        ];
  }
  if (selectedCount > 0) {
    return [
      { key: 'Space', label: t(lang, '多选', 'Select') },
      { key: 'F', label: t(lang, '重点', 'Focus') },
      ...(!isSlainDeck ? [{ key: 'S', label: t(lang, '暂停/恢复', 'Suspend') }] : []),
      ...(!hasSystemKind ? [{ key: 'T', label: t(lang, '改主题', 'Topic') }] : []),
      ...(!hasSystemKind ? [{ key: 'L', label: t(lang, '前置', 'Link') }] : []),
      ...(!hasSystemKind ? [{ key: 'X', label: t(lang, '斩题', 'Slay') }] : []),
      { key: 'x', label: t(lang, '清空', 'Clear') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }
  if (isSlainDeck) {
    return [
      { key: 'u', label: t(lang, '恢复原题组', 'Restore') },
      { key: 'Space', label: t(lang, '多选', 'Select') },
      { key: '/', label: t(lang, '搜索', 'Search') },
      { key: 'Esc', label: t(lang, '关闭', 'Close') },
    ];
  }
  return [
    { key: 'Space', label: t(lang, '多选', 'Sel') },
    { key: 'Enter', label: t(lang, '练此题', 'Study') },
    { key: 'p', label: t(lang, '整组', 'Deck') },
    { key: '+', label: t(lang, '补题', 'Add') },
    { key: 'k', label: t(lang, '题型', 'Kind') },
    { key: '/', label: t(lang, '搜索', 'Find') },
    { key: 'n', label: t(lang, '改名', 'Ren') },
    ...(!hasSystemKind ? [{ key: 'C', label: t(lang, '改课程', 'Course') }] : []),
    ...(!hasSystemKind ? [{ key: 'm', label: t(lang, '目录', 'Folder') }] : []),
    ...(hasSlainCard ? [{ key: 'u', label: t(lang, '恢复', 'Restore') }] : []),
    { key: 'e', label: t(lang, '草稿', 'Draft') },
    { key: 'Esc', label: t(lang, '关闭', 'Close') },
  ];
}

export function buildDeckManageModalTitle(
  mode: ModalMode,
  deck: FullDeckDetail | null,
  lang: 'zh' | 'en',
): string {
  if (mode === 'supplement') return `${t(lang, '题组补题', 'Supplement Deck')}: ${deck?.title || ''}`;
  if (mode === 'link') return `${t(lang, '批量关联前置题', 'Batch Link Prerequisite')}: ${deck?.title || ''}`;
  if (mode === 'convert') return t(lang, '转换题型', 'Convert Card Kind');
  if (deck?.title) return `${t(lang, '题组管理', 'Manage Deck')}: ${deck.title}`;
  return t(lang, '题组管理', 'Manage Deck');
}

export function buildDeckManageSubtitle(input: {
  mode: ModalMode;
  lang: 'zh' | 'en';
  suppSelectedCount: number;
  selectedCount: number;
  selectedCard: DeckCardItem | null;
  convertTargetKind: ConvertTargetKind;
  deck: FullDeckDetail | null;
  filteredCount: number;
}): string | undefined {
  const {
    mode,
    lang,
    suppSelectedCount,
    selectedCount,
    selectedCard,
    convertTargetKind,
    deck,
    filteredCount,
  } = input;
  if (mode === 'supplement') return `${suppSelectedCount} ${t(lang, '页已选', 'pg')}`;
  if (mode === 'link') return `${selectedCount} ${t(lang, '题待关联', 'sel')}`;
  if (mode === 'convert' && selectedCard) {
    return `${kindLabel(selectedCard.kind, lang)} -> ${kindLabel(convertTargetKind, lang)}`;
  }
  if (!deck) return undefined;
  const selPart = selectedCount > 0 ? ` · [${t(lang, `已选 ${selectedCount}`, `${selectedCount} sel`)}]` : '';
  return `${filteredCount}/${deck.cards.length} ${t(lang, '题', 'cards')}${selPart}`;
}
