/* What a run will ask for, in a student's words (创建题组 › 额外要求 › 预览本次出题要求): the materials, how many questions of which types, the difficulty, the language, how formulas are
   written, the course's focus and rules, and the extra requirements typed on the form. Pure and local: it reads the form, calls nothing, costs nothing. The engineering view of the same
   request (stages, prompt order, protocol checks) is the task console's 实际请求, not this page. */
import { ui, uiFormat } from './i18n.js';
import { kinds as kindNames } from './shared.js';
import { customCountOf, DIFFICULTIES, languageLabel, NOTATION_CHOICES, kindsOfForm } from './generate-form.js';
import { splitCount } from '../lib/generation-settings.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { displayTitle } from '../lib/document-title.js';
import { normalizeModuleOverrides } from '../lib/generation-modules.js';

/** The three extra requirements a learner may write, by the key of `gen.moduleOverrides`, with the label the form and the preview share. */
export const EXTRA_REQUIREMENTS = Object.freeze([
  { key: 'reasoning', get label() { return ui('推理要求'); }, get placeholder() { return ui('例如：必须包含边界条件反例判断，避免纯定义背诵'); } },
  { key: 'distractors', get label() { return ui('错误选项'); }, get placeholder() { return ui('例如：每个干扰项对应具体常见误区，禁止凑数否定项'); } },
  { key: 'rubric', get label() { return ui('开放题评分'); }, get placeholder() { return ui('例如：按推理步骤拆分采分点，标明遗漏关键前提的扣分原因'); } },
]);

const SHOWN_TITLES = 3;

/** The preview as rows of { key, label, value } (a string) or { key, label, items } (a list); rows with nothing to say are left out. */
export function previewRows({ gen = {}, sources = [], sourceIds = [], plannedGoal = null, focusCount = 0, referenceCount = 0, rules = [] } = {}) {
  const rows = [];
  const chosen = new Set(sourceIds);
  const titles = groupSourcesByDocument((sources || []).filter((source) => chosen.has(source.id))).map((item) => displayTitle(item.title));
  if (titles.length) {
    const shown = titles.slice(0, SHOWN_TITLES).join('、');
    rows.push({ key: 'materials', label: ui('资料'), value: titles.length > SHOWN_TITLES ? uiFormat('{0} 份：{1} 等', [titles.length, shown]) : uiFormat('{0} 份：{1}', [titles.length, shown]) });
  }
  const kinds = kindsOfForm(gen);
  const custom = gen.kindCounts && typeof gen.kindCounts === 'object' && !Array.isArray(gen.kindCounts);
  const total = customCountOf(gen) || plannedGoal || null;
  if (custom && kinds.length > 1) {
    const sum = kinds.reduce((all, kind) => all + (Number(gen.kindCounts[kind]) || 0), 0);
    rows.push({ key: 'questions', label: ui('题型与题数'), value: uiFormat('{0}（共 {1} 题）', [kinds.map((kind) => `${kindNames[kind]} ${Number(gen.kindCounts[kind]) || 0}`).join(' · '), sum]) });
  } else if (total && total >= kinds.length) {
    rows.push({ key: 'questions', label: ui('题型与题数'), value: kinds.length > 1
      ? uiFormat('{0}（共 {1} 题）', [splitCount(kinds, total).map(([kind, count]) => `${kindNames[kind]} ${count}`).join(' · '), total])
      : uiFormat('{0}，共 {1} 题', [kindNames[kinds[0]], total]) });
  } else {
    rows.push({ key: 'questions', label: ui('题型与题数'), value: uiFormat('{0}（题数按覆盖强度定）', [kinds.map((kind) => kindNames[kind]).join(' · ')]) });
  }
  rows.push({ key: 'difficulty', label: ui('难度'), value: DIFFICULTIES.find((item) => item.value === gen.difficulty)?.label || DIFFICULTIES[0].label });
  rows.push({ key: 'language', label: ui('语言'), value: languageLabel(gen.language) });
  rows.push({ key: 'notation', label: ui('公式写法'), value: NOTATION_CHOICES.find((item) => item.value === (gen.notation ?? 'auto'))?.label || NOTATION_CHOICES[0].label });
  if (String(gen.focus ?? '').trim()) rows.push({ key: 'focus', label: ui('这次想练'), value: String(gen.focus).trim() });
  if (focusCount > 0) rows.push({ key: 'course-focus', label: ui('课程重点'), value: uiFormat('{0} 个重点知识点：相关章节多出题，出得更深', [focusCount]) });
  if (referenceCount > 0) rows.push({ key: 'reference', label: ui('参考样题'), value: uiFormat('{0} 份，只参考题型和表达，题目是新出的', [referenceCount]) });
  if (rules.length) rows.push({ key: 'rules', label: ui('本课出题守则'), items: rules });
  const overrides = normalizeModuleOverrides(gen.moduleOverrides) || {};
  const extras = EXTRA_REQUIREMENTS.map(({ key, label }) => {
    const entry = overrides[key];
    return entry && entry.enabled !== false && entry.instruction ? uiFormat('{0}：{1}', [label, entry.instruction]) : null;
  }).filter(Boolean);
  rows.push(extras.length ? { key: 'extras', label: ui('额外要求'), items: extras, name: overrides.templateName || '' } : { key: 'extras', label: ui('额外要求'), value: ui('没有，按默认来') });
  return rows;
}
