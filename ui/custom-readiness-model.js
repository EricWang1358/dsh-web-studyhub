import { ui, uiFormat } from './i18n.js';
import { formatList, joinMeta } from './format.js';

/* 「章节准备度」 in the 「你的定制」 card (深度定制 S5, lib/custom-readiness.js): the words and numbers of one chapter's row and of the 补齐 question, from the answers of
   course.custom.readiness and course.custom.fill {estimate: true}. Pure; the words go through ui() so ui/locales/en.custom-plan.json has them. */

const percent = share => `${Math.round(share * 100)}%`;
const range = ({ low, high }) => (low === high ? String(low) : `${low}–${high}`);

/** The bar: the chapter's readiness (the weighted share of solid points); when the plan has no questions, how much of it is explained. 0–1. */
export function chapterShare(chapter, counted) {
  if (counted.questions) return chapter.readiness ?? 0;
  return chapter.points ? (chapter.explained ?? 0) / chapter.points : 0;
}
/** The number beside the bar. */
export const shareText = (chapter, counted) => percent(chapterShare(chapter, counted));

/** 未生成: the plan asks for the explanations and none of the chapter's points has one yet. */
export const isUnbuilt = (chapter, counted) => counted.explained && !chapter.built;

/** The four counts of a chapter, only the parts the plan ticked: 「讲解 2/2 · 有题 2/2 · 练过 2/2 · 扎实 1/2」. */
export function countsLine(chapter, counted) {
  const of = value => `${value}/${chapter.points}`;
  return joinMeta([counted.explained ? uiFormat('讲解 {0}', [of(chapter.explained)]) : '', counted.questions ? uiFormat('有题 {0}', [of(chapter.asked)]) : '',
    counted.questions ? uiFormat('练过 {0}', [of(chapter.practised)]) : '', counted.questions ? uiFormat('扎实 {0}', [of(chapter.solid)]) : '']);
}
/** What 扎实 means, said once in the bar's tooltip (lib/custom-readiness.js SOLID). */
export const solidMeaning = () => ui('扎实：一个知识点至少一半的题已掌握或在两天里答对过，并且没有答错的题。');
export const qualityLine = chapter => (chapter.quality?.sentBack > 0 ? uiFormat('有 {0} 道题被审核退回，等着修', [chapter.quality.sentBack]) : '');
export const barName = (chapter, counted) => uiFormat('{0}：{1}', [chapter.title, shareText(chapter, counted)]);

/** A chapter has something 补齐 can start. */
export const hasTodo = chapter => chapter.todo.explain > 0 || chapter.todo.questions > 0 || chapter.todo.weak > 0;

/** What 补齐 would do, from the fill estimate: 「讲解 1 个知识点、出题 3 个知识点、变式 1 道错题」. */
export function fillParts(answer) {
  const parts = [answer.book ? uiFormat('讲解 {0} 个知识点', [answer.book.points]) : '', answer.questions ? uiFormat('出题 {0} 个知识点', [answer.questions.points]) : '',
    answer.variants ? uiFormat('变式 {0} 道错题', [answer.variants.cards]) : ''].filter(Boolean);
  return formatList(parts);
}
/** The rough number of calls, never a price. */
export const fillCalls = answer => (answer.calls ? uiFormat('粗估约 {0} 次模型调用', [range(answer.calls)]) : ui('调用次数没法估，开始后在「任务」里看'));

/** What to say after 补齐 started: an error of a step first, else that it runs in 任务. */
export function startedNotice(result) {
  const started = result?.started || {}, steps = Object.values(started);
  const failed = steps.find(step => step?.error);
  if (failed) return { text: failed.error, tone: 'error' };
  if (started.variants?.needsConsent) {
    return { text: Object.keys(started).length > 1 ? ui('变式题要先在设置里同意学习教练准备，才会开始。其余的已经开始，进度在「任务」里。') : ui('变式题要先在设置里同意学习教练准备，才会开始。'), tone: 'warning' };
  }
  if (steps.length && steps.every(step => step?.alreadyRunning)) return { text: ui('这些已经在补了，进度在「任务」里。'), tone: 'success' };
  return { text: ui('已开始补齐，进度在「任务」里。'), tone: 'success' };
}
