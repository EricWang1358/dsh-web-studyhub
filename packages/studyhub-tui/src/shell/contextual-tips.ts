/**
 * Context-aware quiet usage tips for the right empty area of the bottom KeyHintBar (#1317).
 *
 * Design rules:
 * - Pure deterministic selector: zero LLM calls, zero network, zero timers/animations.
 * - Aligns with the web plugin's `ui/guidance/practice-tips.js` moments (never during exams,
 *   never suggests AI features when no model is ready, honors the user's `proactiveHints` switch).
 * - Derives shortcut key labels from the live keymap (`buildReviewQuickActions` / `PAGE_REGISTRY`)
 *   so keybinding changes propagate automatically.
 * - Rotates quietly on card changes or every 10 keystrokes.
 */
import { PAGE_REGISTRY, type PageId, type UiLanguage } from '../types/contracts.js';
import type { AssistantCardContext } from '../state/store.js';
import { buildReviewQuickActions } from '../views/review/quick-actions.js';

export interface ContextualTip {
  id: string;
  key: string;
  text: string;
}

export interface ContextualTipInput {
  page: PageId;
  card?: AssistantCardContext | null;
  modelReady: boolean;
  proactiveHints?: boolean;
  lang: UiLanguage;
  asciiMode?: boolean;
  /** Monotonic rotation seed (e.g. cardIndex + Math.floor(keystrokes / 10)). */
  rotation?: number;
}

function reviewKey(id: string, fallback: string): string {
  const actions = buildReviewQuickActions({
    lang: 'zh',
    isCardFocused: false,
    canRubricGrade: true,
    canRedo: true,
    canAdjustGrade: false,
    canAckCorrection: false,
    canCoachNudge: false,
  });
  return actions.find((a) => a.id === id)?.key ?? fallback;
}

function pageKey(id: PageId, fallback: string): string {
  return PAGE_REGISTRY.find((p) => p.id === id)?.shortcut ?? fallback;
}

const KEYS = {
  help: reviewKey('h', 'h'),
  guided: reviewKey('T', 't'),
  similar: reviewKey('S', 'S'),
  focus: reviewKey('*', '*'),
  skip: reviewKey('s', 's'),
  teach: 'L',
  retell: 'F',
  source: 'o',
  settings: pageKey('settings', ','),
  wrongbook: pageKey('wrongbook', '4'),
  sources: pageKey('sources', '2'),
  generate: pageKey('generate', '3'),
} as const;

export function selectContextualTip(input: ContextualTipInput): ContextualTip | null {
  if (input.proactiveHints === false) return null;
  const zh = input.lang !== 'en';
  const rot = Math.max(0, Math.floor(Number(input.rotation ?? 0) || 0));

  if (input.page === 'review') {
    const card = input.card;
    if (card?.isExam) return null;

    // Model not configured: never suggest AI-only tools; guide user to Settings.
    if (!input.modelReady) {
      return {
        id: 'review.no-model',
        key: KEYS.settings,
        text: zh
          ? `还没配模型？按 [${KEYS.settings}] 设置连接模型，解锁 AI 讲解与带学`
          : `No AI model yet? Press [${KEYS.settings}] Settings to connect one`,
      };
    }

    const candidates: ContextualTip[] = [];

    if (card?.revealed && card.isWrong) {
      // Mirrors `practice.help-first` from ui/guidance/practice-tips.js
      candidates.push({
        id: 'practice.help-first',
        key: KEYS.help,
        text: zh
          ? `没懂或答错了？按 [${KEYS.help}] 让 AI 帮我分析错在哪`
          : `Missed this one? Press [${KEYS.help}] for AI mistake analysis`,
      });
      if (card.hasCitation) {
        candidates.push({
          id: 'review.wrong.source',
          key: KEYS.source,
          text: zh
            ? `想对照原讲义核实？按 [${KEYS.source}] 跳转出处页`
            : `Want to check the source page? Press [${KEYS.source}] to open citation`,
        });
      }
      candidates.push({
        id: 'review.wrong.similar',
        key: KEYS.similar,
        text: zh
          ? `容易混淆？按 [${KEYS.similar}] 找同类题对比练`
          : `Easy to confuse? Press [${KEYS.similar}] for similar questions`,
      });
    } else if (card?.revealed) {
      candidates.push({
        id: 'review.right.retell',
        key: KEYS.retell,
        text: zh
          ? `想确认自己真懂了？按 [${KEYS.retell}] 用自己的话复述一遍`
          : `Check true mastery? Press [${KEYS.retell}] to explain in your own words`,
      });
      candidates.push({
        id: 'review.right.focus',
        key: KEYS.focus,
        text: zh
          ? `这道题很关键？按 [${KEYS.focus}] 标为重点题`
          : `Important question? Press [${KEYS.focus}] to mark as focus`,
      });
      if (card.hasCitation) {
        candidates.push({
          id: 'review.right.source',
          key: KEYS.source,
          text: zh
            ? `想看这道题出自哪页？按 [${KEYS.source}] 跳转原文`
            : `See where this came from? Press [${KEYS.source}] to open source`,
        });
      }
    } else {
      // Unanswered question
      candidates.push({
        id: 'review.stuck.teach',
        key: KEYS.teach,
        text: zh
          ? `这道题不太会？试试一步步带学：按 [${KEYS.teach}]`
          : `Not sure yet? Try step-by-step Socratic teach: press [${KEYS.teach}]`,
      });
      candidates.push({
        id: 'review.stuck.hint',
        key: KEYS.help,
        text: zh
          ? `想先看一点思路提示？按 [${KEYS.help}] 打开 AI 讲解`
          : `Need a conceptual hint first? Press [${KEYS.help}] for AI tutor`,
      });
      candidates.push({
        id: 'review.stuck.guided',
        key: KEYS.guided,
        text: zh
          ? `想边看题边带学复述？按 [${KEYS.guided}] 打开带学面板`
          : `Want guided study & retell? Press [${KEYS.guided}] for Guided panel`,
      });
      candidates.push({
        id: 'review.stuck.skip',
        key: KEYS.skip,
        text: zh
          ? `暂时卡住？按 [${KEYS.skip}] 先跳过做下一题`
          : `Stuck for now? Press [${KEYS.skip}] to skip to the next card`,
      });
    }

    if (candidates.length === 0) return null;
    const cardOffset = typeof card?.cardIndex === 'number' && Number.isFinite(card.cardIndex) ? Math.max(0, card.cardIndex) : 0;
    return candidates[(cardOffset + rot) % candidates.length] ?? null;
  }

  if (!input.modelReady) {
    return {
      id: 'shell.no-model',
      key: KEYS.settings,
      text: zh
        ? `离线功能照常可用；按 [${KEYS.settings}] 可连接 AI 模型`
        : `Offline tools ready; press [${KEYS.settings}] to connect an AI model`,
    };
  }

  if (input.page === 'sources') {
    return {
      id: 'sources.tip',
      key: 'i',
      text: zh
        ? '想导入讲义出题？按 [i] 导入 PDF/MD，或按 [Enter] 阅读'
        : 'Import slides/notes with [i], or press [Enter] to read',
    };
  }
  if (input.page === 'wrongbook') {
    return {
      id: 'wrongbook.tip',
      key: 'Q',
      text: zh
        ? '想快速清掉高频错题？按 [Q] 一键练最高频薄弱簇'
        : 'Press [Q] to drill your most frequent mistake cluster',
    };
  }
  if (input.page === 'generate') {
    return {
      id: 'generate.tip',
      key: 'Space',
      text: zh
        ? '勾选讲义 [Space] 后按 Ctrl+S 即可生成题组草稿'
        : 'Select materials with [Space], then Ctrl+S to generate a draft',
    };
  }

  return null;
}
