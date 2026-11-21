/* The words of 出题方式 on the main path of 创建题组 (lib/generation-presets.js): the presets, the names of the depths, and the rough cost beside them. The facts
   (which cell a preset is, what a depth runs) are the lib module's; only the wording is here, once. What 出题深度 says in 更多选项 and in 设置 is
   ui/presets/depth-copy.js: those words arrive with their own chunks, not with the workspace's first load. */
import { ui, uiFormat } from '../i18n.js';
import { levelLabel } from '../coverage/copy.js';
import { DENSITIES, DEPTHS } from '../../lib/generation-presets.js';
import { cellKey } from './cost.js';
import { depthLabel } from './depth-label.js';

export { depthLabel };
/** A preset in words: each preset is named after its depth. */
export const presetLabel = (id) => depthLabel(id);

/** One line under the presets: what the chosen one does. */
export function presetNote(id) {
  return ({
    quick: ui('快问：精简题量，一次写完，一个知识点一道短题；最省。'),
    scenario: ui('情境题（默认）：标准题量，一次写完，每题一个短情境，关键条件决定答案。'),
    blueprint: ui('逐题精出：标准题量，先定考点和答案再出题，分批审阅修复；更慢更费，题更综合。'),
  })[id] || '';
}

/** The line for a combination that is no preset: what it is and where it is changed. With a typed number of questions it says that number, not a level. */
export const customNote = (cell) => uiFormat('自定义：{0} × {1}。在「更多选项 › 出题方式与题量」里改。',
  [cell.count > 0 ? uiFormat('{0} 题', [cell.count]) : levelLabel(cell.density), depthLabel(cell.depth)]);

/** Why the depth does nothing for these question types (the same rule 设置 says for 出题深度). */
export const depthOffReason = () => ui('快问和情境题只用于单选题；选了其他题型时总是逐题精出，只有题量（覆盖强度）起作用。');

/** A cost ratio as the form says it: 「约 ×0.6」; the default cell itself is 「×1」; nothing without a ratio. `bare` leaves out 「约」 where the heading already says
    the costs are rough (the matrix, whose narrow cells have no room for it at 320 px). */
export function ratioText(ratio, { base = false, bare = false } = {}) {
  if (base) return '×1';
  if (!(ratio > 0)) return '';
  const rounded = ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio);
  // Under 0.05 it would round to 「×0」, which reads as free.
  if (rounded === 0) return bare ? '<×0.1' : ui('不到 ×0.1');
  return bare ? `×${rounded}` : uiFormat('约 ×{0}', [rounded]);
}

/** The questions an estimate plans, short: 「26–33 题」 for a range (one pass), 「28 题」 for one number. */
export function questionsText(coverage) {
  if (!(coverage?.goal > 0)) return '';
  return Number.isInteger(coverage.goalLow) && coverage.goalLow >= 1 && coverage.goalLow < coverage.goal
    ? uiFormat('{0}–{1} 题', [coverage.goalLow, coverage.goal]) : uiFormat('{0} 题', [coverage.goal]);
}

/** The words before the rough costs, and their explanation. */
export const costLead = () => ui('大致花费');
export const costTip = () => ui('按你选的资料，用出题前的 token 预估上限算出整次出题相对「情境题」的倍数；括号里是其他几种大约出多少题（选中那种的题数在出题按钮旁）。只是粗略比较，不是固定倍数，实际花费因模型而异；逐题精出出的题少，整次可能更省、每题更贵；快问省下的部分是估的，没有实测。');
export const costLoading = () => ui('正在估算…');

/** The matrix of 更多选项 in words (ui/presets/PresetsFold.jsx draws it and knows no lib): a column per 覆盖强度, a row per depth, each cell its ratio without
    「约」 (the caption says the costs are rough) and, but for the form's own cell (the summary beside the button says its count), its questions. `costs` is
    cellCosts of every cell; null when nothing is drawn: the default cell could not be estimated. */
export function matrixWords(costs, cell) {
  const all = [...costs.values()], ready = all.every(cost => cost.ready);
  if (ready && !(all.find(cost => cost.base)?.ratio > 0)) return null;
  return { ready, caption: ui('各组合的大致花费（相对「情境题」）'), tip: costTip(), loading: costLoading(),
    columns: DENSITIES.map(density => ({ key: density, label: levelLabel(density) })),
    rows: DEPTHS.map(depth => ({ key: depth, label: depthLabel(depth), cells: DENSITIES.map((density) => {
      const key = cellKey({ density, depth }), cost = costs.get(key), current = !(cell.count > 0) && cell.density === density && cell.depth === depth;
      return { key, current, ready: Boolean(cost?.ready), ratio: cost?.ready ? ratioText(cost.ratio, { base: cost.base, bare: true }) || '—' : '',
        questions: cost?.ready && !current ? questionsText(cost.coverage) : '' };
    }) })) };
}
