/* The rough costs of 出题方式 in words: the line beside the presets and the matrix of 更多选项. Both are drawn by ui/presets/PresetsFold.jsx, which arrives in a
   chunk of its own once there is something to price, so these words (most of them the hover card's) stay out of the workspace's first load
   (tests/workspace-closure-pages.test.mjs). This file reaches nothing in lib/: the form hands over the costs (ui/presets/cost.js cellCosts), the columns and
   the depths. */
import { ui, uiFormat } from '../i18n.js';
import { cellKey } from './cell-key.js';
import { depthLabel } from './depth-label.js';

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

/** How a rough cost is worked out (the hover card of the line and of the matrix). */
export const costTip = () => ui('按你选的资料，用出题前的 token 预估上限算出整次出题相对「情境题」的倍数；括号里是其他几种大约出多少题（选中那种的题数在出题按钮旁）。只是粗略比较，不是固定倍数，实际花费因模型而异；「先设计再写」出的题少，整次可能更省、每题更贵；「直接问」省下的部分是估的，没有实测。');
export const costLoading = () => ui('正在估算…');

/** One preset on the line: its name, its ratio and, but for the form's own (the summary beside the button says its count), its questions. */
export function costWords({ label, cost, current }) {
  const ratio = ratioText(cost.ratio, { base: cost.base }), questions = current ? '' : questionsText(cost.coverage);
  return `${label}${ratio ? ` ${ratio}` : ''}${questions ? uiFormat('（{0}）', [questions]) : ''}`;
}

/** What a cell of the matrix has to say: its ratio and its questions. */
const figures = (cost) => `${ratioText(cost.ratio, { base: cost.base, bare: true })}|${questionsText(cost.coverage)}`;

/** The matrix in words: a column per 覆盖强度 (`columns`: { key, label }), a row per depth, each cell its ratio without 「约」 (the caption says the costs are
    rough) and, but for the form's own cell, its questions. `costs` is cellCosts of every cell; null when nothing is drawn: the default cell could not be
    estimated, or every row reads the same in all its columns (a small material plans the same questions at any strength, so there is nothing to compare,
    #1686). A cell with a typed number of questions marks no cell: none of them is that run. */
export function matrixWords(costs, cell, { columns, depths }) {
  const all = [...costs.values()], ready = all.every(cost => cost.ready);
  if (ready && !(all.find(cost => cost.base)?.ratio > 0)) return null;
  if (ready && depths.every(depth => new Set(columns.map(({ key }) => figures(costs.get(cellKey({ density: key, depth }))))).size === 1)) return null;
  return { ready, caption: ui('各组合的大致花费（相对默认的出题方式「情境题」）'), tip: costTip(), loading: costLoading(), columns,
    rows: depths.map(depth => ({ key: depth, label: depthLabel(depth), cells: columns.map(({ key: density }) => {
      const key = cellKey({ density, depth }), cost = costs.get(key), current = !(cell.count > 0) && cell.density === density && cell.depth === depth;
      return { key, current, ready: Boolean(cost?.ready), ratio: cost?.ready ? ratioText(cost.ratio, { base: cost.base, bare: true }) || '—' : '',
        questions: cost?.ready && !current ? questionsText(cost.coverage) : '' };
    }) })) };
}
