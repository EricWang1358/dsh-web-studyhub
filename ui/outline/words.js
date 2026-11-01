/* 总纲 page: its words. Every string is a literal ui() / uiFormat() call, so the English catalogue (ui/locales/en.outline.json) is checked against it. */
import { ui, uiFormat } from '../i18n.js';
import { displayTitle } from '../../lib/document-title.js';
import { formatNumber } from '../format.js';

/** A chapter's name under a leaf of the AI outline: with its material, so the learner knows which one it is. */
function anchorTitle(node) {
  if (node.kind === 'document') return node.copies > 1 ? uiFormat('{0}（{1} 份同名）', [displayTitle(node.title), node.copies]) : displayTitle(node.title);
  const own = node.kind === 'rest' ? ui('没对上章节的题') : node.front ? ui('开头部分') : node.title || ui('未命名章节');
  return node.material ? `${displayTitle(node.material)} · ${own}` : own;
}

/** The title of a row: a document's display name, a chapter's own title, the front matter, or the questions of a document no chapter holds. */
export function rowTitle(row) {
  if (row.kind === 'part' || row.kind === 'section' || row.kind === 'point') return row.node.title;
  if (row.kind === 'other') return ui('其他');
  if (row.kind === 'anchor') return anchorTitle(row.node);
  if (row.kind === 'unplaced') return ui('未归位');
  if (row.kind === 'rest') return ui('没对上章节的题');
  if (row.kind === 'chapter') return row.node.front ? ui('开头部分') : row.node.title || ui('未命名章节');
  return displayTitle(row.node.title);
}

/** Why a question has no place in the outline. */
export function reasonText(reason) {
  if (reason === 'uncategorised') return ui('引用的资料没有归入这门课');
  if (reason === 'elsewhere') return ui('引用的是别的课程或已归档的资料');
  if (reason === 'missing') return ui('引用的资料已不在资料库');
  return ui('没有引用资料');
}

/** The hover explanation of the page (the one Tooltip): what the outline is and how a round orders its questions. */
export const whatText = limit => uiFormat('总纲把这门课的资料按「资料 → 章节」排开，每道题放在它引用的那一处；引用了两处的题两处都列出，合计只算一次。练习时按 到期 → 薄弱 → 新题 的顺序出题，不按总纲的顺序；一轮最多 {0} 题。', [limit]);

/** A practice round of more questions than one round takes. */
export const cappedText = (total, limit) => uiFormat('共 {0} 题，一轮最多 {1} 题：先练到期、薄弱和新题里排在前面的 {1} 题。', [total, limit]);

/** The 练这一节 button of a row: 接着练 i/n when a round of exactly its questions is unfinished. */
export const practiceLabel = resume => (resume ? uiFormat('接着练 {0}/{1}', [resume.index + 1, resume.total]) : ui('练这一节'));

/** The selection bar. */
export const pickedText = count => uiFormat('已选 {0} 题', [count]);
export const startPickedText = count => uiFormat('练选中的 {0} 题', [count]);

/** The line under the title: how many materials, and the drafts that are not counted. */
export function courseLine(outline) {
  return [uiFormat('{0} 份资料', [outline.documents.length]), outline.draftCards > 0 && uiFormat('草稿里另有 {0} 题（发布后计入）', [outline.draftCards])].filter(Boolean).join(' · ');
}

/** Under 未归位, when some of its questions cite materials filed under no course: which ones, and that filing them under the course places the questions. */
export const unfiledText = (names, count = names.length) => uiFormat('把这些资料归入这门课后，引用它们的题会出现在总纲里：{0}', [names.join(' · ')])
  + (count > names.length ? uiFormat('等 {0} 份', [count]) : '');

export const moreText = count => uiFormat('还有 {0} 题没列出，「练这一节」会一起练。', [count]);

/* ---------- the AI outline (课程总纲 step 2) ---------- */

/** The number of a row of the outline: 第 1 章 for a chapter, 1.2 and 1.2.3 under it. */
export const numberText = row => (row.kind === 'part' ? uiFormat('第 {0} 章', [row.number]) : row.number);

/** The hover explanation when the page shows the AI outline. */
export const bookWhatText = limit => uiFormat('总纲由模型把这门课的资料整理成「章 → 节 → 知识点」，只是参考：题目的出处仍是原来的资料。每个知识点下的题按它对应的资料和章节实时计算；没归入章节的资料在「其他」。练习时按 到期 → 薄弱 → 新题 的顺序出题，不按总纲的顺序；一轮最多 {0} 题。', [limit]);

const BASIS = { syllabus: basis => (basis.syllabus ? uiFormat('讲义大纲《{0}》的顺序', [basis.syllabus]) : ui('讲义大纲的顺序')), numbering: () => ui('资料标题里的编号'),
  dates: () => ui('录音的日期'), logic: () => ui('先学什么、后学什么的道理') };
/** What the learning order of the outline rests on, as the build recorded it. */
export function basisText(basis) {
  const parts = (basis?.codes || []).map(code => BASIS[code]?.(basis)).filter(Boolean);
  return parts.length ? uiFormat('学习顺序依据：{0}', [parts.join(' · ')]) : ui('学习顺序依据：资料导入的先后');
}

/** The tier of a point when the outline rests on sample papers: 样卷考过（N/M 份） or 补充. */
export const tierText = (node, papers) => (node.tier === 'must' ? uiFormat('样卷考过（{0}/{1} 份）', [node.papers, papers]) : ui('补充'));

/** Under 其他: how many rows of the materials no chapter of the outline holds. */
export const otherText = count => uiFormat('{0} 处资料没有归入上面的章节', [count]);

/** The line of a running build. */
export const runningText = run => (run.total ? uiFormat('正在整理总纲（{0}/{1} 步）…', [Math.min(run.done + 1, run.total), run.total]) : ui('正在整理总纲…'));

/** The offer above the materials when the course has no outline yet. */
export const offerText = count => uiFormat('现在按资料排开（{0} 份）。生成总纲会让模型把它们整理成像书一样的「章 → 节 → 知识点」，按学习顺序排好，合并重复的资料和零碎的笔记；过程在后台，进度在任务页。', [count]);

/** The toast of a start. */
/** What 重新整理 does to the learner's notes, on hover. */
export const rebuildTipText = () => ui('整理好后不会马上动你写的内容：要换位置时，打开复习全书先列出每一处，由你决定。');
export const startedText = already => (already ? ui('总纲已经在整理，进度在任务页。') : ui('已开始整理总纲，进度在任务页。'));

/* ---------- 复习全书 (the explanation layer on the outline) ---------- */

/** One line on what the 复习全书 is, above the outline of a course that has no written book yet (the sidebar's 复习全书 leads here until it is). */
export const bookIntroText = () => ui('复习全书：按总纲给每个知识点写一段讲解，带出处和题目链接；写好后在书页里读，点题目就去练。');

/** The line of a running 复习全书 build. */
export const writingText = run => (run.total ? uiFormat('正在生成复习全书（{0}/{1} 步）…', [Math.min(run.done + 1, run.total), run.total]) : ui('正在生成复习全书…'));

/** The toast of a 复习全书 start. */
export const bookStartedText = already => (already ? ui('复习全书已经在生成，进度在任务页。') : ui('已开始生成复习全书，进度在任务页。'));

/* ---------- 讲解详尽程度 (settings.book.coverage) and 覆盖 ---------- */

const LEVEL_WORDS = { brief: () => ui('精简'), standard: () => ui('标准'), full: () => ui('详尽') };
/** The name of a level. */
export const levelText = level => (LEVEL_WORDS[level] || LEVEL_WORDS.standard)();
const LEVEL_TIPS = {
  brief: () => ui('精简：必须讲到的只算术语、定义、概念和公式，其余作为可选；每个知识点照样读它的全部页。'),
  standard: () => ui('标准：再加上步骤、规则和易错提醒必须讲到；资料强调的、样卷考到的一律必讲。'),
  full: () => ui('详尽：资料里清点出的每一条都必须讲到，例子和论断也算；修复的调用可能更多。'),
};
/** What a level means (the Select's hover explanation): which checklist items are a must; the cost is not estimated. */
export const levelTip = level => (LEVEL_TIPS[level] || LEVEL_TIPS.standard)();
/** The levels as Select options, each with its explanation. */
export const levelOptions = () => ['brief', 'standard', 'full'].map(level => ({ value: level, label: levelText(level), tip: levelTip(level) }));
/** What the level choice is, said once beside it. */
export const levelHint = () => ui('讲解详尽程度：哪些概念必须讲到，审阅按这张清单检查。改了以后，下次「更新全书」按新的清单重写讲解；用了多少在任务页看。');

/** 「覆盖：读了 N/M 页」 of one point: pages where its sources have them, else characters. */
export function coverageText(coverage) {
  if (coverage.unit === 'page') return coverage.partial ? uiFormat('覆盖：读了 {0}/{1} 页，另有 {2} 页只读了开头', [coverage.read, coverage.total, coverage.partial])
    : uiFormat('覆盖：读了 {0}/{1} 页', [coverage.read, coverage.total]);
  return uiFormat('覆盖：读了 {0}/{1} 字', [formatNumber(coverage.read), formatNumber(coverage.total)]);
}
/** The hover explanation of 读更多. */
export const readMoreTip = level => uiFormat('只重新读这一个知识点，按「{0}」多读几页再写讲解；单独一个任务，进度在任务页。', [levelText(level)]);
/** The toast of a 读更多 start. */
export const readMoreStartedText = already => (already ? ui('复习全书已经在生成，进度在任务页。') : ui('已开始多读这个知识点，进度在任务页。'));

/** The book line's 讲解覆盖: the share of the points' materials their explanations read, and how many read only some of theirs. */
export function bookCoverageText(coverage) {
  if (!coverage?.total) return '';
  const percent = Math.floor((coverage.read / coverage.total) * 100);
  return coverage.partial ? uiFormat('讲解覆盖：读了资料的 {0}%，{1} 个知识点只读了一部分（展开知识点可「读更多」）', [percent, coverage.partial])
    : uiFormat('讲解覆盖：读了资料的 {0}%', [percent]);
}

/** The heading of one part of a point read in passes: 「第 a–b 页」, with the material's name when the parts read more than one material. */
export function partHeadingText(part, named) {
  const place = range => (range.unit === 'page' ? (range.from === range.to ? uiFormat('第 {0} 页', [range.from]) : uiFormat('第 {0}–{1} 页', [range.from, range.to]))
    : range.unit === 'char' ? uiFormat('第 {0}–{1} 字', [range.from, range.to]) : '');
  const shown = part.ranges.slice(0, 3).map(range => (named || range.unit === 'whole' ? [displayTitle(range.material), place(range)].filter(Boolean).join(' · ') : place(range)));
  const text = shown.join(' / ');
  return part.ranges.length > 3 ? uiFormat('{0} 等 {1} 份', [text, part.ranges.length]) : text;
}
/** The sample papers a build uses, said without opening anything: their names, and whether they were recognised by name (the learner can change them). */
export const usedPapersText = (titles, auto) => uiFormat(auto ? '依据样卷：{0}（按名称自动识别，可更改）' : '依据样卷：{0}', [titles.join(ui('、'))]);
/** A point's concept coverage: the must items of its checklist its explanation covers. */
export const conceptsText = concepts => uiFormat('概念覆盖 {0}/{1}', [concepts.covered, concepts.total]);
/** A point still short after its repairs (never claimed complete). */
export const shortText = missing => uiFormat('未达标：缺 {0} 个概念', [missing]);
/** The hover explanation of 补漏. */
export const fillGapsTip = () => ui('只为这一个知识点补上缺的概念：按缺的清单审阅、修复，不重写已经讲好的部分；单独一个任务，进度在任务页。');
/** The book's coverage at three levels: the materials and pages the inventory read, the knowledge points complete, the concepts covered. */
export const levelsText = levels => uiFormat('覆盖：资料用了 {0}/{1} 份、页 {2}/{3}；知识点达标 {4}/{5}；概念 {6}/{7}', [levels.documents.used, levels.documents.total,
  levels.pages.read, levels.pages.total, levels.leaves.ok, levels.leaves.total, levels.items.covered, levels.items.total]);
