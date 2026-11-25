import type { UiLanguage } from '../../types/contracts.js';
import type { Tone } from '../../theme/tokens.js';
import { t } from '../../state/store.js';
import type {
  ErrorReasonId,
  RecommendReason,
  WrongBookDetail,
  WrongBookItem,
  WrongBookRecommendItem,
  WrongBookTab,
} from './types.js';

export interface ErrorReasonMeta {
  id: ErrorReasonId;
  zh: string;
  en: string;
  shortZh: string;
  shortEn: string;
  tone: Tone;
}

export const ERROR_REASONS: readonly ErrorReasonMeta[] = Object.freeze([
  { id: 'concept', zh: '概念混淆', en: 'Concept confusion', shortZh: '概念', shortEn: 'Concept', tone: 'warning' },
  { id: 'condition', zh: '漏看条件', en: 'Missed condition', shortZh: '条件', shortEn: 'Cond', tone: 'accent' },
  { id: 'derivation', zh: '推导卡住', en: 'Derivation stuck', shortZh: '推导', shortEn: 'Deriv', tone: 'info' },
  { id: 'slip', zh: '粗心手滑', en: 'Careless slip', shortZh: '手滑', shortEn: 'Slip', tone: 'muted' },
  { id: 'prerequisite', zh: '前置缺失', en: 'Prerequisite gap', shortZh: '前置', shortEn: 'Prereq', tone: 'error' },
  { id: 'bad_question', zh: '题目存疑', en: 'Question issue', shortZh: '存疑', shortEn: 'Issue', tone: 'error' },
]);

export type ReasonFilterValue = 'all' | ErrorReasonId | 'unclassified';

export const REASON_FILTER_ORDER: readonly ReasonFilterValue[] = Object.freeze([
  'all',
  'concept',
  'condition',
  'derivation',
  'slip',
  'prerequisite',
  'bad_question',
  'unclassified',
]);

export const TABS: ReadonlyArray<{ id: WrongBookTab; zh: string; en: string }> = Object.freeze([
  { id: 'all', zh: '全部', en: 'All' },
  { id: 'weak', zh: '待巩固', en: 'To Review' },
  { id: 'confusable', zh: '易混淆', en: 'Confusable' },
  { id: 'reason', zh: '按错因', en: 'By Reason' },
]);

export function errorReasonMeta(id: ErrorReasonId | string | null | undefined): ErrorReasonMeta | null {
  if (!id) return null;
  return ERROR_REASONS.find((r) => r.id === id) ?? null;
}

export function reasonLabel(id: ReasonFilterValue | string | null | undefined, lang: UiLanguage): string {
  if (!id || id === 'unclassified') return t(lang, '未归因', 'Unclassified');
  if (id === 'all') return t(lang, '全部错因', 'All reasons');
  const meta = errorReasonMeta(id);
  return meta ? t(lang, meta.zh, meta.en) : String(id);
}

export function reasonShort(id: ErrorReasonId | string | null | undefined, lang: UiLanguage): string {
  const meta = errorReasonMeta(id);
  if (!meta) return '';
  return t(lang, meta.shortZh, meta.shortEn);
}

export function itemKey(item: Pick<WrongBookItem, 'deckId' | 'cardId' | '_view'>): string {
  return `${item._view}:${item.deckId}:${item.cardId}`;
}

export function plainSnippet(prompt: unknown): string {
  return String(prompt ?? '')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, ' [式] ')
    .replace(/[#>*`_[\]()]/g, ' ')
    .replace(/\{\{[^{}]+\}\}/g, '___')
    .replace(/\s+/g, ' ')
    .trim();
}

export function gradeRatio(grade: number | undefined): number {
  const g = typeof grade === 'number' && Number.isFinite(grade) ? grade : 0;
  return Math.max(0, Math.min(1, g / 5));
}

export function recommendReasonText(reason: RecommendReason, lang: UiLanguage): string {
  switch (reason.type) {
    case 'topic':
      return t(lang, `同主题：${reason.topic ?? ''}`, `Topic: ${reason.topic ?? ''}`);
    case 'page':
      return t(
        lang,
        `引用同页：${reason.sourceTitle ?? ''} 第 ${reason.page ?? ''} 页`,
        `Same page: ${reason.sourceTitle ?? ''} p.${reason.page ?? ''}`,
      );
    case 'near':
      return t(
        lang,
        `引用相邻页：${reason.sourceTitle ?? ''} 第 ${reason.page ?? ''} 页`,
        `Nearby page: ${reason.sourceTitle ?? ''} p.${reason.page ?? ''}`,
      );
    case 'terms':
      return t(
        lang,
        `关键词相近：${(reason.terms ?? []).join('、')}`,
        `Shared terms: ${(reason.terms ?? []).join(', ')}`,
      );
    case 'source':
      return t(lang, `同源资料：${reason.sourceTitle ?? ''}`, `Same source: ${reason.sourceTitle ?? ''}`);
    default:
      return '';
  }
}

export function relatedRecommendations(
  recs: readonly WrongBookRecommendItem[],
  cardId: string,
): WrongBookRecommendItem[] {
  return recs
    .map((rec) => ({ rec, match: rec.matches?.find((m) => m.cardId === cardId) }))
    .filter(({ rec, match }) => Boolean(match) || Boolean(rec.forCardIds?.includes(cardId)))
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .slice(0, 3)
    .map(({ rec, match }) => ({
      ...rec,
      reasons: match?.reasons?.length ? match.reasons : rec.reasons,
    }));
}

export interface TriageActionInfo {
  route: string;
  isZeroToken: boolean;
  lead: string;
  actionLabel: string;
  tone: Tone;
}

export function triageSummary(item: WrongBookItem, lang: UiLanguage): TriageActionInfo {
  const triage = item.triage;
  const route = triage?.route ?? 'fsrs_only';

  switch (route) {
    case 'confusable_contrast': {
      const names = (triage?.confusable?.names ?? []).filter(Boolean);
      const cid = triage?.confusable?.id || 'C001';
      const lead =
        names.length >= 2
          ? t(
              lang,
              `与「${names[0]} / ${names[1]}」易混淆（${cid}），建议先做 0-token 对比辨析`,
              `Confusable with "${names[0]} / ${names[1]}" (${cid}); run 0-token contrast first`,
            )
          : t(
              lang,
              `命中复习全书易混对（${cid}），建议先做 0-token 对比辨析`,
              `Matched confusable pair (${cid}); run 0-token contrast first`,
            );
      return {
        route,
        isZeroToken: true,
        lead,
        actionLabel: t(lang, '打开对比辨析', 'Contrast pair'),
        tone: 'warning',
      };
    }
    case 'book_retell':
      return {
        route,
        isZeroToken: false,
        lead: t(lang, '先回到复习全书对应知识点梳理概念，再回来练习', 'Review the concept in Review Book, then retry'),
        actionLabel: t(lang, '前往复习全书', 'Open Review Book'),
        tone: 'accent',
      };
    case 'prereq_branch': {
      const topic = triage?.prereq?.topic;
      const count = triage?.prereqRefs?.length || (triage?.prereq ? 1 : 0);
      return {
        route,
        isZeroToken: true,
        lead: t(
          lang,
          `检测到 ${count} 道未稳前置题${topic ? `（${topic}）` : ''}，先练前置打牢基础`,
          `${count} unresolved prerequisite(s)${topic ? ` (${topic})` : ''}; practise prerequisites first`,
        ),
        actionLabel: t(lang, '先练前置题', 'Practise prerequisites'),
        tone: 'error',
      };
    }
    case 'fix_question':
      return {
        route,
        isZeroToken: false,
        lead: t(lang, '已标记题目本身存疑，可提交问题标记待修题检查', 'Marked as question issue; flag for repair review'),
        actionLabel: t(lang, '标记待修题', 'Flag for repair'),
        tone: 'error',
      };
    case 'rescue_companion': {
      const focus = triage?.rescueFocus;
      const lead =
        focus === 'condition'
          ? t(lang, '因漏看条件反复失分，建议先回顾题干约束条件后重练', 'Repeated misses on conditions; review constraints & retry')
          : focus === 'derivation'
            ? t(lang, '推导步骤卡顿，建议结合解析拆解关键一步后重练', 'Stuck in derivation; break down key steps & retry')
            : t(lang, '高频反复出错（顽固题），建议结合解析与同类题专项巩固', 'Stubborn mistake; consolidate with explanation & similar cards');
      return {
        route,
        isZeroToken: false,
        lead,
        actionLabel: t(lang, '专项巩固练习', 'Targeted practice'),
        tone: 'ai',
      };
    }
    default:
      return {
        route: 'fsrs_only',
        isZeroToken: true,
        lead: t(lang, '按 FSRS-6 间隔调度复习即可，无需额外重调度', 'Follow standard FSRS-6 spacing; no extra intervention needed'),
        actionLabel: t(lang, '立即重练此题', 'Practise now'),
        tone: 'success',
      };
  }
}

export function buildDetailMarkdown(
  item: WrongBookItem,
  detail: WrongBookDetail | null,
  relatedRecs: readonly WrongBookRecommendItem[],
  lang: UiLanguage,
): string {
  const parts: string[] = [];

  parts.push(`### ${t(lang, '题干', 'Question')}`);
  parts.push(detail?.prompt || item.prompt || t(lang, '（无题干）', '(No prompt)'));

  if (detail) {
    parts.push('');
    parts.push(`### ${t(lang, '作答对比', 'Answer Comparison')}`);
    if (detail.yourAnswer) {
      parts.push(`- **${t(lang, '你的作答', 'Your Answer')}**: ${detail.yourAnswer}`);
    } else if (detail.selfGrade !== null && detail.selfGrade !== undefined) {
      parts.push(`- **${t(lang, '上次自评', 'Last Self-Grade')}**: ${detail.selfGrade} / 5`);
    } else {
      parts.push(`- **${t(lang, '上次评分', 'Last Grade')}**: ${detail.lastGrade ?? item.lastGrade ?? '-'}`);
    }

    if (detail.clozeDetails?.length) {
      const blanks = detail.clozeDetails
        .map((d, idx) => {
          const given = detail.clozeAnswers?.[d.id] || '∅';
          return d.correct
            ? `#${idx + 1}: ✓ ${given}`
            : `#${idx + 1}: ✗ ${given} → ${d.expected ?? ''}`;
        })
        .join('  |  ');
      parts.push(`- **${t(lang, '填空明细', 'Cloze Details')}**: ${blanks}`);
    }

    if (detail.correctAnswer) {
      parts.push(`- **${t(lang, '参考答案', 'Reference Answer')}**: ${detail.correctAnswer}`);
    }

    if (detail.rubric?.items?.length) {
      parts.push(`- **${t(lang, '评分细则', 'Rubric')}**: ${detail.rubric.total ?? 0}/${detail.rubric.max ?? 0}`);
      for (const r of detail.rubric.items) {
        parts.push(`  - ${r.label ?? '-'}: ${r.score ?? 0}/${r.max ?? 0}${r.note ? ` — ${r.note}` : ''}`);
      }
    }

    if (detail.oralFeedback?.reason) {
      parts.push(
        `- **${t(lang, '口头评估', 'Oral Assessment')}**: ${detail.oralFeedback.band ? `[${detail.oralFeedback.band}] ` : ''}${detail.oralFeedback.reason}`,
      );
    }

    if (detail.explanation) {
      parts.push('');
      parts.push(`### ${t(lang, '解析', 'Explanation')}`);
      parts.push(detail.explanation);
    }

    if (detail.misconception) {
      parts.push('');
      parts.push(`### ${t(lang, '常见误区', 'Common Misconception')}`);
      parts.push(`> ${detail.misconception}`);
    }

    if (detail.distractorExplanations?.length) {
      parts.push('');
      parts.push(`### ${t(lang, '误选干扰项分析', 'Distractor Analysis')}`);
      for (const d of detail.distractorExplanations) {
        parts.push(`- **${d.text}**: ${d.explanation}`);
      }
    }
  }

  if (relatedRecs.length > 0) {
    parts.push('');
    parts.push(`### ${t(lang, '0-token 推荐同类题', 'Similar Questions (0-token)')}`);
    for (const rec of relatedRecs) {
      const reasons = (rec.reasons ?? [])
        .map((r) => recommendReasonText(r, lang))
        .filter(Boolean)
        .join(' · ');
      const snippet = plainSnippet(rec.prompt).slice(0, 72);
      parts.push(`- [${rec.deckTitle}] ${snippet}${reasons ? ` *(${reasons})*` : ''}`);
    }
  }

  return parts.join('\n');
}
