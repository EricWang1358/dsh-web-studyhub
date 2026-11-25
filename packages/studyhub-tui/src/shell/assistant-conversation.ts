/**
 * True multi-turn conversation builder & overflow compressor for the Persistent AI Assistant (#1445).
 *
 * Replaces the legacy 6-turn × 200-char string-concatenation context with:
 * 1. Native `{ role: 'user' | 'assistant', content }[]` multi-turn messages (no 200-char slicing).
 * 2. Fixed card grounding context in the system prompt (prompt, options, learner answer, standard answer,
 *    official explanation, and source citations — hiding answer/explanation during unrevealed exams).
 * 3. Deterministic overflow compression when total message chars exceed `maxChars`, returning an
 *    explicit user-visible `noticeText` so the learner always knows earlier turns were condensed.
 * 4. Shared history extractor so Guided Study Retell (`teach.retell`) sees the exact same session.
 */
import type { ChatMessage, UiLanguage } from '../types/contracts.js';
import type { AssistantCardContext, AssistantTabId } from '../state/store.js';
import { stageLabel, type GuidedStageId } from '../render/clipboard.js';

export const DEFAULT_CONVERSATION_MAX_CHARS = 14_000;
const MIN_VERBATIM_TAIL_MESSAGES = 4;

export interface ConversationTurnLike {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  stage?: GuidedStageId;
  actionSummary?: string;
  isSummary?: boolean;
}

export interface BuildConversationParams {
  turns: readonly ConversationTurnLike[];
  currentUserText: string;
  card?: AssistantCardContext | null;
  tab: AssistantTabId;
  stage: GuidedStageId;
  isPlainExplain: boolean;
  lang: UiLanguage;
  maxChars?: number;
}

export interface BuiltConversationRequest {
  system: string;
  messages: ChatMessage[];
  /** Full-fidelity single-prompt rendering for CLI adapters or test stubs that only read `(system, prompt)`. */
  fallbackPrompt: string;
  compressed: boolean;
  compressedCount: number;
  noticeText?: string;
}

function buildCardGroundingBlock(card: AssistantCardContext | null | undefined, lang: UiLanguage): string {
  if (!card) return '';
  const hideSolution = Boolean(card.isExam && !card.revealed);
  const lines: string[] = [];

  if (lang === 'en') {
    if (card.topic) lines.push(`Topic: ${card.topic}`);
    if (card.prompt) lines.push(`Question: ${card.prompt}`);
    if (Array.isArray(card.options) && card.options.length > 0) {
      lines.push(
        'Options:\n' +
          card.options
            .map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o.text}`)
            .join('\n'),
      );
    }
    if (card.userAnswer) lines.push(`Learner Answer: ${card.userAnswer}`);
    if (!hideSolution) {
      if (card.answer) lines.push(`Standard Answer: ${card.answer}`);
      if (card.explanation) lines.push(`Official Explanation: ${card.explanation}`);
    }
    if (Array.isArray(card.citations) && card.citations.length > 0) {
      const refs = card.citations
        .map((c) => {
          const title = c.sourceTitle || c.sourceId || 'Source';
          const pg = typeof c.pageNumber === 'number' ? ` p.${c.pageNumber}` : '';
          const quote = c.quote ? ` — "${c.quote.slice(0, 160)}"` : '';
          return `- ${title}${pg}${quote}`;
        })
        .join('\n');
      lines.push(`Citations:\n${refs}`);
    }
  } else {
    if (card.topic) lines.push(`考点主题：${card.topic}`);
    if (card.prompt) lines.push(`当前题目：${card.prompt}`);
    if (Array.isArray(card.options) && card.options.length > 0) {
      lines.push(
        '题目选项：\n' +
          card.options
            .map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o.text}`)
            .join('\n'),
      );
    }
    if (card.userAnswer) lines.push(`我的作答：${card.userAnswer}`);
    if (!hideSolution) {
      if (card.answer) lines.push(`标准答案：${card.answer}`);
      if (card.explanation) lines.push(`官方解析：${card.explanation}`);
    }
    if (Array.isArray(card.citations) && card.citations.length > 0) {
      const refs = card.citations
        .map((c) => {
          const title = c.sourceTitle || c.sourceId || '资料';
          const pg = typeof c.pageNumber === 'number' ? ` p.${c.pageNumber}` : '';
          const quote = c.quote ? ` — 「${c.quote.slice(0, 160)}」` : '';
          return `- ${title}${pg}${quote}`;
        })
        .join('\n');
      lines.push(`资料出处：\n${refs}`);
    }
  }

  return lines.join('\n');
}

function summarizeEvictedMessages(evicted: readonly ChatMessage[], lang: UiLanguage): string {
  const bullets = evicted.slice(-8).map((msg, idx) => {
    const speaker = msg.role === 'user' ? (lang === 'en' ? 'Learner' : '学习者') : (lang === 'en' ? 'Assistant' : '助手');
    const compact = msg.content.replace(/\s+/g, ' ').trim();
    const snippet = compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
    return `${idx + 1}. ${speaker}: ${snippet}`;
  });
  const header =
    lang === 'en'
      ? `[Compressed summary of ${evicted.length} earlier message(s) in this session]`
      : `[本会话较早 ${evicted.length} 条对话的压缩摘要]`;
  return `${header}\n${bullets.join('\n')}`;
}

/** Extract prior user/assistant messages from the active card session (shared with `teach.retell`). */
export function extractSharedHistoryMessages(
  turns: readonly ConversationTurnLike[],
  maxMessages = 20,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const turn of turns) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    const text = String(turn.text ?? '').trim();
    if (!text) continue;
    out.push({ role: turn.role, content: text });
  }
  return out.length > maxMessages ? out.slice(-maxMessages) : out;
}

/**
 * Build a true multi-turn LLM request (`system` + `messages[]` + `fallbackPrompt`) for the
 * current card session, compressing only when total message chars exceed `maxChars`.
 */
export function buildConversationRequest(params: BuildConversationParams): BuiltConversationRequest {
  const { turns, currentUserText, card, tab, stage, isPlainExplain, lang } = params;
  const maxChars = Math.max(400, params.maxChars ?? DEFAULT_CONVERSATION_MAX_CHARS);

  const baseSystem =
    lang === 'en'
      ? isPlainExplain
        ? 'You are the StudyHub study assistant. Explain the current question in plain everyday language with a concrete analogy (concise, focused).'
        : tab === 'guided'
          ? `You are the StudyHub guided study tutor at stage "${stageLabel(stage, 'en')}". Stay grounded in this multi-turn conversation and the card context; focus on one clear point per turn.`
          : 'You are the StudyHub study assistant. Stay grounded in this multi-turn conversation and the card context. Answer directly and accurately; if asked to quote an earlier reply verbatim, quote it accurately.'
      : isPlainExplain
        ? '你是 StudyHub 学习助手。用大白话+生活类比为当前题写通俗讲解，180字内，直接给干货，紧扣本题答案与解析。'
        : tab === 'guided'
          ? `你是 StudyHub 带学导师，当前阶段「${stageLabel(stage, 'zh')}」。保持多轮会话连贯，紧扣当前题目与解析，每次聚焦一个关键点。`
          : '你是 StudyHub 学习助手。请严格基于本会话的完整多轮对话历史与当前题目上下文回答；如果用户询问你之前的回复原文，请准确引用。回答简洁清晰。';

  const grounding = buildCardGroundingBlock(card, lang);
  const system = grounding
    ? `${baseSystem}\n\n${lang === 'en' ? '--- Fixed Card Context ---' : '--- 固定题目上下文 ---'}\n${grounding}`
    : baseSystem;

  // Assemble full verbatim prior user/assistant turns + current user input
  const rawMessages: ChatMessage[] = [];
  for (const turn of turns) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    const content = String(turn.text ?? '').trim();
    if (!content) continue;
    rawMessages.push({ role: turn.role, content });
  }
  const currentContent = String(currentUserText ?? '').trim();
  if (currentContent) {
    rawMessages.push({ role: 'user', content: currentContent });
  }

  const totalChars = rawMessages.reduce((acc, m) => acc + m.content.length, 0);
  let finalMessages = rawMessages;
  let compressed = false;
  let compressedCount = 0;
  let noticeText: string | undefined;

  if (totalChars > maxChars && rawMessages.length > MIN_VERBATIM_TAIL_MESSAGES + 1) {
    // Keep as many newest messages verbatim as fit within ~75% of maxChars (minimum MIN_VERBATIM_TAIL_MESSAGES)
    const keepBudget = Math.floor(maxChars * 0.75);
    const tail: ChatMessage[] = [];
    let tailChars = 0;
    for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
      const m = rawMessages[i];
      if (tail.length >= MIN_VERBATIM_TAIL_MESSAGES && tailChars + m.content.length > keepBudget) {
        break;
      }
      tail.unshift(m);
      tailChars += m.content.length;
    }
    const evictedCount = rawMessages.length - tail.length;
    if (evictedCount > 0) {
      const evicted = rawMessages.slice(0, evictedCount);
      const summaryMsg: ChatMessage = {
        role: 'user',
        content: summarizeEvictedMessages(evicted, lang),
      };
      finalMessages = [summaryMsg, ...tail];
      compressed = true;
      compressedCount = evictedCount;
      noticeText =
        lang === 'en'
          ? `Context condensed: ${evictedCount} earlier message(s) summarized to fit the conversation window.`
          : `上下文已自动压缩：较早的 ${evictedCount} 条对话已浓缩为摘要以保留窗口空间。`;
    }
  }

  const fallbackPrompt = finalMessages
    .map((m) => `${m.role === 'user' ? (lang === 'en' ? 'User' : '用户') : (lang === 'en' ? 'Assistant' : '助手')}：${m.content}`)
    .join('\n\n');

  return {
    system,
    messages: finalMessages,
    fallbackPrompt,
    compressed,
    compressedCount,
    ...(noticeText ? { noticeText } : {}),
  };
}
