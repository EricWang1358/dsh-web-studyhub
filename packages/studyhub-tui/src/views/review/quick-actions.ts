/**
 * Pure Quick Action Strip model for ReviewView (Round 84 Track B3).
 *
 * Groups the 5 highest-frequency per-card actions cleanly at the front:
 *   [t] 带学 · [h] 讲解 · [S] 同类 · [*] 收藏 · [R] 重做
 * followed by contextual secondary tools, keeping narrow screens readable with `按?看全部`.
 */
import type { UiLanguage } from '../../types/contracts.js';

export interface ReviewQuickAction {
  id: string;
  key: string;
  text: string;
  primary?: boolean;
}

export interface BuildQuickActionsOptions {
  lang: UiLanguage;
  isCardFocused: boolean;
  canRubricGrade: boolean;
  canRedo: boolean;
  canAdjustGrade: boolean;
  canAckCorrection: boolean;
  canCoachNudge: boolean;
}

export function buildReviewQuickActions(opts: BuildQuickActionsOptions): ReviewQuickAction[] {
  const { lang, isCardFocused, canRubricGrade, canRedo, canAdjustGrade, canAckCorrection, canCoachNudge } = opts;
  const zh = lang !== 'en';
  return [
    { id: 'h', key: 'h', text: zh ? '[h]讲解' : '[h]Help', primary: true },
    { id: 'T', key: 't', text: zh ? '[t]带学' : '[t]Guided', primary: true },
    { id: 'S', key: 'S', text: zh ? '[S]同类' : '[S]Sim', primary: true },
    { id: '*', key: '*', text: zh ? (isCardFocused ? '[*]已收藏' : '[*]收藏') : isCardFocused ? '[*]Saved' : '[*]Focus', primary: true },
    ...(canRedo ? [{ id: 'R', key: 'R', text: zh ? '[R]重做' : '[R]Redo', primary: true }] : []),
    ...(canRubricGrade ? [{ id: 'G', key: 'G', text: zh ? '[G]评分' : '[G]Grade' }] : []),
    { id: 'A', key: 'A', text: zh ? '[A]答题卡' : '[A]Card' },
    { id: 'W', key: 'W', text: zh ? '[W]翻译' : '[W]Trans' },
    { id: 'D', key: 'D', text: zh ? '[D]工具' : '[D]Tools' },
    { id: 'Q', key: 'Q', text: zh ? '[Q]队列' : '[Q]Queue' },
    { id: 'E', key: 'E', text: zh ? '[E]标记' : '[E]Flag' },
    { id: 's', key: 's', text: zh ? '[s]跳过' : '[s]Skip' },
    { id: 'u', key: 'u', text: zh ? '[u]撤销' : '[u]Undo' },
    { id: 'nav', key: ',/.', text: zh ? '[,/.]换题' : '[,/.]Nav' },
    ...(canAdjustGrade ? [{ id: 'J', key: 'J', text: zh ? '[J]改分' : '[J]Adjust' }] : []),
    ...(canAckCorrection ? [{ id: 'K', key: 'K', text: zh ? '[K]确认订正' : '[K]Ack' }] : []),
    ...(canCoachNudge ? [{ id: 'N', key: 'N', text: zh ? '[N]陪学点拨' : '[N]Nudge' }] : []),
  ];
}
