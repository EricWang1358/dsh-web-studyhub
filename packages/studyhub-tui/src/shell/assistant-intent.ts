/**
 * Deterministic natural-language intent parser for the Persistent AI Assistant (#1315, #1444).
 *
 * Strict constraints:
 * - Never invents backend actions — maps exclusively to existing `AppShell` navigation and
 *   `tui-host` actions (`snapshot`, `assist.start`, `card.flag`, `review.similar`, etc.).
 * - Every write/quota/export action sets `requiresConfirm: true` so the panel always renders a
 *   P2 `ConfirmDialog` preview before execution.
 * - Unrecognized action-like commands return `unsupported` with honest boundary copy +
 *   actionable shortcut/alternative instead of pretending a chat reply "completed" the task (#1444).
 * - Concise Chinese/English short phrases — never parrots raw user text.
 */
import type { PageId, StudySnapshot, TuiPreferences, UiLanguage } from '../types/contracts.js';
import type { AssistantCardContext } from '../state/store.js';
import type { ErrorReasonId } from '../views/wrongbook/types.js';
import {
  SET_ERROR_REASON_ACTION,
  errorReasonArgs,
  errorReasonFromText,
  errorReasonName,
  type ErrorReasonTarget,
} from './error-reason-intent.js';

export type AssistantWriteActionName =
  | typeof SET_ERROR_REASON_ACTION
  | 'export.wrongbook'
  | 'card.followup.add'
  | 'assist.start'
  | 'note.qa.add'
  | 'card.flag'
  | 'review.grade.adjust'
  | 'review.correction.ack'
  | 'coach.practice'
  | 'review.start'
  | 'card.slay'
  | 'card.suspend'
  | 'card.focus'
  | 'review.undo'
  | 'review.queue.edit';

export type AssistantReadActionName = 'review.similar' | 'card.terms' | 'card.translate' | 'review.move';

export type AssistantIntent =
  | {
      kind: 'navigate';
      page: PageId;
      sourceIndex?: number;
      sourceId?: string;
      pageNumber?: number;
      actionName: string;
      paramsSummary: string;
      requiresConfirm: false;
    }
  | {
      kind: 'set_preference';
      patch: Partial<Pick<TuiPreferences, 'theme' | 'compactMode' | 'proactiveHints'>>;
      actionName: 'preferences.set';
      paramsSummary: string;
      requiresConfirm: false;
    }
  | {
      kind: 'enter_guided';
      stage?: 'question' | 'retell';
      actionName: 'assistant.guided';
      paramsSummary: string;
      requiresConfirm: false;
    }
  | {
      kind: 'readonly_stats';
      actionName: 'snapshot';
      paramsSummary: string;
      requiresConfirm: false;
    }
  | {
      kind: 'run_action';
      actionName: AssistantReadActionName;
      params: Record<string, unknown>;
      humanLabel: string;
      paramsSummary: string;
      requiresConfirm: false;
    }
  | {
      kind: 'generate_plain_explain';
      actionName: 'card.followup.add';
      instruction: string;
      paramsSummary: string;
      requiresConfirm: true;
    }
  | {
      kind: 'write_confirm';
      actionName: AssistantWriteActionName;
      params: Record<string, unknown>;
      previewTitle: string;
      previewMessage: string;
      humanLabel?: string;
      paramsSummary: string;
      requiresConfirm: true;
    }
  | {
      /** The learner wants to mark a mistake reason but named none: the panel lists them (#1439). */
      kind: 'pick_error_reason';
      actionName: typeof SET_ERROR_REASON_ACTION;
      target: ErrorReasonTarget;
      paramsSummary: string;
      requiresConfirm: false;
    }
  | {
      kind: 'unsupported';
      actionName: 'unsupported';
      reason: string;
      alternativeLabel: string;
      alternativeCommand: string;
      paramsSummary: string;
      requiresConfirm: false;
    }
  | {
      kind: 'chat';
      actionName: 'assistant.chat';
      instruction: string;
      paramsSummary: string;
      requiresConfirm: false;
    };

/** A request to mark why a card was answered wrong. */
const MARK_REASON_REQUEST = /(加入错题|标记(?:为)?错因|错因(?:标|设)为|mark.*mistake|wrongbook.*reason)/i;
/** "mark as …" on its own counts only when what follows is a known reason. */
const MARKS_AS = /标记为|标为/;
/** The words after "mark as" / "reason:", up to the next punctuation. */
const REASON_CLAUSE = /(?:标记为|标为|设为|原因[:：]?|reason[:：]?)\s*([^，。,.;；\n]+)/i;

/** The confirmed write that stores `reason` on the card's latest wrong answer (#1439). */
export function errorReasonWriteIntent(
  target: ErrorReasonTarget,
  reason: ErrorReasonId,
  lang: UiLanguage,
): Extract<AssistantIntent, { kind: 'write_confirm' }> {
  const name = errorReasonName(reason, lang);
  const card = target.cardId ?? (lang === 'en' ? 'current' : '当前题');
  return {
    kind: 'write_confirm',
    actionName: SET_ERROR_REASON_ACTION,
    params: errorReasonArgs(target, reason),
    previewTitle: lang === 'en' ? 'Confirm Mark Wrong Reason' : '确认标记错题原因',
    previewMessage:
      lang === 'en'
        ? `Will run: ${SET_ERROR_REASON_ACTION} (cardId=${card}, reason="${name}")`
        : `将执行：${SET_ERROR_REASON_ACTION}（题目=${card}，错因=${name}）`,
    paramsSummary: `cardId=${card}, errorReason=${reason}`,
    requiresConfirm: true,
  };
}

export interface ParseIntentContext {
  snapshot?: StudySnapshot | null;
  currentCardId?: string | null;
  currentDeckId?: string | null;
  card?: AssistantCardContext | null;
  lang?: UiLanguage;
}

const PAGE_PATTERNS: ReadonlyArray<{ page: PageId; re: RegExp; zh: string; en: string }> = [
  // Put explicit "back to this question / continue practicing" BEFORE wrongbook so "回到这道错题继续做" goes to review (#1444).
  { page: 'review', re: /回(?:到)?这(?:道|个)?(?:错)?题|继续(?:做|练习|刷题)|刷题|回(?:到)?原题|\breview\b/i, zh: '刷题复习', en: 'Review' },
  { page: 'sources', re: /资料库|资料页|讲义|原文|阅读器|sources?|reader/i, zh: '资料', en: 'Sources' },
  { page: 'wrongbook', re: /错题本|wrongbook|mistakes?\s*(?:book|list|page)?|(?:打开|跳到|去|切到|进入|查看)(?:我的)?错题(?:列表|页)?$/i, zh: '错题本', en: 'Mistakes' },
  { page: 'dashboard', re: /统计|仪表盘|学习进度|stats|dashboard/i, zh: '学习统计', en: 'Stats' },
  { page: 'library', re: /学习库|题组列表|首页|library/i, zh: '学习库', en: 'Library' },
  { page: 'generate', re: /创建题组|草稿|出题页|generate/i, zh: '创建题组', en: 'Generate' },
  { page: 'exam', re: /模拟考|考试页|mock\s*exam/i, zh: '模拟考试', en: 'Mock Exam' },
  { page: 'book', re: /复习全书|全书|review\s*book/i, zh: '复习全书', en: 'Review Book' },
  { page: 'skeleton', re: /知识骨架|骨架|skeleton/i, zh: '知识骨架', en: 'Skeleton' },
  { page: 'examcoach', re: /考试教练|教练|exam\s*coach/i, zh: '考试教练', en: 'Exam Coach' },
  { page: 'examprep', re: /备考补习|备考|exam\s*prep/i, zh: '备考补习', en: 'Exam Prep' },
  { page: 'notes', re: /学习笔记|笔记页|笔记|\bnotes?\b/i, zh: '学习笔记', en: 'Notes' },
  { page: 'board', re: /待办看板|看板|番茄钟|board/i, zh: '待办看板', en: 'Board' },
  { page: 'tasks', re: /后台任务|任务页|jobs|tasks/i, zh: '后台任务', en: 'Tasks' },
  { page: 'audio', re: /音频转写|音频|audio/i, zh: '音频转写', en: 'Audio' },
  { page: 'settings', re: /设置|模型配置|settings/i, zh: '设置', en: 'Settings' },
];

const UNSUPPORTED_PATTERNS: ReadonlyArray<{
  re: RegExp;
  reasonZh: string;
  reasonEn: string;
  altLabelZh: string;
  altLabelEn: string;
  altCmd: string;
}> = [
  {
    re: /(?:发邮件|发送邮件|发微信|群发|推送给|(?:帮我|请)?(?:给|向)\S{1,12}发消息|\bsend\s+(?:an?\s+)?email\b|\bsend\s+(?:a\s+)?(?:message|msg)\s+(?:on|to|via)\s+(?:wechat|slack|telegram)\b)/i,
    reasonZh: '当前终端不支持外部通信发送。',
    reasonEn: 'External messaging is not supported in TUI.',
    altLabelZh: '改为：导出本课错题 Markdown 后手动分享',
    altLabelEn: 'Alternative: export wrongbook Markdown to share',
    altCmd: '导出本课错题 Markdown',
  },
  {
    re: /(?:删掉整个硬盘|清空电脑|格式化(?:硬盘|磁盘|电脑|系统|[A-Z]盘|U盘|分区)|执行\s*shell|跑系统命令|\brm\s+-rf\b|\bformat\s+(?:disk|drive|[a-z]:)\b)/i,
    reasonZh: '安全限制：助手仅执行 StudyHub 学习动作，不操作系统文件。',
    reasonEn: 'Safety guard: assistant only runs StudyHub study actions.',
    altLabelZh: '改为：查看学习库统计概况',
    altLabelEn: 'Alternative: view library stats',
    altCmd: '查看统计',
  },
  {
    re: /(?:联网搜索|查.{0,4}天气|买机票|订外卖|点餐|\bsearch\s+google\b|\bcheck\s+weather\b)/i,
    reasonZh: '当前助手聚焦本地学习库，不支持外部联网服务。',
    reasonEn: 'Assistant is scoped to your local study library.',
    altLabelZh: '改为：打开资料库检索本地讲义',
    altLabelEn: 'Alternative: open Sources to search local materials',
    altCmd: '跳到资料库',
  },
];

/** Manual-only StudyHub UI actions that need direct TUI interaction (#1444). */
const MANUAL_ACTION_GUIDANCE: ReadonlyArray<{
  re: RegExp;
  reasonZh: string;
  reasonEn: string;
  altLabelZh: string;
  altLabelEn: string;
  altCmd: string;
}> = [
  {
    re: /(?:把|将)?这(?:道)?题(?:的)?(?:题干|答案|解析|选项)(?:改(?:成|为)|修改(?:成|为)|换成)|编辑(?:本题|这(?:道)?题)(?:题干|答案|解析)?|\bedit\s+(?:this\s+)?(?:card|question|answer)\b/i,
    reasonZh: '我目前不能直接修改题干或答案（未改动任何数据），需要在刷题页按 [D] 打开题目工具手动编辑。',
    reasonEn: 'I cannot edit card fields directly (nothing changed). Press [D] in Review to edit in Card Tools.',
    altLabelZh: '改为：发起后台助教修题',
    altLabelEn: 'Alternative: start background question improvement',
    altCmd: '这题答案有问题，帮我修一下',
  },
  {
    re: /(?:把|将)这(?:一)?段(?:加入待出题|标(?:记)?为?待出题|高亮|标红)|标记(?:当前)?段落|加入待出题|\bmark\s+paragraph\b/i,
    reasonZh: '我目前不能直接选中并标记资料段落（未改动任何数据），需要在资料阅读器中选中段落后按 [H] 加入待出题。',
    reasonEn: 'I cannot highlight reader paragraphs directly (nothing changed). Press [H] in the reader.',
    altLabelZh: '改为：打开资料库阅读讲义',
    altLabelEn: 'Alternative: open Sources reader',
    altCmd: '打开资料库',
  },
  {
    re: /(?:删除|删掉|归档|合并|拆分|重命名)(?:这个|当前|全部|所有)?(?:题组|牌组|deck)|\b(?:delete|archive|merge|split)\s+(?:this\s+|all\s+)?decks?\b/i,
    reasonZh: '我目前不能直接执行题组删除、归档或合并（未改动任何数据），需要在学习库按 [m] 打开题组管理操作。',
    reasonEn: 'I cannot delete/archive/merge decks directly (nothing changed). Press [m] in Library.',
    altLabelZh: '改为：打开学习库管理题组',
    altLabelEn: 'Alternative: open Library to manage decks',
    altCmd: '打开学习库',
  },
];

const STUDY_QUESTION_RE =
  /^(?:什么是|啥是|请问(?:什么是)?|解释(?:一下)?|说明(?:一下)?|讲讲|聊聊|对比|比较|如何理解|怎么理解|为什么|为何|what\s+is\b|explain\b|how\s+does\b|why\s+does\b|difference\s+between\b)/i;
const STUDY_QUESTION_END_RE =
  /(?:是什么|有什么区别|有哪些|的方法|的原理|怎么实现|是怎么实现的|是什么意思)[？?]?$/i;

/** Imperative / action-like patterns that should NEVER silently masquerade as "completed" chat (#1444). */
const ACTION_LIKE_REQUEST_RE =
  /(?:^(?:帮我|请帮我|请)?(?:把|将|自动|批量|一键|同步|导入|导出|删除|删掉|清空|修改|编辑|重排|排序|合并|拆分|分享|发布|上传|下载|归档|新建|创建|添加|设置|调整|迁移|备份)|(?:同步到|导入到|导出到|推送到|上传到|发布到)\s*\S+|\b(?:please\s+)?(?:batch|sync|export|import|delete|remove|reorder|sort|merge|split|upload|publish|backup)\s+(?:all|my|the|this)\b)/i;

function isConceptualStudyQuestion(text: string): boolean {
  return STUDY_QUESTION_RE.test(text) || STUDY_QUESTION_END_RE.test(text);
}

function extractInt(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  if (!m) return undefined;
  const raw = m.slice(1).find(Boolean);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/**
 * Derive a learner-facing question title when saving a plain explanation via `card.followup.add` (#1442).
 * Generic commands ("讲解新增通俗讲解", "用大白话讲一下这题", "plain explain") become "通俗讲解" /
 * "Plain Explanation"; when the learner included a specific question, that question is preserved.
 */
export function resolvePlainExplainQuestionTitle(rawInstruction: string, lang: UiLanguage = 'zh'): string {
  const defaultTitle = lang === 'en' ? 'Plain Explanation' : '通俗讲解';
  const raw = String(rawInstruction ?? '').trim();
  if (!raw) return defaultTitle;

  const strippedPrefix = raw
    .replace(
      /^(?:(?:请|帮我|给我|给(?:这道|这|本)题|再|重新)?(?:讲解新增|新增|生成|写一条|来一条|来个|用|换个例子|重新)?\s*(?:通俗讲解|大白话(?:讲(?:一?下|讲)?)?|通俗(?:地)?讲(?:一?下|讲)?|讲(?:一?下|讲)|帮我理解|plain\s+explain|add\s+(?:a\s+)?(?:plain\s+)?explanation|explain\s+simply|help\s+me\s+understand)\s*[:：,，]?\s*)+/i,
      '',
    )
    .trim();

  const remainderCheck = strippedPrefix
    .replace(/^(?:给|为|关于|针对|一下|一?遍|这道题|这题|本题|当前题|this\s+question|this\s+card|for\s+this\s+question|about\s+this)\s*/gi, '')
    .replace(/(?:这道题|这题|本题|当前题|通俗讲解|大白话|讲解)$/gi, '')
    .replace(/[\s，。？！,.?!:：;；]+/g, '')
    .trim();

  if (!remainderCheck || remainderCheck.length < 3) return defaultTitle;
  return strippedPrefix || defaultTitle;
}

/** Build a clean, self-contained prompt for the `[P] 复制提示词` fallback (never dead-ends). */
export function buildFallbackPrompt(opts: {
  instruction?: string;
  card?: AssistantCardContext | null;
  page?: PageId;
  course?: string | null;
  lang?: UiLanguage;
}): string {
  const lang = opts.lang ?? 'zh';
  const lines: string[] = [];
  if (lang === 'en') {
    lines.push('Please help me with the following StudyHub study question:');
    if (opts.course) lines.push(`Course: ${opts.course}`);
    if (opts.card?.prompt) lines.push(`Question: ${opts.card.prompt}`);
    if (opts.card?.userAnswer) lines.push(`My Answer: ${opts.card.userAnswer}`);
    if (opts.instruction) lines.push(`Goal: ${opts.instruction}`);
    lines.push('Please explain clearly with concise steps and key pitfalls.');
  } else {
    lines.push('请结合以下学习上下文帮我解答（给出简洁要点与易错点）：');
    if (opts.course) lines.push(`课程：${opts.course}`);
    if (opts.card?.prompt) lines.push(`当前题目：${opts.card.prompt}`);
    if (opts.card?.userAnswer) lines.push(`我的作答：${opts.card.userAnswer}`);
    if (opts.instruction) lines.push(`需求：${opts.instruction}`);
  }
  return lines.join('\n');
}

function resolveCardContext(ctx: ParseIntentContext) {
  const card = ctx.card ?? null;
  const cardId = card?.cardId ?? ctx.currentCardId ?? undefined;
  const deckId = card?.deckId ?? ctx.currentDeckId ?? undefined;
  const runId = card?.runId ?? undefined;
  const entryIndex = card?.cardIndex;
  const course =
    typeof ctx.snapshot?.focus?.course === 'string' && ctx.snapshot.focus.course
      ? ctx.snapshot.focus.course
      : undefined;
  return { card, cardId, deckId, runId, entryIndex, course };
}

/**
 * Parse a natural-language user command into a structured TUI assistant intent.
 */
export function parseAssistantIntent(rawInput: string, ctx: ParseIntentContext = {}): AssistantIntent {
  const text = String(rawInput ?? '').trim();
  const lang = ctx.lang ?? 'zh';
  const conceptualQuestion = isConceptualStudyQuestion(text);
  const { card, cardId, deckId, runId, entryIndex, course } = resolveCardContext(ctx);

  // 0) Unsupported out-of-scope actions -> nearest alternative + copy-prompt fallback
  if (!conceptualQuestion) {
    for (const u of UNSUPPORTED_PATTERNS) {
      if (u.re.test(text)) {
        return {
          kind: 'unsupported',
          actionName: 'unsupported',
          reason: lang === 'en' ? u.reasonEn : u.reasonZh,
          alternativeLabel: lang === 'en' ? u.altLabelEn : u.altLabelZh,
          alternativeCommand: u.altCmd,
          paramsSummary: 'fallback',
          requiresConfirm: false,
        };
      }
    }
  }

  // 1) Enter Guided Study / Retell tab (natural phrasing, no longer exact-match only, #1444)
  if (
    !conceptualQuestion &&
    /(?:(?:进入|开启|启动|切到|切换到|用|开始)(?:苏格拉底)?带学|苏格拉底带学|带学(?:模式|这(?:道)?题|一下|复述)|(?:开始|进入|我想|来)(?:一遍|一下)?复述|\b(?:enter|start)\s+guided(?:\s+study)?\b|^guided\s*study$|^retell$)/i.test(
      text,
    )
  ) {
    const toRetell = /复述|retell/i.test(text);
    return {
      kind: 'enter_guided',
      stage: toRetell ? 'retell' : 'question',
      actionName: 'assistant.guided',
      paramsSummary: toRetell ? 'tab=guided, stage=retell' : 'tab=guided',
      requiresConfirm: false,
    };
  }

  // 2) Card & Study Write/Confirm Actions (#1444 + #1439 + #1315)
  if (!conceptualQuestion) {
    // 2a) Prerequisite question derivation & link (#1444 #1)
    if (/(?:出|生成|建|补)(?:一?道)?前置(?:补强|基础)?题|前置题(?:补强|下次|关联)?|(?:derive|create|make).*prerequisite/i.test(text)) {
      return {
        kind: 'write_confirm',
        actionName: 'assist.start',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
          ...(runId ? { runId } : {}),
          mode: 'derive',
          derive: { relation: 'prerequisite' },
          text,
          uiLanguage: lang,
        },
        humanLabel: lang === 'en' ? 'Generate & link prerequisite question' : '生成前置题并关联到本题',
        previewTitle: lang === 'en' ? 'Confirm Prerequisite Question' : '确认生成前置题并关联',
        previewMessage:
          lang === 'en'
            ? 'Will start a background assist task to create a prerequisite question and link it to the current card.'
            : '将启动后台助教任务：基于当前题目生成一道前置补强题，并自动关联到本题。',
        paramsSummary: lang === 'en' ? 'derive prerequisite & link' : '出前置题并关联',
        requiresConfirm: true,
      };
    }

    // 2b) Improve / fix defective question via background assist (#1444 #5)
    if (
      /(?:帮我|请)?修(?:改|复|正|一下)这(?:道)?题|这(?:道)?题(?:答案|解析|题干)?有(?:错|误|问题).*(?:修|改)|修题|\b(?:fix|improve)\s+(?:this\s+)?(?:card|question)\b/i.test(
        text,
      ) &&
      !/(?:改(?:成|为)|换成)\s*[A-Za-z0-9]/.test(text)
    ) {
      return {
        kind: 'write_confirm',
        actionName: 'assist.start',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
          ...(runId ? { runId } : {}),
          mode: 'improve',
          text,
          uiLanguage: lang,
        },
        humanLabel: lang === 'en' ? 'Improve current question' : '后台助教修题',
        previewTitle: lang === 'en' ? 'Confirm Improve Question' : '确认发起修题任务',
        previewMessage:
          lang === 'en'
            ? 'Will start a background assist task to review and improve this question.'
            : '将启动后台助教任务，结合你的反馈检查并修订当前题目。',
        paramsSummary: lang === 'en' ? 'improve current question' : '修订当前题目',
        requiresConfirm: true,
      };
    }

    // 2c) Manual-only UI actions with honest shortcut guidance (#1444 #6, #13, deck management)
    for (const m of MANUAL_ACTION_GUIDANCE) {
      if (m.re.test(text)) {
        return {
          kind: 'unsupported',
          actionName: 'unsupported',
          reason: lang === 'en' ? m.reasonEn : m.reasonZh,
          alternativeLabel: lang === 'en' ? m.altLabelEn : m.altLabelZh,
          alternativeCommand: m.altCmd,
          paramsSummary: 'manual_shortcut',
          requiresConfirm: false,
        };
      }
    }

    // 2d) Save reply / Q&A to notes (#1444 #4)
    if (/(?:(?:把|将).*(?:解答|回答|讲解|对话|解析)?.*)?(?:存|加|写|记)(?:进|到|入)(?:我的)?笔记|\bsave.*to\s+notes?\b/i.test(text)) {
      return {
        kind: 'write_confirm',
        actionName: 'note.qa.add',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
          language: lang,
        },
        humanLabel: lang === 'en' ? 'Save Q&A to study notes' : '保存到学习笔记',
        previewTitle: lang === 'en' ? 'Confirm Save to Notes' : '确认存到学习笔记',
        previewMessage:
          lang === 'en'
            ? 'Will save the current card Q&A and latest assistant answer into your study note.'
            : '将把当前题目与最近一条助手解答写入今天的学习笔记。',
        paramsSummary: lang === 'en' ? 'save Q&A to note' : '写入学习笔记',
        requiresConfirm: true,
      };
    }

    // 2e) Flag card issue (#1444 #7)
    if (/(?:标(?:记|一下)?.*(?:题干|题目|答案|这(?:道)?题)?有问题|这(?:道)?题(?:题干|答案)?有问题|标问题|\bflag\s+(?:this\s+)?(?:card|question)\b)/i.test(text)) {
      return {
        kind: 'write_confirm',
        actionName: 'card.flag',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
          reason: text,
        },
        humanLabel: lang === 'en' ? 'Flag question issue' : '标记题目有问题',
        previewTitle: lang === 'en' ? 'Confirm Flag Question' : '确认标记题目问题',
        previewMessage:
          lang === 'en'
            ? 'Will flag this question for follow-up review (can be undone with [z]).'
            : '将为当前题目添加问题标记，方便后续核对修订（按 [z] 可撤销）。',
        paramsSummary: lang === 'en' ? 'flag current question' : '标记本题待复核',
        requiresConfirm: true,
      };
    }

    // 2f) Override / adjust AI grade (#1444 #8)
    if (/(?:改判|判(?:我)?(?:对|正确)|这(?:道)?题我答对了|(?:把评分|成绩)改(?:成|为)(?:正确|答对|通过|\d\s*分)|\b(?:override|adjust)\s+grade\b|\bmark\s+(?:as\s+)?correct\b)/i.test(text)) {
      const explicitGrade = extractInt(text, /([1-5])\s*分/);
      const grade = explicitGrade !== undefined && explicitGrade >= 1 && explicitGrade <= 5 ? explicitGrade : 4;
      return {
        kind: 'write_confirm',
        actionName: 'review.grade.adjust',
        params: {
          ...(runId ? { runId } : {}),
          ...(cardId ? { cardId } : {}),
          ...(typeof entryIndex === 'number' ? { entryIndex } : {}),
          grade,
        },
        humanLabel: lang === 'en' ? `Adjust grade to ${grade}` : `改判评分为 ${grade} 分`,
        previewTitle: lang === 'en' ? 'Confirm Grade Adjustment' : '确认改判评分',
        previewMessage:
          lang === 'en'
            ? `Will adjust the current AI-graded answer to grade ${grade} (correct).`
            : `将把当前题目的 AI 评分改判为 ${grade} 分（判定为正确）并重算复习计划。`,
        paramsSummary: `grade=${grade}`,
        requiresConfirm: true,
      };
    }

    // 2g) Acknowledge correction (#1444 #9)
    if (/(?:我订正好了|确认订正|订正完成|我看懂了.*(?:订正|重练)|\back(?:nowledge)?\s+correction\b)/i.test(text)) {
      return {
        kind: 'write_confirm',
        actionName: 'review.correction.ack',
        params: {
          ...(runId ? { runId } : {}),
          ...(cardId ? { cardId } : {}),
          ...(typeof entryIndex === 'number' ? { entryIndex } : {}),
        },
        humanLabel: lang === 'en' ? 'Acknowledge correction' : '确认订正并加入重练',
        previewTitle: lang === 'en' ? 'Confirm Correction Acknowledged' : '确认订正完成',
        previewMessage:
          lang === 'en'
            ? 'Will acknowledge this correction and queue a retry in the current round.'
            : '将确认本题订正完成，并安排在本轮末尾重练巩固。',
        paramsSummary: lang === 'en' ? 'acknowledge correction' : '确认订正',
        requiresConfirm: true,
      };
    }

    // 2h) Practice wrong-card variants (#1444 #10)
    if (/(?:练|刷|做)(?:一下|一遍)?(?:错题(?:的)?)?变式|错题变式|练(?:一下)?定制题|\bpractice\s+(?:wrong\s+)?variants?\b/i.test(text)) {
      return {
        kind: 'write_confirm',
        actionName: 'coach.practice',
        params: {},
        humanLabel: lang === 'en' ? 'Start wrong-card variants practice' : '开始错题变式练习',
        previewTitle: lang === 'en' ? 'Confirm Variant Practice' : '确认开始错题变式练习',
        previewMessage:
          lang === 'en'
            ? 'Will start a practice round using prepared wrong-card variant questions.'
            : '将使用已备好的错题变式题开启一轮新练习，并自动进入刷题页。',
        paramsSummary: lang === 'en' ? 'start variant practice' : '错题变式练习',
        requiresConfirm: true,
      };
    }

    // 2i) Batch practice wrong cards (#1444 #11)
    if (/(?:把(?:所有|全部)?错题(?:拿来)?(?:重)?练|重练(?:所有|本课)?错题|刷(?:一遍|一下)?错题|开始错题(?:练习|复习)|\bpractice\s+(?:my\s+)?(?:wrong|mistakes?)\b)/i.test(text)) {
      return {
        kind: 'write_confirm',
        actionName: 'review.start',
        params: {
          mode: 'path',
          only: 'wrong',
          ...(course ? { course } : {}),
          fresh: true,
        },
        humanLabel: lang === 'en' ? 'Start wrong-cards practice round' : '开启错题重练轮次',
        previewTitle: lang === 'en' ? 'Confirm Wrong-Cards Practice' : '确认开始错题重练',
        previewMessage:
          lang === 'en'
            ? `Will start a fresh wrong-cards practice round${course ? ` (${course})` : ''} and switch to Review.`
            : `将为${course ? `「${course}」` : '当前学习库'}开启一轮错题重练，并进入刷题页。`,
        paramsSummary: course ? `only=wrong, course=${course}` : 'only=wrong',
        requiresConfirm: true,
      };
    }

    // 2j) Slay card (#1444 #15a)
    if (/(?:斩(?:掉|了)?这(?:道)?题|这(?:道)?题(?:已经)?掌握了.*(?:别再出|不用再出|不再出|斩)|别再出这(?:道)?题|\bslay\s+(?:this\s+)?(?:card|question)\b)/i.test(text)) {
      return {
        kind: 'write_confirm',
        actionName: 'card.slay',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
          ...(runId ? { runId } : {}),
        },
        humanLabel: lang === 'en' ? 'Slay mastered question' : '斩掉本题（移入斩题组）',
        previewTitle: lang === 'en' ? 'Confirm Slay Question' : '确认斩题',
        previewMessage:
          lang === 'en'
            ? 'Will move this mastered question to the Slain deck (press [z] to restore).'
            : '将把本题移入斩题组，后续复习不再出现（按 [z] 可恢复）。',
        paramsSummary: lang === 'en' ? 'slay current question' : '斩题',
        requiresConfirm: true,
      };
    }

    // 2k) Suspend / resume card (#1444 #15b)
    if (/(?:(?:暂停|搁置|先不出|恢复)这(?:道)?题|\b(?:suspend|pause|resume)\s+(?:this\s+)?(?:card|question)\b)/i.test(text)) {
      const isResume = /恢复|resume/i.test(text);
      return {
        kind: 'write_confirm',
        actionName: 'card.suspend',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
          suspended: !isResume,
        },
        humanLabel: isResume
          ? lang === 'en' ? 'Resume question' : '恢复本题到复习队列'
          : lang === 'en' ? 'Suspend question' : '暂停本题',
        previewTitle: isResume
          ? lang === 'en' ? 'Confirm Resume Question' : '确认恢复题目'
          : lang === 'en' ? 'Confirm Suspend Question' : '确认暂停题目',
        previewMessage: isResume
          ? lang === 'en'
            ? 'Will restore this question to the active review queue (press [z] to undo).'
            : '将恢复本题回到日常复习队列（按 [z] 可撤销）。'
          : lang === 'en'
            ? 'Will suspend this question from daily review (press [z] to undo).'
            : '将暂停本题，暂时移出日常复习队列（按 [z] 可撤销）。',
        paramsSummary: isResume ? 'suspended=false' : 'suspended=true',
        requiresConfirm: true,
      };
    }

    // 2l) Toggle focus / star (#1444 #15c)
    if (/(?:(?:标(?:记)?为?|加入|收藏|取消)(?:考纲)?重点|收藏这(?:道)?题|\b(?:mark|star|toggle).*\bfocus\b)/i.test(text)) {
      const removeFocus = /取消/.test(text);
      return {
        kind: 'write_confirm',
        actionName: 'card.focus',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
          ...(removeFocus ? { focus: false } : { focus: true }),
        },
        humanLabel: removeFocus
          ? lang === 'en' ? 'Remove focus star' : '取消考纲重点标记'
          : lang === 'en' ? 'Mark as focus priority' : '收藏为考纲重点',
        previewTitle: removeFocus
          ? lang === 'en' ? 'Confirm Remove Focus' : '确认取消重点标记'
          : lang === 'en' ? 'Confirm Mark Focus' : '确认收藏为重点',
        previewMessage: removeFocus
          ? lang === 'en'
            ? 'Will remove the focus priority mark from this question (press [z] to undo).'
            : '将取消当前题目的考纲重点标记（按 [z] 可撤销）。'
          : lang === 'en'
            ? 'Will mark this question as Focus for priority review (press [z] to undo).'
            : '将把当前题目收藏为考纲重点，优先安排复习（按 [z] 可撤销）。',
        paramsSummary: removeFocus ? 'focus=false' : 'focus=true',
        requiresConfirm: true,
      };
    }

    // 2m) Undo last rating in review (#1444 #16b)
    if (/(?:撤销上一题(?:评分|作答)?|撤销刚才(?:的)?(?:评分|作答)|\bundo\s+last\s+(?:answer|rating|grade)\b)/i.test(text)) {
      return {
        kind: 'write_confirm',
        actionName: 'review.undo',
        params: { ...(runId ? { runId } : {}) },
        humanLabel: lang === 'en' ? 'Undo last review rating' : '撤销上一题评分',
        previewTitle: lang === 'en' ? 'Confirm Undo Rating' : '确认撤销上一题评分',
        previewMessage:
          lang === 'en'
            ? 'Will undo the most recent rating in this review round and restore its previous schedule.'
            : '将撤销本轮最近一次作答评分，并恢复该题之前的复习进度。',
        paramsSummary: lang === 'en' ? 'undo last rating' : '撤销上次评分',
        requiresConfirm: true,
      };
    }

    // 2n) Move current card to end of round queue (#1444 #18)
    if (/(?:(?:把|将)这(?:道)?题(?:挪|移|放)到最后|(?:把|将)这(?:道)?题(?:延后|放后面)|\bmove\s+(?:this\s+)?(?:card|question)\s+to\s+(?:the\s+)?end\b)/i.test(text)) {
      const ref = { ...(deckId ? { deckId } : {}), ...(cardId ? { cardId } : {}) };
      return {
        kind: 'write_confirm',
        actionName: 'review.queue.edit',
        params: {
          ...(runId ? { runId } : {}),
          remove: [ref],
          add: [ref],
          position: 'end',
          allowCurrent: true,
        },
        humanLabel: lang === 'en' ? 'Move question to end of queue' : '把本题挪到本轮最后',
        previewTitle: lang === 'en' ? 'Confirm Reorder Queue' : '确认调整本轮题序',
        previewMessage:
          lang === 'en'
            ? 'Will move this unanswered question to the end of the current practice queue.'
            : '将把当前未作答题目移至本轮练习队列末尾。',
        paramsSummary: lang === 'en' ? 'move to end' : '挪到本轮末尾',
        requiresConfirm: true,
      };
    }

    // 2o) Export wrongbook / single wrong card (#1444 truthful scope)
    if (/(导出|export).*(错题|wrongbook|mistakes?)/i.test(text)) {
      const isSingleCard = /(?:导出|export)\s*(?:这(?:道|个)|当前(?:这(?:道|个))?|本)错题/i.test(text) && Boolean(cardId);
      const exportCourse = course ?? '*';
      return {
        kind: 'write_confirm',
        actionName: 'export.wrongbook',
        params: isSingleCard
          ? {
              course: exportCourse,
              singleCard: true,
              cardId,
              prompt: card?.prompt ?? '',
              answer: card?.answer ?? '',
              explanation: card?.explanation ?? '',
            }
          : { course: exportCourse },
        previewTitle: isSingleCard
          ? lang === 'en' ? 'Confirm Export This Wrong Card' : '确认导出当前错题'
          : lang === 'en' ? 'Confirm Export Wrong-Book' : '确认导出错题本',
        previewMessage: isSingleCard
          ? lang === 'en'
            ? 'Will export only the current wrong card to a Markdown file under backups/.'
            : '将仅导出当前这道错题到 backups/ 下的 Markdown 文件。'
          : lang === 'en'
            ? `Will run: export.wrongbook (course=${exportCourse}) -> backups/studyhub-wrongbook-*.md`
            : `将执行：export.wrongbook（课程=${exportCourse === '*' ? '全部' : exportCourse}）写入 backups/ 下的 Markdown 文件`,
        paramsSummary: isSingleCard ? `singleCard=true, cardId=${cardId}` : `course=${exportCourse}`,
        requiresConfirm: true,
      };
    }

    // 2p) Mark wrong reason (#1439)
    const namedReason = errorReasonFromText(text.match(REASON_CLAUSE)?.[1] ?? '');
    if (MARK_REASON_REQUEST.test(text) || (namedReason && MARKS_AS.test(text))) {
      const target: ErrorReasonTarget = { deckId, cardId };
      if (namedReason) return errorReasonWriteIntent(target, namedReason, lang);
      return {
        kind: 'pick_error_reason',
        actionName: SET_ERROR_REASON_ACTION,
        target,
        paramsSummary: `cardId=${cardId ?? '当前题'}`,
        requiresConfirm: false,
      };
    }

    // 2q) Read-only / lightweight direct actions (#1444 #2, #12, #16a, #17)
    if (/(?:同类题|相似题|类似(?:的)?题|再(?:来|给我)(?:一?道)?(?:同类|相似|类似)|\bsimilar\s+(?:card|question)\b)/i.test(text)) {
      return {
        kind: 'run_action',
        actionName: 'review.similar',
        params: {
          ...(runId ? { runId } : {}),
          ...(cardId ? { cardId } : {}),
          limit: 6,
        },
        humanLabel: lang === 'en' ? 'Find similar questions' : '查找同类题',
        paramsSummary: lang === 'en' ? 'find similar questions' : '查找同类题',
        requiresConfirm: false,
      };
    }

    if (/(?:提取.*(?:术语|生词)|(?:术语|生词).*提取|列出(?:本题|这(?:道)?题)?(?:核心)?(?:术语|生词)|\bextract\s+terms?\b)/i.test(text)) {
      return {
        kind: 'run_action',
        actionName: 'card.terms',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
        },
        humanLabel: lang === 'en' ? 'Extract key terms' : '提取核心术语',
        paramsSummary: lang === 'en' ? 'extract card terms' : '提取本题术语',
        requiresConfirm: false,
      };
    }

    if (/(?:翻译(?:这(?:道)?题|本题)|(?:把|将)这(?:道)?题翻译(?:成|为)|\btranslate\s+(?:this\s+)?(?:card|question)\b)/i.test(text)) {
      return {
        kind: 'run_action',
        actionName: 'card.translate',
        params: {
          ...(deckId ? { deckId } : {}),
          ...(cardId ? { cardId } : {}),
        },
        humanLabel: lang === 'en' ? 'Translate current question' : '翻译本题',
        paramsSummary: lang === 'en' ? 'translate current question' : '翻译当前题目',
        requiresConfirm: false,
      };
    }

    if (/^(?:请|帮我)?(?:跳过这(?:道)?题|先跳过|跳过本题|跳到下一题|下一题|skip(?:\s+this)?(?:\s+(?:card|question))?)$/i.test(text)) {
      return {
        kind: 'run_action',
        actionName: 'review.move',
        params: {
          ...(runId ? { runId } : {}),
          direction: 1,
        },
        humanLabel: lang === 'en' ? 'Skip to next question' : '跳过本题',
        paramsSummary: lang === 'en' ? 'next question' : '跳到下一题',
        requiresConfirm: false,
      };
    }

    // 2r) Generate questions from material -> navigate to Generate view (#1444 #14)
    if (/(?:(?:根据|按|从)(?:这?份)?(?:讲义|资料|文档|笔记).*出\s*\d*\s*道?题|出\s*\d+\s*道?题|\bgenerate\s+\d*\s*questions?\b)/i.test(text)) {
      const firstSourceId = card?.citations?.[0]?.sourceId ?? ctx.snapshot?.sources?.[0]?.id;
      return {
        kind: 'navigate',
        page: 'generate',
        ...(firstSourceId ? { sourceId: firstSourceId } : {}),
        actionName: 'navigate(generate)',
        paramsSummary: lang === 'en' ? 'Generate (from materials)' : '创建题组（按讲义出题）',
        requiresConfirm: false,
      };
    }
  }

  // 3) Single-step generation: plain explanation / help me understand (#1338, #1444 #3)
  if (/(通俗讲解|大白话讲|讲解新增|重新讲解|换个例子讲|帮我理解(?:这(?:道)?题)?|没看懂(?:这(?:道)?题)?|看不懂(?:这(?:道)?题)?|plain\s+explain|add.*explanation|help\s+me\s+understand)/i.test(text)) {
    return {
      kind: 'generate_plain_explain',
      actionName: 'card.followup.add',
      instruction: text,
      paramsSummary: lang === 'en' ? 'plain explanation (confirm before saving)' : '生成通俗讲解（保存前确认）',
      requiresConfirm: true,
    };
  }

  // 4) Source navigation with current-card citation awareness (#1340, #1444)
  const pageNumber = extractInt(text, /(?:第\s*(\d+)\s*页|(?:^|[\s,，(（])p\.?\s*(\d+)\b|\bpage\s*(\d+)\b)/i);
  const sourceOrdinal = extractInt(text, /第\s*(\d+)\s*(?:份|个|篇)?(?:讲义|资料|文档|pdf)/i);
  const isStandalonePageRef = /^(?:第\s*\d+\s*页|p\.?\s*\d+|page\s*\d+)$/i.test(text);
  const hasSourceNavVerb = /(?:跳到?|打开|定位|查看|看看|(?<![观查])看(?:一下)?(?:资料|讲义|原文|出处)|(?<![过失消除省免来])去|\bopen\b|\bgo\s+to\b|\bjump(?:\s+to)?\b)/i.test(text);
  if (
    !conceptualQuestion &&
    (isStandalonePageRef ||
      (hasSourceNavVerb && (pageNumber !== undefined || /资料|讲义|原文|出处|阅读器|source|reader/i.test(text))))
  ) {
    const sources = Array.isArray(ctx.snapshot?.sources) ? ctx.snapshot.sources : [];
    const askingCurrentCardOrigin = /(?:这(?:道)?题|本题|当前题).*(?:原文|出处|讲义|资料)|(?:原文|出处)/.test(text);
    const primaryCitation = Array.isArray(card?.citations)
      ? card.citations.find((c) => typeof c?.sourceId === 'string' && c.sourceId.trim().length > 0)
      : undefined;

    let sourceId: string | undefined;
    let resolvedPage = pageNumber;
    let resolvedIndex: number | undefined;

    if (sourceOrdinal !== undefined) {
      resolvedIndex = sourceOrdinal - 1;
      const picked = sources[resolvedIndex] ?? sources[0];
      sourceId = typeof picked?.id === 'string' ? picked.id : undefined;
    } else if (askingCurrentCardOrigin && primaryCitation?.sourceId) {
      // #1444: jump to the current question's actual citation source + page, NOT sources[0]!
      sourceId = primaryCitation.sourceId;
      if (resolvedPage === undefined && typeof primaryCitation.pageNumber === 'number' && primaryCitation.pageNumber >= 1) {
        resolvedPage = primaryCitation.pageNumber;
      }
    } else {
      const picked = sources[0];
      sourceId = typeof picked?.id === 'string' ? picked.id : undefined;
    }

    const parts: string[] = ['page=sources'];
    if (sourceOrdinal !== undefined) parts.push(`source=#${sourceOrdinal}`);
    if (sourceId) parts.push(`sourceId=${sourceId}`);
    if (resolvedPage !== undefined) parts.push(`pageNumber=${resolvedPage}`);
    return {
      kind: 'navigate',
      page: 'sources',
      ...(resolvedIndex !== undefined ? { sourceIndex: resolvedIndex } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(resolvedPage !== undefined ? { pageNumber: resolvedPage } : {}),
      actionName: 'navigate(sources)',
      paramsSummary: parts.join(', '),
      requiresConfirm: false,
    };
  }

  // 5) Read-only stats / due summary query
  if (/(查看统计|看下统计|今日到期|今天有多少题|多少题到期|学习概况|进度怎么样|show\s+stats|due\s+today)/i.test(text) && !/跳到|去|打开页面/.test(text)) {
    return {
      kind: 'readonly_stats',
      actionName: 'snapshot',
      paramsSummary: '只读统计（0 模型调用）',
      requiresConfirm: false,
    };
  }

  // 5b) Eye-care theme & display density natural-language toggles
  if (/(切换|换成|开启|启用|使用|switch\s+to|use|set).*(护眼|暖暗|暖色|低对比|柔和|深色|亮色|纸感|高对比|nord|warm-amber|soft-sage|warm-paper|high-contrast|dsh-dark)/i.test(text)) {
    let theme: TuiPreferences['theme'] | null = null;
    if (/低对比|柔和|护眼浅|浅绿|soft[\s-]?sage/i.test(text)) theme = 'soft-sage';
    else if (/暖暗|暖琥珀|夜间护眼|护眼|warm[\s-]?amber/i.test(text)) theme = 'warm-amber';
    else if (/纸感|暖纸|亮色|warm[\s-]?paper/i.test(text)) theme = 'warm-paper';
    else if (/高对比|high[\s-]?contrast/i.test(text)) theme = 'high-contrast';
    else if (/nord/i.test(text)) theme = 'nord';
    else if (/深色|默认|dsh[\s-]?dark/i.test(text)) theme = 'dsh-dark';
    if (theme) {
      return {
        kind: 'set_preference',
        patch: { theme },
        actionName: 'preferences.set',
        paramsSummary: `theme=${theme}`,
        requiresConfirm: false,
      };
    }
  }
  if (/(切换|开启|进入|使用|设为|set|switch\s+to).*(紧凑模式|紧凑排版|compact\s+mode|宽松模式|宽松排版|relaxed\s+mode)/i.test(text)) {
    const compactMode = /紧凑|compact/i.test(text);
    return {
      kind: 'set_preference',
      patch: { compactMode },
      actionName: 'preferences.set',
      paramsSummary: `compactMode=${compactMode ? 'compact' : 'relaxed'}`,
      requiresConfirm: false,
    };
  }

  // 5c) Exam countdown / backward auto-schedule intent -> direct Exam Prep view
  if (/(排.*备考计划|按考期倒推|考期倒推|备考排程|冲刺计划|倒计时计划|exam\s+plan|exam\s+countdown|study\s+schedule)/i.test(text)) {
    return {
      kind: 'navigate',
      page: 'examprep',
      actionName: 'navigate(examprep)',
      paramsSummary: lang === 'en' ? 'Exam Prep (countdown plan)' : '备考补习（考期倒推计划）',
      requiresConfirm: false,
    };
  }

  // 6) Direct page navigation (#1340, #1444)
  if (!conceptualQuestion && /(跳到|打开|进入|切到|切换到|(?<![过失消除省免来])去|回到|\bopen\b|\bgo\s+to\b|\bjump\s+to\b|\bswitch\s+to\b)/i.test(text)) {
    for (const p of PAGE_PATTERNS) {
      if (p.re.test(text)) {
        return {
          kind: 'navigate',
          page: p.page,
          actionName: `navigate(${p.page})`,
          paramsSummary: `${lang === 'en' ? p.en : p.zh} (${p.page})`,
          requiresConfirm: false,
        };
      }
    }
  }

  // 6b) Unrecognized action-like commands MUST NOT fall back to chat claiming "done" (#1444)
  if (!conceptualQuestion && ACTION_LIKE_REQUEST_RE.test(text)) {
    return {
      kind: 'unsupported',
      actionName: 'unsupported',
      reason:
        lang === 'en'
          ? 'I cannot directly execute this action right now (no data was changed). You need to perform it manually in the corresponding page or use an external tool.'
          : '我目前不能直接执行这个操作（未改动任何数据），需要你在对应页面手动完成，或按 [P] 复制上下文提示词处理。',
      alternativeLabel:
        lang === 'en'
          ? 'Suggestion: view stats or press [P] to copy prompt with context'
          : '建议：查看学习统计，或按 [P] 复制带上下文的提示词',
      alternativeCommand: '查看统计',
      paramsSummary: 'unsupported_action',
      requiresConfirm: false,
    };
  }

  // 7) Fallback: contextual AI assistant chat (read-only streaming, never claims "action completed")
  return {
    kind: 'chat',
    actionName: 'assistant.chat',
    instruction: text,
    paramsSummary: lang === 'en' ? 'Current study context' : '当前页面上下文',
    requiresConfirm: false,
  };
}
