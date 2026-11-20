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
    case 'companion_open':
      if (hint.lessonMode === 'rescue') return ui('还差：打开 4 页交互实验');
      return hint.slide >= 1
        ? uiFormat('还差：打开交互伴学第 {0} 页', [hint.slide])
        : ui('还差：打开交互伴学巩固');
    case 'rescue_experiment':
      return ui('还差：做一个 4 页交互实验');
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

/**
 * Resolve the conditional Review Book header hint (`还差：……`) for a knowledge point (§2.1, §3.3.3):
 * - Preserves `prereq` jumps unchanged.
 * - If a linked `hid` companion already exists (or a rescue companion just finished building), routes straight to its `#slide` anchor.
 * - If the point is `shaky` with unverified comprehension (or has stubborn cards) and no companion yet, upgrades the hint to launch a 4-slide rescue experiment.
 * - Returns `null` on solid/healthy points (never adds persistent controls).
 */
export function resolveBookGapHint(evidence, { linkedCompanion = null, rescueState = null, hasStubborn = false } = {}) {
  if (rescueState?.status === 'ready' && rescueState.companionId) {
    return {
      kind: 'companion_open',
      hid: evidence?.hid || rescueState.hid || '',
      companionId: rescueState.companionId,
      course: rescueState.course || '',
      slide: 1,
      anchor: '#1',
      companionTitle: rescueState.title || '',
      lessonMode: 'rescue',
    };
  }
  const base = evidence?.gapHint ?? null;
  if (!base) return null;
  if (base.kind === 'prereq') return base;
  if (linkedCompanion?.companionId) {
    return {
      ...base,
      kind: 'companion_open',
      companionId: linkedCompanion.companionId,
      course: linkedCompanion.course || '',
      slide: linkedCompanion.slide || 0,
      anchor: linkedCompanion.anchor || '',
      companionTitle: linkedCompanion.companionTitle || '',
      ...(linkedCompanion.lessonMode ? { lessonMode: linkedCompanion.lessonMode } : {}),
    };
  }
  const shakyRescue = evidence?.overall === 'shaky'
    && (hasStubborn || ((base.kind === 'weak_cards' || base.kind === 'retell_gap') && evidence?.facets?.comprehension !== 'verified'));
  if (shakyRescue) {
    return { ...base, kind: 'rescue_experiment' };
  }
  return base;
}
