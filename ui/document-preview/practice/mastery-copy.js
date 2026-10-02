/* The words of the reading loop (资料掌握度, 做这几页的题). Every string is a literal ui()/uiFormat() call so the English catalogue
   (ui/locales/en.loop.json) is checked against it. Nothing here reads state: pass a summary from lib/material-summary.js. */
import { ui, uiFormat } from '../../i18n.js';
import { dueNewWeakLine } from '../../../lib/material-summary.js';

/** The plain label of a state: 还没出题 / 未学 / 学习中 / 熟悉 / 已掌握. */
export function stateLabel(state) {
  if (state === 'mastered') return ui('已掌握');
  if (state === 'familiar') return ui('熟悉');
  if (state === 'learning') return ui('学习中');
  if (state === 'unlearned') return ui('未学');
  return ui('还没出题');
}

export const questionsWord = count => count === 1 ? ui('1 道题') : uiFormat('{0} 道题', [count]);

/** The one-line meaning of the number, shown wherever the number is explained. */
export const meaningLine = () => ui('按这几页关联的题的复习状态计算；答对并拉长复习间隔才会上升');

/** "掌握 62% · 12 题", "未学 · 3 题" or "还没出题": the text of a row. */
export function masteryText(summary) {
  if (!summary?.total) return ui('还没出题');
  if (summary.state === 'unlearned') return summary.total === 1 ? ui('未学 · 1 题') : uiFormat('未学 · {0} 题', [summary.total]);
  return summary.total === 1 ? uiFormat('掌握 {0}% · 1 题', [summary.percent]) : uiFormat('掌握 {0}% · {1} 题', [summary.percent, summary.total]);
}

/** The accessible name and tooltip of a mark: "第 3 页：学习中 · 掌握 45% · 4 题". */
export function markLabel(title, summary) {
  const detail = summary?.total ? `${stateLabel(summary.state)} · ${summary.state === 'unlearned' ? questionsWord(summary.total) : masteryText(summary)}` : ui('还没出题');
  const inactive = summary?.inactive > 0 ? (summary.inactive === 1 ? ui('其中 1 道在未激活的课程里') : uiFormat('其中 {0} 道在未激活的课程里', [summary.inactive])) : '';
  return [title ? `${title}：${detail}` : detail, inactive].filter(Boolean).join(' · ');
}

/** "5 道题 · 2 道到期 · 1 道薄弱 · 1 道新题" before starting. */
export const countsLine = summary => dueNewWeakLine(summary, {
  questions: questionsWord,
  due: count => uiFormat('{0} 道到期', [count]),
  weak: count => uiFormat('{0} 道薄弱题', [count]),
  fresh: count => uiFormat('{0} 道没做过', [count]),
});

/** The label of a range option; `unit` is 'page' (PDF), 'slide' (PowerPoint) or 'section'. */
export function rangeLabel(option, unit) {
  if (option.kind === 'document') return ui('整份资料');
  if (option.kind === 'chapter') return ui('本章');
  if (option.kind === 'recent') return unit === 'page' ? uiFormat('刚读过的 {0} 页', [option.count]) : unit === 'slide' ? uiFormat('刚读过的 {0} 张', [option.count]) : uiFormat('刚读过的 {0} 节', [option.count]);
  return unit === 'page' ? ui('本页') : unit === 'slide' ? ui('本张') : ui('本节');
}

/** What the reading context says about what was practised, for the way back and the result page. */
export function scopeLabel(scope) {
  if (scope?.kind === 'chapter') return ui('这一章');
  if (scope?.kind === 'document') return ui('整份资料');
  if (scope?.kind === 'recent') return scope.count === 1 ? ui('刚读过的 1 处') : uiFormat('刚读过的 {0} 处', [scope.count]);
  return ui('这一处');
}
