import { ui, uiFormat } from './i18n.js';

/* Conditional one-sentence next-step hint for weak or exam-near knowledge points (§2.1, §3.1.3).
   Pure UI copy: never names internal facet dimensions, never shows percentages, never contradicts card "mastered". */

export function gapHintLabel(hint) {
  if (!hint || typeof hint !== 'object') return '';
  switch (hint.kind) {
    case 'prereq':
      return hint.targetTitle
        ? uiFormat('还差：先练前置「{0}」', [hint.targetTitle])
        : ui('还差：先练前置知识点');
    case 'weak_cards':
      return ui('还差：重练薄弱题');
    case 'exam_slip':
      return ui('还差：考前会掉，先巩固一遍');
    case 'retell_gap':
      return ui('还差：上次讲解有漏，再讲一遍');
    case 'assisted_only':
      return ui('还差：不看提示独立做一遍');
    case 'retell':
      return ui('还差：没用自己的话讲过');
    case 'transfer':
      return ui('还差：独立做一道未见题');
    case 'practice':
      return ui('还差：做几道题巩固');
    default:
      return '';
  }
}
