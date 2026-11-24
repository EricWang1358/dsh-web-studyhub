/**
 * Deterministic natural-language intent parser for the Persistent AI Assistant (#1315 Phase 1).
 *
 * Strict constraints:
 * - Never invents backend actions — maps exclusively to existing `AppShell` navigation and
 *   `tui-host` actions (`snapshot`, `source.get`, `card.followup.add`, `wrongbook.reason.set`, etc.).
 * - Every write/quota/export action sets `requiresConfirm: true` so the panel always renders a
 *   P2 `ConfirmDialog` preview before execution.
 * - Never hits a dead end: unsupported requests return nearest supported alternative + ready-to-copy prompt.
 * - Concise Chinese/English short phrases — never parrots raw user text.
 */
import type { PageId, StudySnapshot, TuiPreferences, UiLanguage } from '../types/contracts.js';
import type { AssistantCardContext } from '../state/store.js';

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
      requiresConfirm: false;
    }
  | {
      kind: 'write_confirm';
      actionName: 'wrongbook.reason.set' | 'export.wrongbook' | 'review.grade.adjust';
      params: Record<string, unknown>;
      previewTitle: string;
      previewMessage: string;
      paramsSummary: string;
      requiresConfirm: true;
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

export interface ParseIntentContext {
  snapshot?: StudySnapshot | null;
  currentCardId?: string | null;
  currentDeckId?: string | null;
  lang?: UiLanguage;
}

const PAGE_PATTERNS: ReadonlyArray<{ page: PageId; re: RegExp; zh: string; en: string }> = [
  { page: 'sources', re: /资料库|资料页|讲义|原文|阅读器|\bsources?\b|\breader\b/i, zh: '资料', en: 'Sources' },
  { page: 'wrongbook', re: /错题本|错题|\bmistakes?\b|\bwrongbook\b/i, zh: '错题本', en: 'Mistakes' },
  { page: 'dashboard', re: /统计|仪表盘|学习进度|\bstats\b|\bdashboard\b/i, zh: '学习统计', en: 'Stats' },
  { page: 'library', re: /学习库|题组列表|首页|\blibrary\b/i, zh: '学习库', en: 'Library' },
  { page: 'generate', re: /创建题组|草稿|出题页|\bgenerate\b/i, zh: '创建题组', en: 'Generate' },
  { page: 'exam', re: /模拟考|考试页|\bmock\s*exam\b/i, zh: '模拟考试', en: 'Mock Exam' },
  { page: 'book', re: /复习全书|全书|\breview\s*book\b/i, zh: '复习全书', en: 'Review Book' },
  { page: 'skeleton', re: /知识骨架|骨架|\bskeleton\b/i, zh: '知识骨架', en: 'Skeleton' },
  { page: 'examcoach', re: /考试教练|教练|\bexam\s*coach\b/i, zh: '考试教练', en: 'Exam Coach' },
  { page: 'examprep', re: /备考补习|备考|\bexam\s*prep\b/i, zh: '备考补习', en: 'Exam Prep' },
  { page: 'notes', re: /学习笔记|笔记页|\bnotes\b/i, zh: '学习笔记', en: 'Notes' },
  { page: 'board', re: /待办看板|看板|番茄钟|\bboard\b/i, zh: '待办看板', en: 'Board' },
  { page: 'tasks', re: /后台任务|任务页|\bjobs\b|\btasks\b/i, zh: '后台任务', en: 'Tasks' },
  { page: 'audio', re: /音频转写|音频|\baudio\b/i, zh: '音频转写', en: 'Audio' },
  { page: 'settings', re: /设置|模型配置|\bsettings\b/i, zh: '设置', en: 'Settings' },
  { page: 'review', re: /刷题|继续练习|回(?:到)?(?:原)?题|\breview\b/i, zh: '刷题复习', en: 'Review' },
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
    re: /(?:^|(?:帮我|请|替我|给我|把.{0,12}))(?:发(?:送)?邮件|发微信|群发)|(?:发(?:送)?邮件|发微信|发(?:送)?消息|推送)给|给.{1,10}发(?:送)?(?:邮件|微信|消息)|(?:帮我|请|替我)(?:发(?:送)?消息|(?:用|通过)\s*(?:wechat|slack|telegram)\s*发)|\b(?:send|post|push)\s+(?:an?\s+)?(?:email|message)\s+(?:to|via|on)\b|\b(?:send|post|push)\s+(?:to|via|on)\s+(?:wechat|slack|telegram)\b/i,
    reasonZh: '当前终端不支持外部通信发送。',
    reasonEn: 'External messaging is not supported in TUI.',
    altLabelZh: '改为：导出本课错题 Markdown 后手动分享',
    altLabelEn: 'Alternative: export wrongbook Markdown to share',
    altCmd: '导出本课错题 Markdown',
  },
  {
    re: /删掉整个硬盘|清空电脑|格式化\s*(?:整个|我的)?\s*(?:硬盘|磁盘|电脑|系统|分区|[a-zA-Z]\s*盘|U\s*盘|驱动器)|(?:^|(?:帮我|请|立即|直接)\s*)执行\s*shell|跑系统命令|(?:^|(?:帮我|请)\s*)(?:执行|运行)\s*rm\s+-rf|^rm\s+-rf|\bformat\s+(?:my\s+|the\s+)?(?:disk|drive|hard\s*drive|system|c:)/i,
    reasonZh: '安全限制：助手仅执行 StudyHub 学习动作，不操作系统文件。',
    reasonEn: 'Safety guard: assistant only runs StudyHub study actions.',
    altLabelZh: '改为：查看学习库统计概况',
    altLabelEn: 'Alternative: view library stats',
    altCmd: '查看统计',
  },
  {
    re: /联网搜索|查.{0,4}天气|买机票|订外卖|点餐|search\s+google|weather/i,
    reasonZh: '当前助手聚焦本地学习库，不支持外部联网服务。',
    reasonEn: 'Assistant is scoped to your local study library.',
    altLabelZh: '改为：打开资料库检索本地讲义',
    altLabelEn: 'Alternative: open Sources to search local materials',
    altCmd: '跳到资料库',
  },
];

const SOURCE_NAV_VERB_RE =
  /(?:跳(?:转)?(?:到)?|打开|翻到|翻看|定位(?:到)?|前往|查看|(?<![过出下上失消省除减])去(?:到)?(?=(?:第\s*\d+|资料|讲义|原文|阅读器|sources?|reader))|\b(?:open|go\s+to|jump(?:\s+to)?|goto)\b)/i;

const PAGE_NAV_VERB_RE =
  /(?:跳到|跳转(?:到)?|打开|进入|切到|切换到|回到|返回(?:到)?|前往|(?<![过出下上失消省除减])去(?:到)?(?=(?:资料|讲义|原文|阅读器|错题|统计|仪表盘|学习|题组|首页|创建|模拟考|考试|复习全书|全书|知识骨架|骨架|教练|备考|笔记|看板|任务|音频|设置|刷题|原题|sources?|reader|mistakes?|wrongbook|stats|dashboard|library|generate|mock\s*exam|review|book|skeleton|exam|notes|board|jobs|tasks|audio|settings))|\b(?:open|go\s+to|jump\s+to|switch\s+to|goto)\b)/i;

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

  // 0) Unsupported out-of-scope actions -> nearest alternative + copy-prompt fallback (never dead-end!)
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

  if (/(加入错题|标记(?:为)?错因|错因(?:标|设)为|mark.*mistake|wrongbook.*reason)/i.test(text)) {
    const reasonMatch = text.match(/(?:标记为|错因(?:标|设)?为|原因[:：]?\s*)([^\s，。,.;；]+)/);
    const reason = reasonMatch?.[1]?.trim() || '粗心';
    return {
      kind: 'write_confirm',
      actionName: 'wrongbook.reason.set',
      params: {
        ...(ctx.currentDeckId ? { deckId: ctx.currentDeckId } : {}),
        ...(ctx.currentCardId ? { cardId: ctx.currentCardId } : {}),
        reason,
      },
      previewTitle: lang === 'en' ? 'Confirm Mark Wrong Reason' : '确认标记错题原因',
      previewMessage:
        lang === 'en'
          ? `Will run: wrongbook.reason.set (cardId=${ctx.currentCardId ?? 'current'}, reason="${reason}")`
          : `将执行：wrongbook.reason.set（题目=${ctx.currentCardId ?? '当前题'}，错因=${reason}）`,
      paramsSummary: `cardId=${ctx.currentCardId ?? '当前题'}, reason=${reason}`,
      requiresConfirm: true,
    };
  }

  // 3) Single-step generation: plain explanation & save
  if (/(通俗讲解|大白话讲|讲解新增|重新讲解|换个例子讲|plain\s+explain|add.*explanation)/i.test(text)) {
    return {
      kind: 'generate_plain_explain',
      actionName: 'card.followup.add',
      instruction: text,
      paramsSummary: `cardId=${ctx.currentCardId ?? '当前题'}, save=card.followup.add`,
      requiresConfirm: false,
    };
  }

  // 4) Source navigation with optional source index & page number
  const pageNumber = extractInt(text, /(?:第\s*(\d+)\s*页|(?<![a-z0-9_])p\.\s*(\d+)\b|(?<![a-z0-9_])p(\d+)\b|\bpage\s*(\d+)\b)/i);
  const sourceOrdinal = extractInt(text, /第\s*(\d+)\s*(?:份|个|篇)?(?:讲义|资料|文档|pdf)/i);
  const hasSourceNavVerb = SOURCE_NAV_VERB_RE.test(text);
  const hasSourceNoun = /资料|讲义|原文|阅读器|\bsources?\b|\breader\b/i.test(text);
  if (hasSourceNavVerb && (pageNumber !== undefined || hasSourceNoun)) {
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

  // 6) Direct page navigation
  if (PAGE_NAV_VERB_RE.test(text)) {
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
    paramsSummary: ctx.currentCardId ? `cardId=${ctx.currentCardId}` : '当前页面上下文',
    requiresConfirm: false,
  };
}
