/* 总纲 page: its words. Every string is a literal ui() / uiFormat() call, so the English catalogue (ui/locales/en.outline.json) is checked against it. */
import { ui, uiFormat } from '../i18n.js';
import { displayTitle } from '../../lib/document-title.js';

/** The title of a row: a document's display name, a chapter's own title, the front matter, or the questions of a document no chapter holds. */
export function rowTitle(row) {
  if (row.kind === 'unplaced') return ui('未归位');
  if (row.kind === 'rest') return ui('没对上章节的题');
  if (row.kind === 'chapter') return row.node.front ? ui('开头部分') : row.node.title || ui('未命名章节');
  return displayTitle(row.node.title);
}

/** Why a question has no place in the outline. */
export function reasonText(reason) {
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

export const moreText = count => uiFormat('还有 {0} 题没列出，「练这一节」会一起练。', [count]);
