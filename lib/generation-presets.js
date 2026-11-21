import { GENERATION_COVERAGE_LEVELS, normalizeGenerationPerformance } from './generation-settings.js';
import { levelOf } from './coverage-strength.js';
import { DEFAULT_WRITE_STYLE } from './one-pass/write-style-names.js';
import { servesKinds } from './one-pass/route.js';

/* 出题方式 as a matrix (owner 2026-11-21, docs/plans/2026-11-21-feat-one-pass-generation-plan.md §7 item 6, §18): the one place that says what the presets are.
     DENSITY  how many questions: the 覆盖强度 levels of lib/coverage-strength.js, unchanged (lean / standard / full).
     DEPTH    how they are written: 'quick' and 'scenario' are one pass with that write style (lib/one-pass/write-style.js); 'blueprint' is the staged pipeline
              (逐题精出: the targets are planned and the answers designed before the questions are written).
     PRESETS  the three cells the main path of 创建题组 offers; any other cell of the matrix is 自定义 (presetOf: null).
   A cell is { density, depth }; in the settings and in a request it is `coverageLevel` and `performance: { strategy, writeStyle }`. The form, 设置 and the backend
   read this module; the words for each cell are the UI's (ui/presets/copy.js). The depth only matters where one pass can write (depthApplies). */

export const DENSITIES = GENERATION_COVERAGE_LEVELS;
export const DEPTHS = Object.freeze(['quick', 'scenario', 'blueprint']);
const DEFAULT_DEPTH = 'scenario';
const DEPTH_PERFORMANCE = Object.freeze({
  quick: Object.freeze({ strategy: 'one-pass', writeStyle: 'quick' }),
  scenario: Object.freeze({ strategy: 'one-pass', writeStyle: 'scenario' }),
  // The staged pipeline has no write style: the default rides along, so every depth sets the same two keys.
  blueprint: Object.freeze({ strategy: 'staged', writeStyle: DEFAULT_WRITE_STYLE }),
});

export const PRESETS = Object.freeze([
  Object.freeze({ id: 'quick', density: 'lean', depth: 'quick' }),
  Object.freeze({ id: 'scenario', density: 'standard', depth: 'scenario' }),
  Object.freeze({ id: 'blueprint', density: 'standard', depth: 'blueprint' }),
]);
/** 情境题: today's default (standard × one pass in the scenario style). */
export const DEFAULT_PRESET = 'scenario';

/** The cell of a preset id, or null. */
export function presetCell(id) {
  const preset = PRESETS.find(item => item.id === id);
  return preset ? { density: preset.density, depth: preset.depth } : null;
}
export const DEFAULT_CELL = Object.freeze(presetCell(DEFAULT_PRESET));

/** The performance keys of a depth (an unknown depth is the default). */
export const performanceOfDepth = depth => ({ ...DEPTH_PERFORMANCE[DEPTHS.includes(depth) ? depth : DEFAULT_DEPTH] });

/** The depth of performance settings (saved, or a request's): staged is 逐题精出 whatever the style; otherwise the write style. Read through the settings' own
    normalisation, so a corrupt value is the default and a library of the S8 migration (采纳审阅建议 on, no strategy saved) is staged. */
export function depthOf(performance) {
  const { strategy, writeStyle } = normalizeGenerationPerformance(performance);
  return DEPTHS.find(depth => DEPTH_PERFORMANCE[depth].strategy === strategy && (strategy === 'staged' || DEPTH_PERFORMANCE[depth].writeStyle === writeStyle)) ?? DEFAULT_DEPTH;
}

/** What a cell sets: the level and the performance keys of its depth. */
export const settingsOfCell = ({ density, depth } = {}) => ({ coverageLevel: levelOf(density), performance: performanceOfDepth(depth) });

/** The preset a cell is, or null (自定义). A cell with a typed number of questions (`count`) is no preset: that number plans the run, not the level a preset names. */
export const presetOf = (cell) => (Number.isInteger(cell?.count) && cell.count > 0 ? null
  : PRESETS.find(item => item.density === cell?.density && item.depth === cell?.depth)?.id ?? null);

/** Whether the depth means anything for a request: one pass can write its kinds (every kind multiple choice, not a case paper). Otherwise it is written by the
    staged pipeline whatever the depth says, and only the density counts. */
export const depthApplies = request => servesKinds(request);

/** The rough cost of a cell against the default cell: the upper end of the token estimate of each (the figure the form shows), divided; null without both. */
export function costRatio(cell, base) {
  const top = Number(cell?.totalTokens?.high), bottom = Number(base?.totalTokens?.high);
  return top > 0 && bottom > 0 ? top / bottom : null;
}
