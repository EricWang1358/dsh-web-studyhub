import { ui, uiFormat } from '../i18n.js';

/* The words of 知识点查缺 on the draft page (ui/coverage/PointGaps.jsx), in one file that loads with it: the count line, the list, the one action and what is said
   when it starts, and the one quiet line when the course has no outline to count by (`coverage.get`'s `points`, lib/evidence/point-report.js). */

/** 「70 个知识点，17 个还没有题」, or 「70 个知识点都有题了」. */
export const pointsLine = (report) => (report.uncovered > 0 ? uiFormat('{0} 个知识点，{1} 个还没有题', [report.points, report.uncovered])
  : uiFormat('{0} 个知识点都有题了', [report.points]));

/** How a question is counted for a knowledge point (the HelpTip beside the line). */
export const pointsTip = () => ui('知识点来自这门课的总纲。一道题的出处落在某个知识点清点出的原文上，就算它有题；落不到的，算给出处所在页的知识点。整门课的题组和草稿里的题都算。');

/** The fold's summary. */
export const pointsListLabel = () => ui('还没有题的知识点');

/** The mark of a point others rest on, and its explanation. */
export const prereqMark = () => ui('前置');
export const prereqTip = (point) => uiFormat('有 {0} 个知识点建立在它之上，先补它。', [point.dependents]);

/** What a point rests on. */
export const restsOnLine = (point) => uiFormat('先学：{0}', [point.prereqs.join(ui('、'))]);

/** A point with no verified text in this draft's materials. */
export const noTextLine = () => ui('资料里找不到它的原文，补不了');

/** The points left out of the list. */
export const moreLine = (more) => uiFormat('还有 {0} 个没列出，补完上面的再看。', [more]);

/** Questions that reach no point (not counted above). */
export const unplacedLine = (count) => uiFormat('另有 {0} 道题落不到任何知识点上，没有算进来。', [count]);

/** The one action, and what it will do. */
export const topUpLabel = () => ui('补这些知识点');
export const topUpPlan = (topUp, uncovered) => (topUp.pointIds.length < uncovered
  ? uiFormat('补其中 {0} 个，约 {1} 题；一轮补不完的下次再补。', [topUp.pointIds.length, topUp.questions])
  : uiFormat('补 {0} 个知识点，约 {1} 题。', [topUp.pointIds.length, topUp.questions]));

/** What is said once it has started (ui/coverage/top-up.js topUpArgs `notice`). */
export const pointsNotice = (count) => (draft, started) => uiFormat('已开始为「{0}」补 {1} 个知识点，约 {2} 题；通过检查后会保存到同一份草稿。',
  [draft.title, count, started?.coverage?.questions ?? 0]);

/** Why there are no numbers, and where to get them (the 总纲 page). */
export const unavailableLine = (reason) => ({
  'no-outline': ui('这门课还没有总纲，不能按知识点查缺：到「总纲」页点「生成总纲」。'),
  descriptors: ui('这门课的总纲是按资料名整理的旧版本，不能按知识点查缺：到「总纲」页点「用清点结果重新整理总纲」。'),
  'no-inventory': ui('这门课的总纲缺少清点结果，不能按知识点查缺：到「总纲」页重新整理总纲。'),
  stale: ui('资料有更新，总纲要重新整理后才能按知识点查缺：到「总纲」页重新整理。'),
}[reason] ?? null);
