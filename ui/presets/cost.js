/* The rough cost of each cell of 出题方式 (lib/generation-presets.js) for the chosen materials: no number of its own, only the token estimate the form already asks
   for (`usage.estimate`, lib/token-estimate.js), asked once per cell with that cell's level and depth, divided by the default cell's (costRatio). No React here:
   ui/presets/use-cell-estimates.js asks, the components say it. */
import { DENSITIES, DEPTHS, PRESETS, DEFAULT_CELL, settingsOfCell, costRatio } from '../../lib/generation-presets.js';

export const cellKey = ({ density, depth }) => `${density}:${depth}`;
const BASE_KEY = cellKey(DEFAULT_CELL);
/** The cells of the three presets of the main path. */
export const PRESET_CELLS = Object.freeze(PRESETS.map(({ density, depth }) => Object.freeze({ density, depth })));
/** Every cell of the matrix, a row per depth. */
export const MATRIX_CELLS = Object.freeze(DEPTHS.flatMap(depth => DENSITIES.map(density => Object.freeze({ density, depth }))));

/** The estimate request of a cell: the form's request with the cell's level and depth, without a typed number of questions (picking a level or a preset takes it away). */
export function cellRequest(base, cell) {
  const { count: _typed, ...rest } = base, { coverageLevel, performance } = settingsOfCell(cell);
  return { ...rest, coverageLevel, performance };
}

/** The cells to ask for, the default cell first (every ratio is read against it), each once. */
export const cellsToAsk = (cells) => [DEFAULT_CELL, ...cells].filter((cell, at, all) => all.findIndex(other => cellKey(other) === cellKey(cell)) === at);

/** The cost of each cell from the answers (`estimates`: key → estimate, null when it could not be made, undefined while asked): { ratio, coverage, base, ready }. */
export function cellCosts(estimates, cells) {
  const base = estimates.get(BASE_KEY);
  return new Map(cells.map((cell) => {
    const key = cellKey(cell), estimate = estimates.get(key);
    return [key, { ratio: costRatio(estimate, base), coverage: estimate?.coverage ?? null, base: key === BASE_KEY, ready: estimate !== undefined && base !== undefined }];
  }));
}
