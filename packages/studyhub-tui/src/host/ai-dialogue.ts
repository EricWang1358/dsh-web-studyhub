/**
 * Unified AI dialogue, prompt-building, retell evaluation, and Q&A persistence core (#1354 P3-a).
 *
 * Shared across all four AI study entrypoints:
 * - Explain (`AiHelpDrawer`, `review-helpers`)
 * - Follow-up (`NextStepFollowupBar`)
 * - Guided Study (`TeachModal`, `AssistantPanel`)
 * - Feynman Retell (`RetellModal`, `AssistantPanel`)
 *
 * Zero React / `marked` dependencies so every lazy chunk can import it cleanly.
 */
import type { HostClient, UiLanguage } from '../types/contracts.js';
import { tryAction } from './sample-actions.js';

export type UnifiedAiMode = 'explain' | 'plain_explain' | 'followup' | 'guided' | 'assistant' | 'reader_page' | 'companion';

export type AiConversationStatus = 'idle' | 'streaming' | 'done' | 'error' | 'aborted';

export interface DialogueTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Append a turn and cap conversation history cleanly to `maxTurns`. */
export function appendCappedTurns<T extends DialogueTurn>(
  turns: readonly T[],
  next: T,
  maxTurns = 20,
): T[] {
  const cap = Math.max(1, Math.floor(maxTurns));
  return [...turns, next].slice(-cap);
}

/**
 * Compute a stable conversation scope key from an entity id + optional content digest (#1354 D7).
 * Ensures cached Q&A history stays isolated if a card's prompt or page text is edited.
 */
export function buildConversationScopeKey(entityId: string, content?: string): string {
  const id = String(entityId || '').trim();
  const normalized = typeof content === 'string' ? content.trim().replace(/\s+/g, ' ') : '';
  if (!normalized) return id;
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${id}#${(hash >>> 0).toString(36)}`;
}

export interface UnifiedRetellVerdict {
  passed: boolean;
  right: string[];
  missed: string[];
  wrong: string[];
  cite: number | null;
  gap: 'none' | 'missed' | 'wrong';
  record?: {
    tries?: number;
    passes?: number;
    gap?: string;
    at?: string;
  };
}

const MODEL_UNAVAILABLE_RE =
  /configure a model|model.*unavailable|no.*model|api.?key|unauthorized|forbidden|\b401\b|\b403\b|econnrefused|timed out|timeout|未配置|可用.*模型|模型不可用/i;

/** Canonical model-availability error classifier shared across TeachModal, RetellModal, and AssistantPanel. */
export function isModelUnavailableError(message: string): boolean {
  return MODEL_UNAVAILABLE_RE.test(message);
}

/** Single reveal-gate check: never expose reference answers or official solutions before reveal/feedback. */
export function canExposeReferenceAnswer(run: { revealed?: unknown; feedback?: unknown } | null | undefined): boolean {
  return Boolean(run?.revealed || run?.feedback);
}

/** Single canonical system prompt generator for explain / plain_explain / followup / guided / assistant. */
export function buildUnifiedAiSystemPrompt(
  mode: UnifiedAiMode,
  lang: UiLanguage,
  opts?: { stageLabel?: string },
): string {
  if (lang === 'en') {
    switch (mode) {
      case 'explain':
        return 'You are a concise, insightful study tutor inside a terminal flashcard/quiz app. Explain concepts clearly using structured bullet points and standard Markdown/LaTeX math ($...$ or $$...$$). Focus on why the answer is right, why common traps are wrong, and intuitive mental models.';
      case 'plain_explain':
        return 'You are the StudyHub study tutor. Give a plain, everyday-analogy explanation of this question in under 150 words; go straight to the point without repeating the user prompt.';
      case 'followup':
        return 'You are StudyHub AI Tutor. The user just viewed an AI study tool output for a flashcard/question and is giving a follow-up instruction. Use the provided question, user answer, and tool output directly as context without asking them to paste anything again. Be concise, accurate, and directly fulfill the instruction.';
      case 'guided':
        return `You are StudyHub Guided Study Tutor (current stage: ${opts?.stageLabel || 'Guided'}). Reply in concise sentences focusing on one point at a time; never repeat the user prompt.`;
      case 'reader_page':
        return 'You are the StudyHub reading tutor. Answer based strictly on the provided page text; clearly mark any general background knowledge. Output concise Markdown.';
      case 'companion':
        return 'You are the StudyHub companion tutor. Answer the learner question concisely in Markdown and LaTeX using the interactive companion context.';
      case 'assistant':
      default:
        return 'You are the StudyHub TUI assistant. Reply concisely; never repeat the user prompt.';
    }
  }
  switch (mode) {
    case 'explain':
      return '你是终端学习助手里的专业助教。请用简洁清晰的中文（支持 Markdown 与 LaTeX 数学公式 $...$ / $$...$$）为学生讲解当前题目：点明核心概念、解题思路、易错点辨析与直觉记忆法。';
    case 'plain_explain':
      return '你是 StudyHub 学习助手。用大白话+生活类比为当前题写通俗讲解，180字内，直接给干货，不要复述用户原话。';
    case 'followup':
      return '你是 StudyHub 学习助教。用户刚刚查看了某道题的 AI 工具结果，现在直接下达后续指令。请直接基于提供的题目、用户作答和本次工具输出作答，不要让用户重复粘贴内容；回答清晰、准确、直奔主题。';
    case 'guided':
      return `你是 StudyHub 带学导师，当前阶段「${opts?.stageLabel || '带学'}」。中文短句，一次聚焦一个点，不复述用户原话。`;
    case 'reader_page':
      return '你是 StudyHub 阅读助教。请严格基于提供的当前页面内容回答用户问题；如需补充通用背景，请明确标注。使用简洁 Markdown 输出。';
    case 'companion':
      return '你是 StudyHub 伴学导师。请基于伴学课内容与结构简洁回答学习者的困惑，使用 Markdown 与 LaTeX 数学公式。';
    case 'assistant':
    default:
      return '你是 StudyHub 学习助手，中文短句直接给答案或步骤，不复述用户原话。';
  }
}

/** Reveal-aware default opening prompt for AI Help / Explain. */
export function buildInitialExplainPrompt(revealed: boolean, lang: UiLanguage): string {
  if (lang === 'en') {
    return revealed
      ? 'Explain the core concept, solution reasoning, and common pitfalls for this question.'
      : 'Give me a conceptual hint and approach without spoiling the final answer yet.';
  }
  return revealed
    ? '请帮我深入讲解这道题的考点、解题思路和容易混淆的误区。'
    : '请先给我一点解题启发和思路提示，先不要直接剧透最终选项或答案。';
}

export interface CardDialoguePromptParams {
  kindLabel: string;
  topic?: string;
  prompt: string;
  options?: readonly string[];
  userAnswer?: string;
  revealed: boolean;
  referenceAnswer?: string;
  explanation?: string;
  misconception?: string;
  toolLabel?: string;
  toolOutput?: string;
  history: readonly DialogueTurn[];
  maxHistoryTurns?: number;
  question: string;
  lang: UiLanguage;
}

/**
 * Single canonical card-context user prompt builder shared by `explain` (`AiHelpDrawer`)
 * and `followup` (`NextStepFollowupBar`). Enforces the pre-reveal answer guard in one place.
 */
export function buildCardDialogueUserPrompt(params: CardDialoguePromptParams): string {
  const {
    kindLabel,
    topic,
    prompt,
    options,
    userAnswer,
    revealed,
    referenceAnswer,
    explanation,
    misconception,
    toolLabel,
    toolOutput,
    history,
    maxHistoryTurns = 12,
    question,
    lang,
  } = params;
  const en = lang === 'en';
  const lines: string[] = [];

  const topicSuffix = topic ? (en ? ` | Topic: ${topic}` : ` | 知识点: ${topic}`) : '';
  lines.push(`${en ? 'Question Type' : '题目类型'}: ${kindLabel}${topicSuffix}`);
  if (prompt) lines.push(`${en ? 'Question' : '题干'}:\n${prompt}`);
  if (options && options.length > 0) {
    lines.push(`${en ? 'Options' : '选项'}:\n${options.map((text, i) => `${i + 1}. ${text}`).join('\n')}`);
  }
  if (userAnswer && userAnswer.trim()) {
    lines.push(`${en ? 'User Answer' : '学生作答'}: ${userAnswer.trim()}`);
  }
  if (revealed) {
    if (referenceAnswer && referenceAnswer.trim()) {
      lines.push(`${en ? 'Reference Answer' : '参考答案'}: ${referenceAnswer.trim()}`);
    }
    if (explanation && explanation.trim()) {
      lines.push(`${en ? 'Explanation' : '原解析'}: ${explanation.trim()}`);
    }
    if (misconception && misconception.trim()) {
      lines.push(`${en ? 'Common Misconception' : '常见误区'}: ${misconception.trim()}`);
    }
  }
  if (toolOutput && toolOutput.trim()) {
    const label = toolLabel || (en ? 'Tool' : '工具');
    lines.push(
      en
        ? `Previous AI Tool Output (${label}):\n${toolOutput.trim().slice(0, 6000)}`
        : `本次 AI 工具输出（${label}）：\n${toolOutput.trim().slice(0, 6000)}`,
    );
  }
  if (history.length > 0) {
    const recent = history.slice(-maxHistoryTurns);
    lines.push(en ? 'Prior Conversation:' : '此前对话:');
    for (const turn of recent) {
      const who = turn.role === 'user' ? (en ? 'Student' : '学生') : en ? 'Tutor' : '助教';
      lines.push(`${who}: ${turn.text}`);
    }
  }
  lines.push(`${en ? 'Current Question / Instruction' : '当前问题 / 指令'}:\n${question}`);
  return lines.join('\n\n');
}

/** Canonical page-reading Q&A user prompt builder for `DocumentReader` (#1354 D7). */
export function buildReaderPageUserPrompt(params: {
  title: string;
  page: number;
  lastPage: number;
  pageText: string;
  question: string;
  history?: readonly DialogueTurn[];
  maxChars?: number;
  lang: UiLanguage;
}): string {
  const { title, page, lastPage, pageText, question, history, maxChars = 14000, lang } = params;
  const en = lang === 'en';
  const lines: string[] = [
    `Document: ${title} (Page ${page}/${lastPage})`,
    `--- PAGE TEXT ---\n${pageText.slice(0, maxChars)}\n--- END ---`,
  ];
  if (history && history.length > 0) {
    lines.push(en ? 'Prior Conversation:' : '此前对话:');
    for (const turn of history.slice(-8)) {
      lines.push(`${turn.role === 'user' ? (en ? 'Student' : '学生') : en ? 'Tutor' : '助教'}: ${turn.text}`);
    }
  }
  lines.push(`${en ? 'Question' : '问题'}: ${question}`);
  return lines.join('\n\n');
}

/** Canonical interactive companion Q&A user prompt builder for `CompanionsModal` (#1354 D7). */
export function buildCompanionUserPrompt(params: {
  title: string;
  summaryContext: string;
  question: string;
  history?: readonly DialogueTurn[];
  lang: UiLanguage;
}): string {
  const { title, summaryContext, question, history, lang } = params;
  const en = lang === 'en';
  const lines: string[] = [`Companion: ${title}`];
  if (summaryContext.trim()) lines.push(summaryContext.trim());
  if (history && history.length > 0) {
    lines.push(en ? 'Prior Conversation:' : '此前对话:');
    for (const turn of history.slice(-8)) {
      lines.push(`${turn.role === 'user' ? (en ? 'Student' : '学生') : en ? 'Tutor' : '助教'}: ${turn.text}`);
    }
  }
  lines.push(`${en ? 'Learner Question' : '学习者问题'}: ${question}`);
  return lines.join('\n\n');
}

/** Canonical assistant-panel user prompt builder for `AssistantPanel` (#1354 D7). */
export function buildAssistantTurnUserPrompt(params: {
  cardPrompt?: string;
  userAnswer?: string;
  history?: ReadonlyArray<{ role: string; text: string }>;
  question: string;
  maxHistoryTurns?: number;
  maxTurnChars?: number;
  lang: UiLanguage;
}): string {
  const {
    cardPrompt,
    userAnswer,
    history,
    question,
    maxHistoryTurns = 6,
    maxTurnChars = 300,
    lang,
  } = params;
  const en = lang === 'en';
  const recent =
    history && history.length > 0
      ? history
          .slice(-maxHistoryTurns)
          .map((x) => `${x.role}: ${x.text.slice(0, maxTurnChars)}`)
          .join('\n')
      : '';
  return [
    cardPrompt ? `${en ? 'Current Question' : '当前题目'}：${cardPrompt}` : '',
    userAnswer ? `${en ? 'My Answer' : '我的作答'}：${userAnswer}` : '',
    recent ? `${en ? 'Recent Context' : '近期上下文'}：\n${recent}` : '',
    `${en ? 'Instruction' : '指令'}：${question}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface PersistCardQaParams {
  host: HostClient;
  deckId: string;
  cardId: string;
  question: string;
  answer: string;
  noteTitle: string;
  lang: UiLanguage;
}

export interface PersistCardQaResult {
  ok: boolean;
  followupId?: string;
  noteSaved: boolean;
  savedItem?: { id: string; question: string; answer: string; at: string };
  warning?: string;
  error?: string;
}

/**
 * Unified two-step Q&A persistence (`card.followup.add` with `replace: true` -> `note.qa.add` with `title`).
 * Guarantees identical deduplication, note-title contract, and truthful partial-failure reporting
 * across both `AiHelpDrawer` and `NextStepFollowupBar`.
 */
export async function persistCardQaToFollowupAndNote(params: PersistCardQaParams): Promise<PersistCardQaResult> {
  const { host, deckId, cardId, noteTitle, lang } = params;
  const question = params.question.slice(0, 1000);
  const answer = params.answer.slice(0, 8000);

  const followupRes = await tryAction<{ item?: { id?: string } }>(host, 'card.followup.add', {
    deckId,
    cardId,
    question,
    answer,
    source: 'assistant',
    silent: true,
    replace: true,
  });
  if (!followupRes.ok || !followupRes.value?.item?.id) {
    return {
      ok: false,
      noteSaved: false,
      error: followupRes.error?.message || (lang === 'en' ? 'Failed to save follow-up' : '保存追问失败'),
    };
  }

  const followupId = followupRes.value.item.id;
  const savedItem = { id: followupId, question, answer, at: new Date().toISOString() };

  const noteRes = await tryAction<{ status?: string }>(host, 'note.qa.add', {
    deckId,
    cardId,
    followupId,
    title: noteTitle,
    language: lang,
  });
  if (!noteRes.ok) {
    const reason = noteRes.error?.message || (lang === 'en' ? 'Failed to add Q&A to study notes' : '写入学习笔记失败');
    return {
      ok: true,
      followupId,
      noteSaved: false,
      savedItem,
      warning:
        lang === 'en'
          ? `Saved to question explanations (reused next time), but adding to notes failed: ${reason}`
          : `已保存到本题讲解（下次可直接复用），但写入学习笔记失败：${reason}`,
    };
  }

  return { ok: true, followupId, noteSaved: true, savedItem };
}

/** Unified Feynman retell submission via backend `teach.retell`, shared by RetellModal and AssistantPanel. */
export async function submitRetellEvaluation(
  host: HostClient,
  params: { deckId: string; cardId: string; text: string; language: UiLanguage },
): Promise<{ ok: true; verdict: UnifiedRetellVerdict } | { ok: false; error: string; isModelError: boolean }> {
  const res = await tryAction<Partial<UnifiedRetellVerdict>>(host, 'teach.retell', {
    deckId: params.deckId,
    cardId: params.cardId,
    text: params.text,
    language: params.language,
  });
  if (!res.ok || !res.value) {
    const err = res.error?.message || '';
    return {
      ok: false,
      error: err || (params.language === 'en' ? 'Feynman retell check failed' : '费曼复述评估失败'),
      isModelError: !err || isModelUnavailableError(err),
    };
  }
  const v = res.value;
  const gap: UnifiedRetellVerdict['gap'] =
    v.gap === 'wrong' || v.gap === 'missed' || v.gap === 'none'
      ? v.gap
      : Array.isArray(v.wrong) && v.wrong.length > 0
        ? 'wrong'
        : Array.isArray(v.missed) && v.missed.length > 0
          ? 'missed'
          : 'none';
  return {
    ok: true,
    verdict: {
      passed: Boolean(v.passed),
      right: Array.isArray(v.right) ? v.right : [],
      missed: Array.isArray(v.missed) ? v.missed : [],
      wrong: Array.isArray(v.wrong) ? v.wrong : [],
      cite: typeof v.cite === 'number' ? v.cite : null,
      gap,
      ...(v.record ? { record: v.record } : {}),
    },
  };
}

/** Format a Feynman retell verdict into concise lines for AssistantPanel / text views. */
export function formatRetellVerdictLines(verdict: UnifiedRetellVerdict, lang: UiLanguage): string[] {
  const en = lang === 'en';
  return [
    verdict.passed ? (en ? 'Retell passed.' : '复述通过。') : en ? 'Needs review.' : '复述待补强。',
    ...(verdict.right.length > 0 ? [`${en ? 'Right: ' : '讲对了：'}${verdict.right.join(en ? '; ' : '；')}`] : []),
    ...(verdict.missed.length > 0 ? [`${en ? 'Missed: ' : '漏掉了：'}${verdict.missed.join(en ? '; ' : '；')}`] : []),
    ...(verdict.wrong.length > 0 ? [`${en ? 'Wrong: ' : '讲错了：'}${verdict.wrong.join(en ? '; ' : '；')}`] : []),
  ];
}
