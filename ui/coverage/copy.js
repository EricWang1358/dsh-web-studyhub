import { ui, uiFormat } from '../i18n.js';
import { META_DOT } from '../format.js';

/* 覆盖: the words of coverage, written ONCE (README docs/plans/coverage-generation). The 任务 console's 资料部分, the draft page, the 资料 row, the reader's toolbar, outline and
   practice popover all say it through these functions, so one fact has one wording on every screen. Coverage is "asked" (a section has a question), mastery is "learned"
   (how the learner did on it): the words never mix the two. */

/* How many of a unit: the unit is what lib/coverage.js says the sections are (units). English has a singular, so each is two literals. */
const COUNT = {
  part: [() => ui('1 个部分'), (n) => uiFormat('{0} 个部分', [n])],
  page: [() => ui('1 页'), (n) => uiFormat('{0} 页', [n])],
  chapter: [() => ui('1 个章节'), (n) => uiFormat('{0} 个章节', [n])],
  heading: [() => ui('1 个小节'), (n) => uiFormat('{0} 个小节', [n])],
  window: [() => ui('1 个片段'), (n) => uiFormat('{0} 个片段', [n])],
  section: [() => ui('1 个小节'), (n) => uiFormat('{0} 个小节', [n])],
};

/** "80 个部分" / "80 parts": `n` of the units a coverage counts. */
export const countOf = (units, n) => { const [one, many] = COUNT[units] || COUNT.section; return n === 1 ? one() : many(n); };

/** The head of the list of what has no question, and what is said when nothing is left, in the unit of the material. */
const UNCOVERED = { part: (n) => uiFormat('没覆盖的部分 · {0}', [n]), page: (n) => uiFormat('没覆盖的页 · {0}', [n]), chapter: (n) => uiFormat('没覆盖的章节 · {0}', [n]),
  heading: (n) => uiFormat('没覆盖的小节 · {0}', [n]), window: (n) => uiFormat('没覆盖的片段 · {0}', [n]), section: (n) => uiFormat('没覆盖的小节 · {0}', [n]) };
export const uncoveredHead = (units, n) => (UNCOVERED[units] || UNCOVERED.section)(n);
const ALL = { part: () => ui('每个部分都有题了。'), page: () => ui('每一页都有题了。'), chapter: () => ui('每个章节都有题了。'), heading: () => ui('每个小节都有题了。'),
  window: () => ui('每个片段都有题了。'), section: () => ui('每个小节都有题了。') };
export const allCoveredText = (units) => (ALL[units] || ALL.section)();

/** 「覆盖 7/80 个部分（9%）」 */
export const coverageHead = (c) => uiFormat('覆盖 {0}/{1}（{2}%）', [c.covered, countOf(c.units, c.leaves), c.percentLeaves]);

/** 「3 个计划了没出成」, 「70 个没计划到」: the rest of the line. A draft from before plans were kept says 「没有记录」 for what it cannot tell. */
export const plannedFailedText = (n) => uiFormat('{0} 个计划了没出成', [n]);
export const neverPlannedText = (n, recorded = true) => (recorded ? uiFormat('{0} 个没计划到', [n]) : uiFormat('{0} 个没有记录', [n]));

/** 「覆盖 7/80 个部分（9%）· 3 个计划了没出成 · 70 个没计划到」 */
export function coverageLine(c) {
  return [coverageHead(c), c.plannedFailed > 0 && plannedFailedText(c.plannedFailed), c.neverPlanned > 0 && neverPlannedText(c.neverPlanned, c.recorded)].filter(Boolean).join(META_DOT);
}

/** 「覆盖 9%」: the chip beside the mastery mark. */
export const coverageChipText = (c) => uiFormat('覆盖 {0}%', [c.percentLeaves]);

/** 「覆盖 7/80」: the outline's header. */
export const coverageOutlineHead = (c) => uiFormat('覆盖 {0}/{1}', [c.covered, c.leaves]);

/** What a section's state is called. */
export function stateWord(state, recorded = true) {
  if (state === 'covered') return ui('已覆盖');
  if (state === 'planned-failed') return ui('计划了没出成');
  return recorded ? ui('没计划到') : ui('没有记录');
}

/** What a state means, for a tooltip: said as asked, not as learned. */
export function stateMeaning(state, recorded = true) {
  if (state === 'covered') return ui('这一节出过题。覆盖只说出没出过题，掌握度才说你答得怎么样。');
  if (state === 'planned-failed') return ui('这一节的考点计划过，但题没出成。可以用「为没覆盖的部分补题」补上。');
  return recorded ? ui('这一节没有被计划出题。可以用「为没覆盖的部分补题」补上。') : ui('这份草稿生成时没有保存计划，只能说这一节现在没有题。');
}

/** Why a planned section did not come out: the words of each failure code (lib/generation-failure.js), the ones the 任务 console and the draft already use. */
const REASON_WORD = { quote: '引用在资料里找不到', plan: '考点规划未通过检查', quality: '题没有通过质量审阅', 'review-protocol': '审阅回复格式不对，重新审阅后仍不行',
  timeout: '模型长时间没有回应', 'rate-limit': '被模型服务限流', 'no-reply': '模型没有返回内容', quota: '模型账户余额或额度不足', credential: '模型密钥缺失或被拒绝',
  budget: '生成用时到限', cancelled: '被停止', unavailable: '模型服务暂时不可用', other: '其他原因' };
export const reasonWord = (code) => ui(REASON_WORD[code] || REASON_WORD.other);

/** A section as a list names it: its title, else its page, else its ordinal. */
export function sectionName(section) {
  if (section.title) return section.title;
  if (section.page) return uiFormat('第 {0} 页', [section.page]);
  if (section.n) return uiFormat('第 {0} 段', [section.n]);
  return section.id;
}

/** 「覆盖 3/8 小节」 (「覆盖 3/8 页」 for pages): what a range of the material has, for a part of a run. */
export const rangeCoverageText = (r, units) => (units === 'page' ? uiFormat('覆盖 {0}/{1} 页', [r.covered, r.leaves]) : uiFormat('覆盖 {0}/{1} 小节', [r.covered, r.leaves]));

/** 「没有题的小节」 for a part's strip: each with the real reason, in reading order, cut to what fits (the whole list is the tooltip). */
export function uncoveredInRange(r, { recorded = true, max = 4 } = {}) {
  // What was planned and did not come out first (it has a reason), then what was never planned, each in reading order.
  const open = [...r.sections.filter((section) => section.state === 'planned-failed'), ...r.sections.filter((section) => section.state === 'never-planned')];
  if (!open.length) return '';
  const words = open.map((section) => uiFormat('{0}（{1}）', [sectionName(section), section.state === 'planned-failed' ? reasonWord(section.reason) : stateWord(section.state, recorded)]));
  const shown = words.slice(0, max).join(ui('、'));
  return uiFormat('没有题的小节：{0}', [open.length > max ? uiFormat('{0} 等 {1} 个', [shown, open.length]) : shown]);
}

/** One line for the reader's 做这几页的题 panel: how much of the range has no question. */
export const rangeUncoveredLine = (uncovered, leaves, units) => (units === 'page'
  ? uiFormat('这几页里有 {0} 页还没有题（共 {1} 页）', [uncovered, leaves]) : uiFormat('其中 {0} 个小节还没有题（共 {1} 个）', [uncovered, leaves]));
