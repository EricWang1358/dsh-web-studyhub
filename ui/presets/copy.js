/* The words of 出题方式 (lib/generation-presets.js): the presets, the depths, what each says on the form and in 设置, and the rough cost beside them. The facts
   (which cell a preset is, what a depth runs) are the lib module's; only the wording is here, once, for the form and the settings. */
import { ui, uiFormat } from '../i18n.js';
import { levelLabel } from '../coverage/copy.js';

const DEPTH_LABELS = { quick: '快问', scenario: '情境题', blueprint: '逐题精出' };
/** A depth (and the preset named after it) in words. */
export const depthLabel = (depth) => ui(DEPTH_LABELS[depth] || DEPTH_LABELS.scenario);
/** A preset in words: each preset is named after its depth. */
export const presetLabel = (id) => depthLabel(id);
/** A depth as an option of 设置, the default marked. */
export const depthOption = (depth) => (depth === 'scenario' ? ui('情境题（默认）') : depthLabel(depth));

/** One line under the presets: what the chosen one does. */
export function presetNote(id) {
  return ({
    quick: ui('快问：精简题量，每段资料一次写完，一个知识点一道短题；最省，适合考前过一遍。'),
    scenario: ui('情境题（默认）：标准题量，每段资料一次写完，每道题放进一个短情境，让关键条件决定答案。'),
    blueprint: ui('逐题精出：标准题量，先定考点、设计答案再写题，分批审阅和修复；更慢、更费 token，题更综合。'),
  })[id] || '';
}

/** The line for a combination that is no preset: what it is and where it is changed. */
export const customNote = (cell) => uiFormat('自定义：{0} × {1}。在「更多选项 › 出题方式与题量」里改，或选上面的一种。', [levelLabel(cell.density), depthLabel(cell.depth)]);

/** One line under 出题深度 in the fold: what the chosen depth does. */
export function depthNote(depth) {
  return ({
    quick: ui('快问：每段资料一次写完，一个知识点一道短题。'),
    scenario: ui('情境题：每段资料一次写完，每道题放进一个短情境，让关键条件决定答案。'),
    blueprint: ui('逐题精出：先定考点、设计答案，再分批出题、审阅和修复。'),
  })[depth] || '';
}

/** Why the depth does nothing for these question types (the same rule 设置 says for 出题深度). */
export const depthOffReason = () => ui('快问和情境题只用于单选题；选了其他题型时总是逐题精出，只有题量（覆盖强度）起作用。');

/** What a depth does, for the hover card of 设置 and of the form. */
export const depthTip = () => ui('快问：每段资料一次写完这一段的题，一个知识点一道短题，调用最少。情境题：同样一次写完，每道题放进一个短情境，让关键条件决定答案，比快问多写一些。逐题精出：先规划考点、设计答案，再分批出题、审阅和修复；更慢、更费 token，适合要求最严的题组。一次写完的题由程序核对引文、选项和每段题数，再拿引文前后的原文分批审阅，不合格的直接舍去。');

/** The rule of 出题深度 in 设置 (the hint under the field). */
export const depthHint = () => ui('快问和情境题只用于按覆盖强度出的单选题；其他题型和按题数出题总是逐题精出。已有题组接着做或补题时，按它开始时的方式出（早于出题方式设置的题组是逐题精出，早于出题深度设置的一次写完题组按情境题出）；补题时重写没通过的题总是逐题精出。');

/** A cost ratio as the form says it: 「约 ×0.6」; the default cell itself is 「×1」; nothing without a ratio. `bare` leaves out 「约」 where the heading already says
    the costs are rough (the matrix, whose narrow cells have no room for it at 320 px). */
export function ratioText(ratio, { base = false, bare = false } = {}) {
  if (base) return '×1';
  if (!(ratio > 0)) return '';
  const rounded = ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio);
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
export const costTip = () => ui('按你选的资料，用出题前的 token 预估（上限）算出：整次出题相对默认「情境题」（标准题量）的倍数，括号里是其他几种大约出多少题（选中的那种的题数写在出题按钮旁）。只是粗略比较，不是固定倍数：实际花费因模型而异（例如 DeepSeek 这类模型思考的长短不同）；逐题精出每万字出的题更少，所以整次可能更省、每道题更贵；快问写得更短，省下的那部分没有实测，是估的。');
export const costLoading = () => ui('正在估算…');
