/* 期末一周 (M7) and 备考计划: the words of the plans' days, points and mock paper. Every sentence is a literal ui() / uiFormat() call (the English is in
   ui/locales/en.outline.json); the plans themselves (lib/crunch-plan.js, lib/plan-schedule.js) only give codes and numbers. */
import { ui, uiFormat } from '../i18n.js';
import { formatList, joinMeta } from '../format.js';

/** The one line of why a day holds what it holds (lib/crunch-plan.js and lib/plan-schedule.js `reason`; 'learn', 'learn-size', 'learn-over', 'learn-free', 'exam-today'
    and 'done' are the same code in both). */
export function reasonText(reason) {
  const r = reason || {};
  switch (r.code) {
    case 'learn': return uiFormat('先学考得多又薄弱的 {0} 节（{1} 节样卷考过）：每节读完练 5 道，约 {2} 分钟。', [r.count, r.tested, r.minutes]);
    case 'learn-size': return uiFormat('样卷没有考情，各节一样重：先学最薄弱的 {0} 节，每节读完练 5 道，约 {1} 分钟。', [r.count, r.minutes]);
    case 'learn-over': return uiFormat('节数多于时间：这一天合并了 {0} 节，约 {1} 分钟，超过每天的 {2} 分钟。', [r.count, r.minutes, r.capacity]);
    case 'learn-free': return ui('这一天没有新的节：复习到期和薄弱的题。');
    case 'flip': return uiFormat('不再做新题：翻看 {0} 节，易错点多的先看（共 {1} 条易错点）。', [r.count, r.pitfalls]);
    case 'flip-mock': return uiFormat('考前最后一天：翻看剩下的 {0} 节，再做一套模拟卷。', [r.count]);
    case 'exam-today': return uiFormat('今天考试：只翻看 {0} 节的易错点。', [r.count]);
    case 'off': return ui('这一天休息。');
    case 'done': return uiFormat('这一天做完了 {0} 节。', [r.count]);
    case 'review': return uiFormat('复习日：回看学过的 {0} 节，最薄弱、易错点最多的先看。', [r.count]);
    case 'review-learn': return ui('还没学完：这一天先把最重要的一节学了。');
    case 'mock': return ui('模拟考：整卷演练一遍，检验阶段目标（「出一套模拟卷」）。');
    case 'rest': return ui('计划里的休息日。');
    case 'weekday': return ui('不在学习日里：这一天休息。');
    case 'looked': return uiFormat('这一天翻看了 {0} 节。', [r.count]);
    case 'exam-day': return uiFormat('考试日：只翻看全部 {0} 节的易错点。', [r.count]);
    default: return '';
  }
}

/** What a day is, in a few words: 学习日 / 翻看日 / 翻看日 · 模拟卷 / 休息, and the plan's 复习日 / 模拟考. */
export const dayKind = day => (day?.mode === 'flip' ? (day.mock ? joinMeta([ui('翻看日'), ui('模拟卷')]) : ui('翻看日')) : day?.mode === 'off' ? ui('休息')
  : day?.mode === 'review' ? ui('复习日') : day?.mode === 'mock' ? ui('模拟考') : ui('学习日'));

/** "距考试 N 天" / "今天考试". */
export const countdownText = daysLeft => (daysLeft === 0 ? ui('今天考试') : daysLeft === 1 ? ui('距考试 1 天') : uiFormat('距考试 {0} 天', [daysLeft]));

/** A point's line under its title: its questions (or 只读), the sample papers that tested it, its weak questions, its 易错点. */
export const pointMeta = point => joinMeta([
  point.questions ? uiFormat('{0} 道题', [point.questions]) : ui('只读，没有题'),
  point.tested ? uiFormat('样卷考过 {0} 份', [point.tested]) : '',
  point.weak ? uiFormat('{0} 题薄弱', [point.weak]) : '',
  point.pitfalls ? uiFormat('{0} 条易错点', [point.pitfalls]) : '',
]);

/** One 易错点 of a point (lib/book-flip.js): what was asked, an answer card's pitfall, what was explained. */
export const mistakeText = item => uiFormat(item.kind === 'asked' ? '问过：{0}' : item.kind === 'explained' ? '弄懂：{0}' : '易错：{0}', [item.text]);

const kindLabel = kind => ({ open: ui('开放'), cloze: ui('填空'), flashcard: ui('闪卡'), quiz: ui('单选'), multi: ui('多选') })[kind] || kind;
/** What a mock paper leaves out, by kind: "开放 1 道、闪卡 17 道". */
export const leftOutText = leftOut => formatList(Object.entries(leftOut || {}).filter(([, n]) => n > 0).map(([kind, n]) => uiFormat('{0} {1} 道', [kindLabel(kind), n])));
