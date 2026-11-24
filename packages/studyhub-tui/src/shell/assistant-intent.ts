/**
 * Deterministic natural-language intent parser for the Persistent AI Assistant (#1315 Phase 1).
 *
 * Strict constraints:
 * - Never invents backend actions — maps exclusively to existing `AppShell` navigation and
 *   `tui-host` actions (`snapshot`, `source.get`, `card.followup.add`, `attempt.errorReason.set`, etc.).
 * - Every write/quota/export action sets `requiresConfirm: true` so the panel always renders a
 *   P2 `ConfirmDialog` preview before execution.
 * - Never hits a dead end: unsupported requests return nearest supported alternative + ready-to-copy prompt.
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
      kind: 'generate_plain_explain';
      actionName: 'card.followup.add';
      instruction: string;
      paramsSummary: string;
      requiresConfirm: true;
    }
  | {
      kind: 'write_confirm';
      actionName: typeof SET_ERROR_REASON_ACTION | 'export.wrongbook' | 'review.grade.adjust' | 'card.followup.add';
      params: Record<string, unknown>;
      previewTitle: string;
      previewMessage: string;
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
  lang?: UiLanguage;
}

const PAGE_PATTERNS: ReadonlyArray<{ page: PageId; re: RegExp; zh: string; en: string }> = [
  { page: 'sources', re: /资料库|资料页|讲义|原文|阅读器|sources?|reader/i, zh: '资料', en: 'Sources' },
  { page: 'wrongbook', re: /错题本|错题|mistakes?|wrongbook/i, zh: '错题本', en: 'Mistakes' },
  { page: 'dashboard', re: /统计|仪表盘|学习进度|stats|dashboard/i, zh: '学习统计', en: 'Stats' },
  { page: 'library', re: /学习库|题组列表|首页|library/i, zh: '学习库', en: 'Library' },
  { page: 'generate', re: /创建题组|草稿|出题页|generate/i, zh: '创建题组', en: 'Generate' },
  { page: 'exam', re: /模拟考|考试页|mock\s*exam/i, zh: '模拟考试', en: 'Mock Exam' },
  { page: 'book', re: /复习全书|全书|review\s*book/i, zh: '复习全书', en: 'Review Book' },
  { page: 'skeleton', re: /知识骨架|骨架|skeleton/i, zh: '知识骨架', en: 'Skeleton' },
  { page: 'examcoach', re: /考试教练|教练|exam\s*coach/i, zh: '考试教练', en: 'Exam Coach' },
  { page: 'examprep', re: /备考补习|备考|exam\s*prep/i, zh: '备考补习', en: 'Exam Prep' },
  { page: 'notes', re: /学习笔记|笔记页|notes/i, zh: '学习笔记', en: 'Notes' },
  { page: 'board', re: /待办看板|看板|番茄钟|board/i, zh: '待办看板', en: 'Board' },
  { page: 'tasks', re: /后台任务|任务页|jobs|tasks/i, zh: '后台任务', en: 'Tasks' },
  { page: 'audio', re: /音频转写|音频|audio/i, zh: '音频转写', en: 'Audio' },
  { page: 'settings', re: /设置|模型配置|settings/i, zh: '设置', en: 'Settings' },
  { page: 'review', re: /刷题|继续练习|回(?:到)?(?:原)?题|review/i, zh: '刷题复习', en: 'Review' },
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

const STUDY_QUESTION_RE =
  /^(?:什么是|啥是|请问(?:什么是)?|解释(?:一下)?|说明(?:一下)?|讲讲|聊聊|对比|比较|如何理解|怎么理解|为什么|为何|what\s+is\b|explain\b|how\s+does\b|why\s+does\b|difference\s+between\b)/i;
const STUDY_QUESTION_END_RE =
  /(?:是什么|有什么区别|有哪些|的方法|的原理|怎么实现|是怎么实现的|是什么意思)[？?]?$/i;

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

/**
 * Parse a natural-language user command into a structured TUI assistant intent.
 */
export function parseAssistantIntent(rawInput: string, ctx: ParseIntentContext = {}): AssistantIntent {
  const text = String(rawInput ?? '').trim();
  const lang = ctx.lang ?? 'zh';
  const conceptualQuestion = isConceptualStudyQuestion(text);

  // 0) Unsupported out-of-scope actions -> nearest alternative + copy-prompt fallback (never dead-end!)
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

  // 1) Enter Guided Study / Retell tab directly
  if (/^(?:进入带学|苏格拉底带学|开始带学|带学复述|开始复述|guided\s*study|retell)$/i.test(text)) {
    const toRetell = /复述|retell/i.test(text);
    return {
      kind: 'enter_guided',
      stage: toRetell ? 'retell' : 'question',
      actionName: 'assistant.guided',
      paramsSummary: toRetell ? 'tab=guided, stage=retell' : 'tab=guided',
      requiresConfirm: false,
    };
  }

  // 2) Write actions (P2 ConfirmDialog required — NEVER silent!)
  if (/(导出|export).*(错题|wrongbook|mistakes?)/i.test(text)) {
    const course =
      typeof ctx.snapshot?.focus?.course === 'string' && ctx.snapshot.focus.course
        ? ctx.snapshot.focus.course
        : '*';
    return {
      kind: 'write_confirm',
      actionName: 'export.wrongbook',
      params: { course },
      previewTitle: lang === 'en' ? 'Confirm Export Wrong-Book' : '确认导出错题本',
      previewMessage:
        lang === 'en'
          ? `Will run: export.wrongbook (course=${course}) -> backups/studyhub-wrongbook-*.md`
          : `将执行：export.wrongbook（课程=${course === '*' ? '全部' : course}）写入 backups/ 下的 Markdown 文件`,
      paramsSummary: `course=${course}`,
      requiresConfirm: true,
    };
  }

  const namedReason = errorReasonFromText(text.match(REASON_CLAUSE)?.[1] ?? '');
  if (MARK_REASON_REQUEST.test(text) || (namedReason && MARKS_AS.test(text))) {
    const target: ErrorReasonTarget = { deckId: ctx.currentDeckId, cardId: ctx.currentCardId };
    if (namedReason) return errorReasonWriteIntent(target, namedReason, lang);
    return {
      kind: 'pick_error_reason',
      actionName: SET_ERROR_REASON_ACTION,
      target,
      paramsSummary: `cardId=${ctx.currentCardId ?? '当前题'}`,
      requiresConfirm: false,
    };
  }

  // 3) Single-step generation: plain explanation (saving to card requires P2 confirmation, #1338)
  if (/(通俗讲解|大白话讲|讲解新增|重新讲解|换个例子讲|plain\s+explain|add.*explanation)/i.test(text)) {
    return {
      kind: 'generate_plain_explain',
      actionName: 'card.followup.add',
      instruction: text,
      paramsSummary: lang === 'en' ? 'plain explanation (confirm before saving)' : '生成通俗讲解（保存前确认）',
      requiresConfirm: true,
    };
  }

  // 4) Source navigation with optional source index & page number (#1340: require word boundaries and navigation intent)
  const pageNumber = extractInt(text, /(?:第\s*(\d+)\s*页|(?:^|[\s,，(（])p\.?\s*(\d+)\b|\bpage\s*(\d+)\b)/i);
  const sourceOrdinal = extractInt(text, /第\s*(\d+)\s*(?:份|个|篇)?(?:讲义|资料|文档|pdf)/i);
  const isStandalonePageRef = /^(?:第\s*\d+\s*页|p\.?\s*\d+|page\s*\d+)$/i.test(text);
  const hasSourceNavVerb = /(?:跳到?|打开|定位|查看|看看|(?<![观查])看(?:一下)?(?:资料|讲义|原文)|(?<![过失消除省免来])去|\bopen\b|\bgo\s+to\b|\bjump(?:\s+to)?\b)/i.test(text);
  if (
    !conceptualQuestion &&
    (isStandalonePageRef ||
      (hasSourceNavVerb && (pageNumber !== undefined || /资料|讲义|原文|阅读器|source|reader/i.test(text))))
  ) {
    const sources = Array.isArray(ctx.snapshot?.sources) ? ctx.snapshot.sources : [];
    const idx = sourceOrdinal !== undefined ? sourceOrdinal - 1 : 0;
    const picked = sources[idx] ?? sources[0];
    const sourceId = typeof picked?.id === 'string' ? picked.id : undefined;
    const parts: string[] = ['page=sources'];
    if (sourceOrdinal !== undefined) parts.push(`source=#${sourceOrdinal}`);
    if (sourceId) parts.push(`sourceId=${sourceId}`);
    if (pageNumber !== undefined) parts.push(`pageNumber=${pageNumber}`);
    return {
      kind: 'navigate',
      page: 'sources',
      ...(sourceOrdinal !== undefined ? { sourceIndex: idx } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(pageNumber !== undefined ? { pageNumber } : {}),
      actionName: 'navigate(sources)',
      paramsSummary: parts.join(', '),
      requiresConfirm: false,
    };
  }

  // 5) Read-only stats / due summary query
  if (/(查看统计|今日到期|多少题到期|学习概况|show\s+stats|due\s+today)/i.test(text) && !/跳到|去|打开页面/.test(text)) {
    return {
      kind: 'readonly_stats',
      actionName: 'snapshot',
      paramsSummary: '只读统计（0 模型调用）',
      requiresConfirm: false,
    };
  }

  // 5b) Eye-care theme & display density natural-language toggles (Round 96 Track B10)
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

  // 5c) Exam countdown / backward auto-schedule intent -> direct Exam Prep view (Round 96 Track B10)
  if (/(排.*备考计划|按考期倒推|考期倒推|备考排程|冲刺计划|倒计时计划|exam\s+plan|exam\s+countdown|study\s+schedule)/i.test(text)) {
    return {
      kind: 'navigate',
      page: 'examprep',
      actionName: 'navigate(examprep)',
      paramsSummary: lang === 'en' ? 'Exam Prep (countdown plan)' : '备考补习（考期倒推计划）',
      requiresConfirm: false,
    };
  }

  // 6) Direct page navigation (#1340: avoid matching "过去" or conceptual questions)
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

  // 7) Fallback: contextual AI assistant chat (read-only streaming)
  return {
    kind: 'chat',
    actionName: 'assistant.chat',
    instruction: text,
    paramsSummary: lang === 'en' ? 'Current study context' : '当前页面上下文',
    requiresConfirm: false,
  };
}
