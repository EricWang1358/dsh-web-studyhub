/* The words of a step of the 分步出题 path in the interface language (the panel, the conversation brief and the list of steps that did not start use the same ones). */
import { ui, uiFormat, uiIsEnglish } from './i18n.js';
import { stepTitleOf } from '../lib/generation-path.js';
import { MATTER_WORDS } from './generation-path-flow.js';

const pageRange = (from, to) => from === to ? uiFormat('第 {0} 页', [from]) : uiFormat('第 {0}–{1} 页', [from, to]);

/** The step's name in the interface language: a model's name as it is, otherwise from its parts (the same rule as the plan's own: usable chapter names, else the pages). */
export function stepTitle(step) {
  if (step.named || !uiIsEnglish()) return step.title;
  const parts = step.parts || [];
  if (!parts.length) return step.title;
  return stepTitleOf(parts, { range: pageRange, front: ui('前言与目录'), join: ', ', ellipsis: ' … ' });
}

/** The pages a step covers, in the interface language, when its name does not already say so ("第 55–76 页、第 80 页" / "Pages 55–76, Page 80"). */
export function stepPages(step, title) {
  const runs = (step.ranges || []).filter(run => Number.isInteger(run?.from) && Number.isInteger(run?.to));
  if (!runs.length) return '';
  const documents = new Set(runs.map(run => run.document));
  const text = runs.map(run => (documents.size > 1 && run.document ? `${run.document} ` : '') + pageRange(run.from, run.to)).join(ui('、'));
  return runs.length === 1 && documents.size === 1 && String(title).includes(pageRange(runs[0].from, runs[0].to)) ? '' : text;
}

/** What kind of front or back matter a step is ("索引", "目录页"), in the interface language. */
export const matterWord = step => ui(MATTER_WORDS[step.matter]?.zh || MATTER_WORDS.front.zh);
