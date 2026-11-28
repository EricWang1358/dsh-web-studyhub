/* The words of 出题方式 on the main path of 创建题组 (lib/contexts/generation/presets.js): the presets, the names of the depths (写法), and what the line of rough
   costs says before its words arrive. The facts (which cell a preset is, what a depth runs) are the lib module's; only the wording is here, once. The words of
   the rough costs themselves are ui/presets/cost-words.js and what 写法 says in 更多选项 and in 设置 is ui/presets/depth-copy.js: both arrive with their own
   chunks, not with the workspace's first load. */
import { ui, uiFormat } from '../i18n.js';
import { levelLabel } from '../coverage/copy.js';
import { DENSITIES } from '../../lib/contexts/generation/presets.js';
import { depthLabel } from './depth-label.js';

export { depthLabel };
const PRESET_LABELS = { quick: '快问', scenario: '情境题', blueprint: '逐题精出' };
/** A preset in words (a preset is a coverage strength and a writing method together, so it has a name of its own); an unknown one is the default. */
export const presetLabel = (id) => ui(PRESET_LABELS[id] || PRESET_LABELS.scenario);

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

/** Why 写法 (and so a preset) does nothing for these question types (the same rule 设置 says under 写法). */
export const depthOffReason = () => ui('只有单选题能选写法；选了其他题型时总是先设计再写，只有题量（覆盖强度）起作用。');

/** The words before the rough costs (the line's own words arrive with ui/presets/PresetsFold.jsx). */
export const costLead = () => ui('大致花费');

/** The columns of the matrix of 更多选项: a 覆盖强度 each, in words. */
export const matrixColumns = () => DENSITIES.map(density => ({ key: density, label: levelLabel(density) }));
