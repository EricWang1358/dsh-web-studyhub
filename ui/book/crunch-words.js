/* 期末一周 (M7): the words of the plan's days, points and mock paper. Every sentence is a literal ui() / uiFormat() call (the English is in
   ui/locales/en.outline.json); the plan itself (lib/crunch-plan.js) only gives codes and numbers. */
import { ui, uiFormat } from '../i18n.js';
import { formatList, joinMeta } from '../format.js';

/** The one line of why a day holds what it holds (lib/crunch-plan.js `reason`). */
export function reasonText(reason) {
  const r = reason || {};
  switch (r.code) {
    case 'learn': return uiFormat('先学考得多又薄弱的 {0} 个知识点（{1} 个样卷考过）：每个读完练 5 道，约 {2} 分钟。', [r.count, r.tested, r.minutes]);
    case 'learn-size': return uiFormat('样卷没有考情，各知识点一样重：先学最薄弱的 {0} 个，每个读完练 5 道，约 {1} 分钟。', [r.count, r.minutes]);
    case 'learn-over': return uiFormat('知识点多于时间：这一天合并了 {0} 个，约 {1} 分钟，超过每天的 {2} 分钟。', [r.count, r.minutes, r.capacity]);
    case 'learn-free': return ui('这一天没有新的知识点：复习到期和薄弱的题。');
    case 'flip': return uiFormat('不再做新题：翻看 {0} 个知识点，易错点多的先看（共 {1} 条易错点）。', [r.count, r.pitfalls]);
    case 'flip-mock': return uiFormat('考前最后一天：翻看剩下的 {0} 个知识点，再做一套模拟卷。', [r.count]);
    case 'exam-today': return uiFormat('今天考试：只翻看 {0} 个知识点的易错点。', [r.count]);
    case 'off': return ui('这一天休息。');
    case 'done': return uiFormat('这一天做完了 {0} 个知识点。', [r.count]);
    default: return '';
  }
}

/** What a day is, in a few words: 学习日 / 翻看日 / 翻看日 · 模拟卷 / 休息. */
export const dayKind = day => (day?.mode === 'flip' ? (day.mock ? joinMeta([ui('翻看日'), ui('模拟卷')]) : ui('翻看日')) : day?.mode === 'off' ? ui('休息') : ui('学习日'));

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
