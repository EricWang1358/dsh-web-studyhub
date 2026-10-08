/* 创建题组, a selection too big for one generation: which ways out the page offers (the pure part of TooBigChoice.jsx, shared with Generate.jsx and its tests).
   There is ONE block with a choice, never three panels side by side:
     path       分步出题: the selection cut into steps, each its own job in the queue (needs a plan of steps);
     retrieval  按主题挑页面: a retrieval tool picks the pages for the topic (needs a tool that is ready);
     single     一次出题: the ordinary form, only while the whole selection fits in one generation. */
import { ui, uiFormat } from './i18n.js';
import { retrievalReady } from './large-document-advice.js';

export const MODES = Object.freeze({ path: 'path', retrieval: 'retrieval', single: 'single' });

/** The modes this selection can use, in the order they are offered. `pathReady` tells that a plan of several steps exists. */
export function availableModes({ advice, pathReady = false, retrieval = null } = {}) {
  const modes = [];
  if (pathReady) modes.push(MODES.path);
  if (retrievalReady(retrieval) && (advice?.willRetrieve || advice?.needsTopic)) modes.push(MODES.retrieval);
  if (!advice?.tooBig) modes.push(MODES.single);
  return modes;
}

/** The mode that is on before the learner chooses: steps for a selection that cannot be done at once, the tool's page picking where it is already on, else the ordinary form. */
export function defaultMode(modes, advice) {
  if (advice?.tooBig) return modes.includes(MODES.path) ? MODES.path : modes.includes(MODES.retrieval) ? MODES.retrieval : null;
  return modes.includes(MODES.retrieval) ? MODES.retrieval : MODES.single;
}

/** What is on now: the learner's choice while it still exists for this selection, else the default (null: nothing to choose, only the explanation). */
export const effectiveMode = (chosen, modes, advice) => (modes.includes(chosen) ? chosen : defaultMode(modes, advice));

/** The block is there for a selection that is too big, and for a longer one that has more than the ordinary form to choose from. */
export const showsChoice = (modes, advice) => !!advice?.tooBig || modes.length > 1;

/** 「共 N 步 · 约 X 题」: the steps in use and the questions they add up to (each step has its own count). */
export function pathSummary(included = []) {
  if (!included.length) return ui('还没有勾选任何一步。');
  return uiFormat('共 {0} 步 · 约 {1} 题', [included.length, included.reduce((sum, step) => sum + (Number(step.count) || 0), 0)]);
}
