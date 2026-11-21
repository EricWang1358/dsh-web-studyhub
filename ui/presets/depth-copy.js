/* The words of 出题深度 where it is chosen on its own: in 更多选项 of 创建题组 (ui/presets/PresetsFold.jsx) and in 设置 › 高级生成控制 (ui/GenerationSettings.jsx). Both
   arrive in chunks of their own, so these words stay out of the workspace's first load; the names of the depths are ui/presets/depth-label.js. This file reaches nothing in lib/. */
import { ui } from '../i18n.js';
import { depthLabel } from './depth-label.js';

/** A depth as an option of 设置, the default marked. */
export const depthOption = (depth) => (depth === 'scenario' ? ui('情境题（默认）') : depthLabel(depth));

/** One line under 出题深度 in the fold: what the chosen depth does. */
export function depthNote(depth) {
  return ({
    quick: ui('快问：每段资料一次写完，一个知识点一道短题。'),
    scenario: ui('情境题：每段资料一次写完，每道题放进一个短情境，让关键条件决定答案。'),
    blueprint: ui('逐题精出：先定考点、设计答案，再分批出题、审阅和修复。'),
  })[depth] || '';
}

/** What a depth does, for the hover card of 设置 and of the form. */
export const depthTip = () => ui('快问：每段资料一次写完这一段的题，一个知识点一道短题，调用最少。情境题：同样一次写完，每道题放进一个短情境，让关键条件决定答案，比快问多写一些。逐题精出：先规划考点、设计答案，再分批出题、审阅和修复；更慢、更费 token，适合要求最严的题组。一次写完的题由程序核对引文、选项和每段题数，再拿引文前后的原文分批审阅，不合格的直接舍去。');

/** The rule of 出题深度 in 设置 (the hint under the field). */
export const depthHint = () => ui('快问和情境题只用于单选题；其他题型总是逐题精出。续出和补题沿用题组开始时的方式（没有记录的旧题组是逐题精出，旧的一次写完题组按情境题）；重写没通过的题总是逐题精出。');
