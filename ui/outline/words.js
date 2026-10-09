/* 总纲 page: its words. Every string is a literal ui() / uiFormat() call, so the English catalogue (ui/locales/en.outline.json) is checked against it. */
import { ui, uiFormat } from '../i18n.js';
import { displayTitle } from '../../lib/document-title.js';

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
export const startedText = already => (already ? ui('总纲已经在整理，进度在任务页。') : ui('已开始整理总纲，进度在任务页。'));
