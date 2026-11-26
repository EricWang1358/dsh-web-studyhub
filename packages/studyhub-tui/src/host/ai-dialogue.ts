/**
 * Unified AI dialogue, prompt-building, guided teaching (`teach.*`), retell evaluation (`teach.retell`),
 * and atomic Q&A persistence (`note.qa.save`) core (#1354 P3 / D7).
 *
 * Single owner across every AI study surface in the TUI:
 * - Explain & Follow-up (`AiHelpDrawer`, `review-helpers`, `NextStepFollowupBar`)
 * - Guided Study & Retell (`AssistantPanel`, `RetellModal`)
 * - Material Reader & Companions (`DocumentReader`, `ReaderNotesDrawer`, `CompanionsModal`, `TranslationGlossaryModal`)
 * - Knowledge Skeleton (`SkeletonView`)
 *
 * Zero React / `marked` dependencies so every lazy chunk can import it cleanly.
 */
import type { ChatMessage, HostClient, UiLanguage } from '../types/contracts.js';
import { errorMessage, tryAction } from './sample-actions.js';

export const UNIFIED_AI_MODES = Object.freeze([
  'explain',
  'explain_followup',
  'plain_explain',
  'followup',
  'guided',
  'assistant',
  'reader_ask',
  'companion_ask',
  'glossary_suggest',
  'skeleton_generate',
] as const);

export type UnifiedAiMode = (typeof UNIFIED_AI_MODES)[number];

export interface DialogueTurn {
  role: 'user' | 'assistant';
  text: string;
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

export interface SkippedTeachingStep {
  index: number;
  lesson?: string;
  answer?: string;
}

export interface TeachingSessionView {
  id: string;
  mode: 'understanding' | 'calculation' | string;
  index: number;
  total: number;
  lesson?: string;
  check?: string;
  feedback?: string;
  skippedSteps?: SkippedTeachingStep[];
  masteredCount?: number;
  wrongTries?: number;
  skipped?: boolean;
  skippedAll?: boolean;
  stage?: string;
  assumptions?: string;
  units?: string;
  rounding?: string;
  citations?: Array<{ sourceId?: string; quote?: string }>;
  complete: boolean;
  transfer?: string;
}

const MODEL_UNAVAILABLE_RE =
  /configure a model|model.*unavailable|no.*model|api.?key|unauthorized|forbidden|\b401\b|\b403\b|econnrefused|timed out|timeout|未配置|可用.*模型|模型不可用|没有可用模型|连接模型/i;

/**
 * Backend `teach.*` refusal codes (lib/teaching.js `nonRetryableError`). The TUI classifies by code first,
 * because the message text is localized on the way here; the text patterns remain for callers without a code.
 */
const MODEL_UNAVAILABLE_CODES = new Set(['teaching-no-model', 'retell-no-model']);
const ANSWER_FIRST_CODE = 'teaching-answer-first';
/** The backend session moved past the step the TUI shows (an Esc-dropped reply, or the main chat advanced it). */
const STALE_TEACH_STEP_CODES = new Set(['teaching-step-changed', 'teaching-already-complete']);

/** True when this host can stream a live AI reply (all dialogue entrypoints share this gate). */
export function isAiStreamingAvailable(host: Pick<HostClient, 'streamComplete'> | null | undefined): boolean {
  return typeof host?.streamComplete === 'function';
}

/** One learner-facing copy for "this build/host has no streaming model bridge". */
export function aiStreamUnavailableMessage(lang: UiLanguage): string {
  return lang === 'en'
    ? 'Streaming AI completion is unavailable on this host'
    : '当前 Host 未提供流式 AI 接口';
}

/**
 * One learner-facing error text for every streaming dialogue failure (#1354 P3).
 * Backend messages keep their existing localized mapping; only the empty/unknown case is
 * given a readable fallback instead of leaking `Unknown error`.
 */
export function describeAiDialogueError(error: unknown, lang: UiLanguage): string {
  const raw = errorMessage(error, lang).trim();
  if (!raw || raw === 'Unknown error' || raw === 'null' || raw === 'undefined') {
    return lang === 'en'
      ? 'AI request failed. Check your model settings and try again.'
      : 'AI 请求失败，请检查模型设置后重试。';
  }
  return raw;
}

/** Canonical model-availability error classifier shared across Guided Study, RetellModal, and AssistantPanel. */
export function isModelUnavailableError(message: string, code?: string): boolean {
  return (code !== undefined && MODEL_UNAVAILABLE_CODES.has(code)) || MODEL_UNAVAILABLE_RE.test(message);
}

/** True when backend `teach.start` refused because the learner has not answered the card yet. */
export function needsAnswerFirstError(message: string, code?: string): boolean {
  return code === ANSWER_FIRST_CODE || /answer the original question before guided teaching|请先作答原题/i.test(message);
}

/** True when a `teach.answer` / `teach.skip` refusal means the TUI's step is stale and must be re-read. */
export function isStaleTeachStepError(code: string | undefined): boolean {
  return code !== undefined && STALE_TEACH_STEP_CODES.has(code);
}

/** Single reveal-gate check: never expose reference answers or official solutions before reveal/feedback. */
export function canExposeReferenceAnswer(run: { revealed?: unknown; feedback?: unknown } | null | undefined): boolean {
  return Boolean(run?.revealed || run?.feedback);
}

/**
 * Single canonical system prompt generator for every AI dialogue and generation mode in the TUI (#1354 D7).
 */
export function buildUnifiedAiSystemPrompt(
  mode: UnifiedAiMode,
  lang: UiLanguage,
  opts?: { stageLabel?: string; target?: 'zh' | 'en' },
): string {
  if (mode === 'glossary_suggest') {
    const target = opts?.target ?? lang;
    if (target === 'en') {
      return (
        'You are a domain-accurate terminology translator for study materials. ' +
        'Given a source term and document context, reply with ONLY the single most standard English translation of that term ' +
        '(or keep the original term if conventionally untranslated). No quotes, no numbering, no explanation.'
      );
    }
    return (
      '你是学习资料的专业术语翻译助手。根据文档标题、上下文与已有术语表，为给定术语给出最准确、常用的中文译法' +
      '（若学科惯例保留原文则直接返回原文）。只输出这一个译法本身，不要加引号、编号或任何解释。'
    );
  }

  if (mode === 'skeleton_generate') {
    return [
      'Design a hierarchical knowledge skeleton from the supplied topics and cards.',
      'Return ONLY valid JSON: {title:string, overview:string, nodes:[{id:string, term:string, meaning:string, parent?:string, cards:string[]}], relations:[{from:string, to:string, type:"part-of"|"causes"|"contrasts"|"prerequisite"|"example-of"|"related", note?:string}]}.',
      'Keep 5-20 nodes, depth <= 3, and meaning <= 50 chars.',
    ].join('\n');
  }

  if (lang === 'en') {
    switch (mode) {
      case 'explain':
        return 'You are a concise, insightful study tutor inside a terminal flashcard/quiz app. Explain concepts clearly using structured bullet points and standard Markdown/LaTeX math ($...$ or $$...$$). Focus on why the answer is right, why common traps are wrong, and intuitive mental models.';
      case 'explain_followup':
        return 'You are a follow-up study tutor inside a terminal flashcard/quiz app. Using the prior conversation turns and card context, directly and precisely answer the learner\'s current follow-up question (resolving references like "just now", "that term", or "the previous step") without re-explaining the entire card from scratch. Use concise Markdown and LaTeX math ($...$ or $$...$$).';
      case 'plain_explain':
        return 'You are the StudyHub study assistant. Explain the current question in plain everyday language with a concrete analogy in under 150 words; go straight to the point without repeating the user prompt.';
      case 'followup':
        return 'You are StudyHub AI Tutor. The user just viewed an AI study tool output for a flashcard/question and is giving a follow-up instruction. Use the provided question, user answer, and tool output directly as context without asking them to paste anything again. Be concise, accurate, and directly fulfill the instruction.';
      case 'guided':
        return `You are the StudyHub guided study tutor at stage "${opts?.stageLabel || 'Guided'}". Stay grounded in this multi-turn conversation and the card context; focus on one clear point per turn and never repeat the user prompt.`;
      case 'reader_ask':
        return 'You are the StudyHub terminal tutor. Answer based strictly on the provided page text; clearly mark any general background knowledge. Output concise Markdown.';
      case 'companion_ask':
        return 'You are the StudyHub Interactive Companion tutor. Answer the learner question concisely in Markdown using the companion context.';
      case 'assistant':
      default:
        return 'You are the StudyHub study assistant. Stay grounded in this multi-turn conversation and the card context. Answer directly and accurately; if asked to quote an earlier reply verbatim, quote it accurately.';
    }
  }
  switch (mode) {
    case 'explain':
      return '你是终端学习助手里的专业助教。请用简洁清晰的中文（支持 Markdown 与 LaTeX 数学公式 $...$ / $$...$$）为学生讲解当前题目：点明核心概念、解题思路、易错点辨析与直觉记忆法。';
    case 'explain_followup':
      return '你是终端学习助手里的追问助教。请结合上方对话历史与题目上下文，直接、精准地回答学生当前这个追问（准确理解「刚才」「那个词」「上一步」等指代），不要从头复述整道题或重复已经讲过的内容。请用简洁清晰的中文（支持 Markdown 与 LaTeX 数学公式 $...$ / $$...$$）。';
    case 'plain_explain':
      return '你是 StudyHub 学习助手。用大白话+生活类比为当前题写通俗讲解，180字内，直接给干货，紧扣本题答案与解析，不要复述用户原话。';
    case 'followup':
      return '你是 StudyHub 学习助教。用户刚刚查看了某道题的 AI 工具结果，现在直接下达后续指令。请直接基于提供的题目、用户作答和本次工具输出作答，不要让用户重复粘贴内容；回答清晰、准确、直奔主题。';
    case 'guided':
      return `你是 StudyHub 带学导师，当前阶段「${opts?.stageLabel || '带学'}」。保持多轮会话连贯，紧扣当前题目与解析，每次聚焦一个关键点，不复述用户原话。`;
    case 'reader_ask':
      return '你是 StudyHub 终端助教。请严格基于提供的当前页面内容回答用户问题；如需补充通用背景，请明确标注。使用简洁 Markdown 输出。';
    case 'companion_ask':
      return '你是 StudyHub 交互伴学导师。请基于伴学课内容与结构简洁回答学习者的困惑，使用 Markdown 与 LaTeX 数学公式。';
    case 'assistant':
    default:
      return '你是 StudyHub 学习助手。请严格基于本会话的完整多轮对话历史与当前题目上下文回答；如果用户询问你之前的回复原文，请准确引用。回答简洁清晰。';
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

/** Canonical user prompt builder for Reader page Ask-AI (`DocumentReader`). */
export function buildReaderAskPrompt(params: {
  title: string;
  page: number;
  lastPage: number;
  text: string;
  question: string;
}): string {
  return `Document: ${params.title} (Page ${params.page}/${params.lastPage})\n\n--- PAGE TEXT ---\n${params.text.slice(0, 14000)}\n--- END ---\n\nQuestion: ${params.question}`;
}

/** Canonical user prompt builder for Companion Ask-AI fallback (`CompanionsModal`). */
export function buildCompanionAskPrompt(params: {
  title: string;
  summaryContext: string;
  question: string;
}): string {
  return `Companion: ${params.title}\n\n${params.summaryContext}\n\nLearner Question: ${params.question}`;
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
  noteId?: string;
  noteTitle?: string;
  status?: 'created' | 'added' | 'unchanged' | string;
  savedItem?: { id: string; question: string; answer: string; at: string };
  error?: string;
}

/**
 * Unified atomic Q&A-to-note persistence via backend composite action `note.qa.save` (#1354 D7 / P3).
 *
 * Single backend transaction upserts `card.followups` (`replace: true`) and appends into the study note
 * (with `title` and idempotent deduplication). Zero half-written follow-ups on failure.
 */
export async function persistCardQaToFollowupAndNote(params: PersistCardQaParams): Promise<PersistCardQaResult> {
  const { host, deckId, cardId, noteTitle, lang } = params;
  const question = params.question.replace(/\s+/g, ' ').trim().slice(0, 1000);
  const answer = params.answer.trim().slice(0, 8000);

  const res = await tryAction<{
    item?: { id?: string; question?: string; answer?: string; at?: string };
    status?: string;
    note?: { id?: string; title?: string };
  }>(host, 'note.qa.save', {
    deckId,
    cardId,
    question,
    answer,
    title: noteTitle.slice(0, 180),
    language: lang,
    source: 'assistant',
    silent: true,
    replace: true,
  });

  if (!res.ok || !res.value?.item?.id) {
    return {
      ok: false,
      noteSaved: false,
      error:
        res.error?.message ||
        (lang === 'en' ? 'Failed to save Q&A to study notes' : '保存问答到学习笔记失败'),
    };
  }

  const followupId = res.value.item.id;
  const savedItem = {
    id: followupId,
    question: res.value.item.question || question,
    answer: res.value.item.answer || answer,
    at: res.value.item.at || new Date().toISOString(),
  };

  return {
    ok: true,
    followupId,
    noteSaved: true,
    noteId: res.value.note?.id,
    noteTitle: res.value.note?.title || noteTitle,
    status: res.value.status,
    savedItem,
  };
}

/** Format the active backend `teach.*` step into concise Markdown for Guided Study. */
export function formatTeachStepMarkdown(session: TeachingSessionView, lang: UiLanguage): string {
  const en = lang === 'en';
  const stepNum = Math.min(session.total || 1, (session.index ?? 0) + 1);
  const total = Math.max(1, session.total || 1);
  const stageTag = session.stage ? ` · ${session.stage}` : '';
  const parts: string[] = [
    en ? `### Step ${stepNum}/${total}${stageTag}` : `### 第 ${stepNum}/${total} 步${stageTag}`,
  ];
  if (session.lesson) parts.push(session.lesson);
  const metaLines: string[] = [];
  if (session.assumptions) metaLines.push(`- **${en ? 'Assumptions' : '假设'}**: ${session.assumptions}`);
  if (session.units) metaLines.push(`- **${en ? 'Units' : '单位'}**: ${session.units}`);
  if (session.rounding) metaLines.push(`- **${en ? 'Rounding' : '精度'}**: ${session.rounding}`);
  if (Array.isArray(session.citations) && session.citations.length > 0) {
    const firstQuote = session.citations[0]?.quote?.trim();
    if (firstQuote) metaLines.push(`- **${en ? 'Citation' : '依据'}**: "${firstQuote}"`);
  }
  if (metaLines.length > 0) parts.push(metaLines.join('\n'));
  if (session.check) {
    parts.push(`> **${en ? 'Check' : '检验提问'}**: ${session.check}`);
  }
  return parts.join('\n\n');
}

/** Format backend `teach.*` completion summary & skipped-steps recap. */
export function formatTeachCompletionMarkdown(session: TeachingSessionView, lang: UiLanguage): string {
  const en = lang === 'en';
  const skipped = Array.isArray(session.skippedSteps) ? session.skippedSteps : [];
  const mastered =
    typeof session.masteredCount === 'number'
      ? session.masteredCount
      : Math.max(0, (session.total || 0) - skipped.length);
  const total = Math.max(1, session.total || 1);
  const parts: string[] = [
    en ? '### Teaching Complete · Transfer Rule' : '### 带学完成 · 核心迁移法则',
  ];
  if (session.transfer) parts.push(session.transfer);
  else {
    parts.push(
      en
        ? 'Guided teaching finished. Press [p] to enter Retell, or [F] in Review for Feynman Retell.'
        : '已完成本轮带学，可按 [p] 返回复述阶段，或在刷题页按 [F] 做费曼复述。',
    );
  }
  if (skipped.length > 0) {
    const summaryTitle = en
      ? `#### Skipped Steps (${skipped.length} not counted as mastered; mastered ${mastered}/${total})`
      : `#### 已跳过步骤（${skipped.length} 步未计为已掌握，已掌握 ${mastered}/${total} 步）`;
    const items = skipped.map((item) => {
      const num = (item.index ?? 0) + 1;
      const body = item.lesson ? item.lesson : en ? '(see key point above)' : '（见上方要点）';
      return en ? `- Step ${num}: ${body}` : `- 第 ${num} 步：${body}`;
    });
    parts.push(`${summaryTitle}\n${items.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Load an existing backend `teach.get` session or start a new one via `teach.start` (#1354 P3-c). */
export async function loadTeachSession(
  host: HostClient,
  params: {
    runId: string;
    cardId: string;
    index: number;
    queueVersion?: number;
    mode?: 'understanding' | 'calculation';
    language: UiLanguage;
    existingId?: string;
    existingMode?: string;
  },
): Promise<{ ok: true; session: TeachingSessionView } | { ok: false; error: string; isModelError: boolean; needsAnswerFirst: boolean }> {
  const targetMode = params.mode ?? 'understanding';
  if (params.existingId && (params.existingMode || 'understanding') === targetMode) {
    const existingRes = await getTeachSession(host, { id: params.existingId, language: params.language });
    if (existingRes.ok) return existingRes;
  }
  const startRes = await tryAction<TeachingSessionView>(host, 'teach.start', {
    runId: params.runId,
    cardId: params.cardId,
    index: params.index,
    queueVersion: params.queueVersion ?? 0,
    mode: targetMode,
    language: params.language,
  });
  if (!startRes.ok || !startRes.value?.id) {
    const err =
      startRes.error?.message ||
      (params.language === 'en' ? 'Failed to start guided teaching' : '无法开启苏格拉底带学');
    const code = startRes.error?.code;
    return {
      ok: false,
      error: err,
      isModelError: isModelUnavailableError(err, code),
      needsAnswerFirst: needsAnswerFirstError(err, code),
    };
  }
  return { ok: true, session: startRes.value };
}

/** Read the backend's current `teach.get` view of a session (resume, or resync a stale step). */
export async function getTeachSession(
  host: HostClient,
  params: { id: string; language: UiLanguage },
): Promise<{ ok: true; session: TeachingSessionView } | { ok: false; error: string }> {
  const res = await tryAction<TeachingSessionView>(host, 'teach.get', { id: params.id });
  if (res.ok && res.value?.id) return { ok: true, session: res.value };
  return {
    ok: false,
    error: (!res.ok && res.error?.message) || (params.language === 'en' ? 'Failed to read guided teaching' : '读取带学进度失败'),
  };
}

/** Submit a learner response to the active backend `teach.answer` step (#1354 P3-c). */
export async function submitTeachAnswer(
  host: HostClient,
  params: { id: string; answer: string; stepIndex: number; language: UiLanguage },
): Promise<{ ok: true; session: TeachingSessionView } | { ok: false; error: string; isModelError: boolean; stale: boolean }> {
  const res = await tryAction<TeachingSessionView>(host, 'teach.answer', {
    id: params.id,
    answer: params.answer,
    stepIndex: params.stepIndex,
  });
  if (!res.ok || !res.value) {
    const err =
      res.error?.message ||
      (params.language === 'en' ? 'Failed to submit teaching answer' : '提交带学回答失败');
    const code = res.error?.code;
    return { ok: false, error: err, isModelError: isModelUnavailableError(err, code), stale: isStaleTeachStepError(code) };
  }
  return { ok: true, session: res.value };
}

/** Skip current step (or all remaining steps) via backend `teach.skip` (0 model calls, #1318 / #1354 P3-c). */
export async function skipTeachStep(
  host: HostClient,
  params: { id: string; stepIndex: number; all?: boolean; language: UiLanguage },
): Promise<{ ok: true; session: TeachingSessionView } | { ok: false; error: string; stale: boolean }> {
  const res = await tryAction<TeachingSessionView>(host, 'teach.skip', {
    id: params.id,
    stepIndex: params.stepIndex,
    ...(params.all ? { all: true } : {}),
  });
  if (!res.ok || !res.value) {
    return {
      ok: false,
      error:
        res.error?.message ||
        (params.language === 'en' ? 'Failed to skip teaching step' : '跳过当前步骤失败'),
      stale: isStaleTeachStepError(res.error?.code),
    };
  }
  return { ok: true, session: res.value };
}

/** Unified Feynman retell submission via backend `teach.retell`, shared by RetellModal and AssistantPanel. */
export async function submitRetellEvaluation(
  host: HostClient,
  params: {
    deckId: string;
    cardId: string;
    text: string;
    language: UiLanguage;
    /** Prior assistant turns (#1445): retell evaluation must see the shared session context. */
    conversationHistory?: ChatMessage[];
  },
): Promise<{ ok: true; verdict: UnifiedRetellVerdict } | { ok: false; error: string; isModelError: boolean }> {
  const res = await tryAction<Partial<UnifiedRetellVerdict>>(host, 'teach.retell', {
    deckId: params.deckId,
    cardId: params.cardId,
    text: params.text,
    language: params.language,
    ...(params.conversationHistory && params.conversationHistory.length > 0
      ? { conversationHistory: params.conversationHistory }
      : {}),
  });
  if (!res.ok || !res.value) {
    const err = res.error?.message || '';
    return {
      ok: false,
      error: err || (params.language === 'en' ? 'Feynman retell check failed' : '费曼复述评估失败'),
      isModelError: !err || isModelUnavailableError(err, res.error?.code),
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
