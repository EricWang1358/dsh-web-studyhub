/**
 * Unified Feynman Retell & Book AI evaluation / rendering helpers (#1354 P3 Wave 2).
 *
 * Converges the duplicated retell & book-explain logic previously scattered across:
 * - `views/review/RetellModal.tsx` (`teach.retell`)
 * - `views/book/BookRetellModal.tsx` (`book.retell`)
 * - `views/book/BookExplainModal.tsx` (`generation.courseBook.explain`)
 *
 * Zero React / `marked` dependencies so every lazy modal chunk stays isolated.
 */
import type { HostClient, UiLanguage } from '../types/contracts.js';
import {
  describeAiDialogueError,
  isModelUnavailableError,
  type UnifiedRetellVerdict,
} from './ai-dialogue.js';
import { tryAction } from './sample-actions.js';

export const RETELL_TEXT_MAX = 4000;

export type RetellVerdictTier = 'pass' | 'partial' | 'gap';
export type RetellVerdictSurface = 'card' | 'book';

export interface RetellCitationTarget {
  sourceId: string;
  title?: string;
  pageNumber?: number;
}

export interface BookExplainJobResult {
  jobId?: string;
  status?: string;
  blockId?: string;
}

export interface BookExplainPayload {
  course: string;
  heading: string;
  mode: 'here' | 'explain';
  language: UiLanguage;
  instruction?: string;
  words?: string;
}

/**
 * Safely normalize a raw retell verdict payload from either `teach.retell` or `book.retell`.
 * Prevents crashes when a backend/mock omits optional arrays (`right`, `missed`, `wrong`, `gap`).
 */
export function normalizeRetellVerdict(
  raw: Partial<UnifiedRetellVerdict> | null | undefined,
): UnifiedRetellVerdict {
  const v = raw ?? {};
  const right = Array.isArray(v.right) ? v.right.map((item) => String(item)) : [];
  const missed = Array.isArray(v.missed) ? v.missed.map((item) => String(item)) : [];
  const wrong = Array.isArray(v.wrong) ? v.wrong.map((item) => String(item)) : [];
  const gap: UnifiedRetellVerdict['gap'] =
    v.gap === 'wrong' || v.gap === 'missed' || v.gap === 'none'
      ? v.gap
      : wrong.length > 0
        ? 'wrong'
        : missed.length > 0
          ? 'missed'
          : 'none';
  return {
    passed: Boolean(v.passed),
    right,
    missed,
    wrong,
    cite: typeof v.cite === 'number' && Number.isInteger(v.cite) ? v.cite : null,
    gap,
    ...(v.record ? { record: v.record } : {}),
  };
}

/** Single canonical verdict tier classifier shared by `RetellModal` and `BookRetellModal`. */
export function classifyRetellVerdict(
  verdict: UnifiedRetellVerdict | null | undefined,
): RetellVerdictTier | null {
  if (!verdict) return null;
  if (verdict.gap === 'wrong' || verdict.wrong.length > 0) return 'gap';
  if (verdict.passed && verdict.gap === 'none') return 'pass';
  return 'partial';
}

/** Canonical badge tone & localized label (ASCII-safe when `asciiMode` is enabled). */
export function retellVerdictBadge(
  tier: RetellVerdictTier,
  opts: { surface: RetellVerdictSurface; lang: UiLanguage; asciiMode: boolean },
): { label: string; tone: 'success' | 'error' | 'warning' } {
  const { surface, lang, asciiMode } = opts;
  const en = lang === 'en';
  if (tier === 'pass') {
    if (surface === 'book') {
      return {
        tone: 'success',
        label: en
          ? asciiMode ? '+ Retold (Pass)' : '✓ Retold · Pass'
          : asciiMode ? '+ 讲清楚过 (通过)' : '✓ 讲清楚过 · 通过',
      };
    }
    return {
      tone: 'success',
      label: asciiMode ? '+ Pass' : en ? '✓ Pass' : '✓ 通过 · Pass',
    };
  }
  if (tier === 'gap') {
    if (surface === 'book') {
      return {
        tone: 'error',
        label: en
          ? asciiMode ? 'x Gap' : '✕ Gap'
          : asciiMode ? 'x 存在偏差 (Gap)' : '✕ 存在偏差 · Gap',
      };
    }
    return {
      tone: 'error',
      label: asciiMode ? 'x Gap' : en ? '✕ Gap' : '✕ 存在偏差 · Gap',
    };
  }
  if (surface === 'book') {
    return {
      tone: 'warning',
      label: en
        ? asciiMode ? '! Partial' : '▲ Partial'
        : asciiMode ? '! 遗漏要点 (Partial)' : '▲ 遗漏要点 · Partial',
    };
  }
  return {
    tone: 'warning',
    label: asciiMode ? '! Partial' : en ? '▲ Partial' : '▲ 部分掌握 · Partial',
  };
}

/**
 * Single canonical Markdown renderer for Feynman retell verdicts across card & book modals.
 * Preserves each surface's learner contract (book 3-part sections + raw-wording privacy note;
 * card hints + source citation jump).
 */
export function formatRetellVerdictMarkdown(
  verdict: UnifiedRetellVerdict,
  opts: {
    surface: RetellVerdictSurface;
    lang: UiLanguage;
    cardHint?: string;
    targetCitation?: RetellCitationTarget | null;
    citedQuote?: string;
  },
): string {
  const { surface, lang, cardHint, targetCitation, citedQuote } = opts;
  const en = lang === 'en';
  const tier = classifyRetellVerdict(verdict);
  const lines: string[] = [];

  if (surface === 'book') {
    const tierHeadline =
      tier === 'pass'
        ? en
          ? 'Solid explanation — you captured the core mechanism clearly.'
          : '已抓住核心机制，用自己的话讲清楚了！'
        : tier === 'gap'
          ? en
            ? 'Contains a claim that contradicts the book note. Review the corrections below.'
            : '存在与讲义相矛盾的表述，请对照下方纠偏后再试一次。'
          : en
            ? 'Right direction, with a few key points left out.'
            : '方向正确，但遗漏了部分关键要点，建议补充后再讲一遍。';

    lines.push(`> ${tierHeadline}`);
    lines.push('');

    lines.push(`### ${en ? '1. What You Got Right' : '1. 讲对了'}`);
    if (verdict.right.length > 0) {
      for (const item of verdict.right) lines.push(`- ${item}`);
    } else {
      lines.push(
        `- ${en ? 'No key points matched yet; check the missing items and tip below.' : '暂未匹配到明确得分要点，请参考下方遗漏与提示补充。'}`,
      );
    }

    lines.push('');
    lines.push(`### ${en ? '2. Missing & Needs Correction' : '2. 遗漏与需纠正'}`);
    if (verdict.missed.length === 0 && verdict.wrong.length === 0) {
      lines.push(`- ${en ? 'No missing points or misconceptions.' : '无明显遗漏或理解偏差。'}`);
    } else {
      for (const item of verdict.missed) {
        lines.push(`- **${en ? 'Missing' : '遗漏'}**: ${item}`);
      }
      for (const item of verdict.wrong) {
        lines.push(`- **${en ? 'Correction' : '纠偏'}**: ${item}`);
      }
    }

    lines.push('');
    lines.push(`### ${en ? '3. Tip & Next Step' : '3. 下一步提示'}`);
    if (tier === 'pass') {
      lines.push(
        `- ${en ? 'Marked as Retold. Try summarizing its boundary condition or a counterexample to lock it in.' : '本节已记为「讲清楚过」。试着用一句话总结它的适用边界或反例，记忆会更牢固。'}`,
      );
    } else if (tier === 'gap') {
      lines.push(
        `- ${en ? 'Focus on fixing the misconception above, then press [r] or [i] to re-explain.' : '先聚焦纠正偏差点，按 [r] 或 [i] 修改后再讲一遍。'}`,
      );
    } else {
      lines.push(
        `- ${en ? 'Fill in the missing causal links above, then press [r] or [i] to refine.' : '围绕上方遗漏要点补全因果链条，按 [r] 或 [i] 再讲一遍。'}`,
      );
    }
    lines.push(
      `- ${en ? 'Your raw wording is never saved — only the Retold pass/gap summary is stored.' : '你的复述原话不会被保存，仅更新本节的「讲清楚过」汇总状态。'}`,
    );
    return lines.join('\n');
  }

  // Card retell surface (`RetellModal`)
  const tierHeadline =
    tier === 'pass'
      ? en
        ? 'Solid explanation — you captured the core mechanism accurately.'
        : '已抓准核心机制，用自己的话讲清楚了！'
      : tier === 'gap'
        ? en
          ? 'Contains a contradiction with the source material. Review the corrections below.'
          : '存在与材料相矛盾的表述，建议对照下方纠偏后再复述一次。'
        : en
          ? 'Right direction, with a few key points left out.'
          : '方向正确，但遗漏了部分关键要点，建议补充后巩固。';

  lines.push(`> ${tierHeadline}`);
  lines.push('');

  lines.push(`### ${en ? 'What You Got Right' : '讲对了'}`);
  if (verdict.right.length > 0) {
    for (const item of verdict.right) lines.push(`- ${item}`);
  } else {
    lines.push(
      `- ${en ? 'No key points matched yet; check the hints below.' : '暂未匹配到明确得分要点，请参考下方提示补充。'}`,
    );
  }

  if (verdict.missed.length > 0) {
    lines.push('');
    lines.push(`### ${en ? 'Missing Points' : '遗漏要点'}`);
    for (const item of verdict.missed) lines.push(`- ${item}`);
  }

  if (verdict.wrong.length > 0) {
    lines.push('');
    lines.push(`### ${en ? 'Confused / Needs Correction' : '理解偏差 / 需纠正'}`);
    for (const item of verdict.wrong) lines.push(`- ${item}`);
  }

  const hintItems: string[] = [];
  if (cardHint) hintItems.push(cardHint);
  if (tier === 'pass') {
    hintItems.push(
      en
        ? 'Try summarizing its boundary condition or counterexample to lock it in.'
        : '试着用一句话总结它的适用边界或反例，记忆会更牢固。',
    );
  } else if (tier === 'gap') {
    hintItems.push(
      en
        ? 'Focus on fixing the misconception above, then press [r] or [i] to re-explain.'
        : '先聚焦纠正偏差点，按 [r] 或 [i] 重新组织语言再讲一遍。',
    );
  } else {
    hintItems.push(
      en
        ? 'Fill in the missing causal links above, then press [r] or [i] to refine.'
        : '围绕上方遗漏要点补全因果链条，按 [r] 或 [i] 再讲一遍。',
    );
  }
  lines.push('');
  lines.push(`### ${en ? 'Model Hint' : '模型提示'}`);
  for (const h of hintItems) lines.push(`- ${h}`);

  if (targetCitation) {
    const pageLabel =
      targetCitation.pageNumber != null
        ? en ? `p.${targetCitation.pageNumber}` : `第 ${targetCitation.pageNumber} 页`
        : '';
    const srcLabel = `${targetCitation.title ? `${targetCitation.title} ` : ''}${pageLabel}`.trim();
    lines.push('');
    lines.push(`### ${en ? 'Source Citation' : '原文定位'}`);
    lines.push(
      `- ${srcLabel || targetCitation.sourceId} (${en ? 'press [o] to open source' : '按 [o] 跳转原文阅读'})`,
    );
    if (citedQuote) {
      lines.push(`> "${citedQuote}"`);
    }
  }

  return lines.join('\n');
}

/** Unified Review-Book Feynman retell submission via `book.retell`, matching `submitRetellEvaluation`. */
export async function submitBookRetellEvaluation(
  host: HostClient,
  params: {
    course?: string | null;
    hid: string;
    text: string;
    language: UiLanguage;
  },
): Promise<{ ok: true; verdict: UnifiedRetellVerdict } | { ok: false; error: string; isModelError: boolean }> {
  try {
    const res = await tryAction<Partial<UnifiedRetellVerdict>>(host, 'book.retell', {
      ...(params.course ? { course: params.course } : {}),
      hid: params.hid,
      text: params.text,
      language: params.language,
    });
    if (!res.ok || !res.value) {
      const rawMsg = res.error?.message?.trim() ?? '';
      const error = describeAiDialogueError(rawMsg || res.error, params.language);
      return {
        ok: false,
        error,
        isModelError: !rawMsg || rawMsg === 'Unknown error' || isModelUnavailableError(rawMsg),
      };
    }
    return { ok: true, verdict: normalizeRetellVerdict(res.value) };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err ?? '');
    return {
      ok: false,
      error: describeAiDialogueError(err, params.language),
      isModelError: !rawMsg || rawMsg === 'Unknown error' || isModelUnavailableError(rawMsg),
    };
  }
}

/** Unified Review-Book AI explain job submission via `generation.courseBook.explain`. */
export async function submitBookExplainJob(
  host: HostClient,
  payload: BookExplainPayload | Record<string, unknown>,
): Promise<{ ok: true; value: BookExplainJobResult } | { ok: false; error: string; isModelError: boolean }> {
  const lang: UiLanguage = payload.language === 'en' ? 'en' : 'zh';
  try {
    const res = await tryAction<BookExplainJobResult>(host, 'generation.courseBook.explain', { ...payload });
    if (!res.ok || !res.value) {
      const rawMsg = res.error?.message?.trim() ?? '';
      const error = describeAiDialogueError(rawMsg || res.error, lang);
      return {
        ok: false,
        error,
        isModelError: !rawMsg || rawMsg === 'Unknown error' || isModelUnavailableError(rawMsg),
      };
    }
    return { ok: true, value: res.value };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err ?? '');
    return {
      ok: false,
      error: describeAiDialogueError(err, lang),
      isModelError: !rawMsg || rawMsg === 'Unknown error' || isModelUnavailableError(rawMsg),
    };
  }
}
