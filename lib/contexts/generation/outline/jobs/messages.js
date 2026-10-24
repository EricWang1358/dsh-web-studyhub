/* The wording of a 课程总纲 build, in the language the learner asked it in. Chinese is the source text; English sits beside it, so no entry is needed in
   lib/application-messages-en.js. This is the only file of the folder that holds such text. */
import { inventoryStageText } from '../../inventory/messages.js';

const say = (language, zh, en) => (language === 'en' ? en : zh);

export const OUTLINE_JOB_TITLE = '整理总纲';

/** The name of the outline record of a course. */
export const outlineTitle = (language, course) => say(language, `总纲 · ${course || '未分类课程'}`, `Course outline · ${course || 'Uncategorised'}`);
/** The name of the task in the console. */
export const jobTitle = (language, course) => say(language, `整理总纲 · ${course || '未分类课程'}`, `Organise the outline · ${course || 'Uncategorised'}`);

export function stageText(language, stage, state) {
  const part = `${Math.min(state.map.done + 1, state.map.total)}/${state.map.total}`;
  const paper = `${Math.min(state.papers.done + 1, state.papers.total)}/${state.papers.total}`;
  const other = state.leftover ? say(language, `；${state.leftover} 处资料放在「其他」`, `; ${state.leftover} material part(s) are under Other`) : '';
  const skipped = state.papersSkipped ? say(language, `；${state.papersSkipped} 份像样卷的资料没有可读文字，没有用上`,
    `; ${state.papersSkipped} material(s) that look like sample papers have no readable text and were not used`) : '';
  const saved = say(language, `总纲已保存：${state.chapters} 章、${state.leaves} 个知识点`, `Course outline saved: ${state.chapters} chapters, ${state.leaves} knowledge points`);
  const over = state.overCap ? say(language, `；比 maxPoints 多 ${state.overCap} 个：章与章之间的知识点不合并`,
    `; ${state.overCap} above maxPoints: points of different chapters are never merged`) : '';
  return {
    queued: say(language, '等待开始', 'Waiting to start'),
    checking: say(language, '正在查看这门课的资料', 'Looking over the course materials'),
    inventory: inventoryStageText(language, state.inventory ?? { done: 0, total: 0, failed: 0 }),
    map: say(language, `正在把资料归成知识点 ${part}`, `Grouping the materials into knowledge points ${part}`),
    cluster: say(language, `正在把清点出的概念归成知识点 ${Math.min((state.cluster?.done ?? 0) + 1, state.cluster?.total ?? 0)}/${state.cluster?.total ?? 0}`,
      `Grouping the inventory into knowledge points ${Math.min((state.cluster?.done ?? 0) + 1, state.cluster?.total ?? 0)}/${state.cluster?.total ?? 0}`),
    order: say(language, '正在排成章节，定学习顺序', 'Arranging chapters and sections in learning order'),
    reduce: say(language, '正在排成章节，定学习顺序', 'Arranging chapters and sections in learning order'),
    paper: say(language, `正在对照样卷 ${paper}：哪些知识点考过`, `Reading sample paper ${paper}: which knowledge points it tests`),
    saving: say(language, '正在检查并保存', 'Checking and saving'),
    complete: `${saved}${over}${other}${skipped}`,
    cancelled: say(language, '已取消，没有保存总纲', 'Cancelled; no course outline was saved'),
    paused: say(language, '已暂停，点「继续」接着做', 'Paused; resume to go on'),
  }[stage] ?? '';
}

export const FAILURES = Object.freeze({
  unreadable: (language, where) => say(language,
    `${where}时模型两次都没有给出可用的答案，没有保存总纲；可以重试，已完成的部分会沿用`,
    `The model gave no usable answer twice while ${where}; no course outline was saved. You can retry; what was done is kept`),
  empty: language => say(language, '模型没有排出任何章节，没有保存总纲；可以重试', 'The model arranged no chapter; no course outline was saved. You can retry'),
  saveInvalid: language => say(language, '总纲没能保存：整理出的内容没有通过检查。没有保存任何内容；可以重试，已完成的部分会沿用',
    'The course outline could not be saved: what was made did not pass the checks. Nothing was saved. You can retry; what was done is kept'),
  saveFailed: language => say(language, '总纲没能保存到资料库。没有保存任何内容；可以重试，已完成的部分会沿用',
    'The course outline could not be saved to the library. Nothing was saved. You can retry; what was done is kept'),
});

/** The last chapter of an outline built from the inventory: what the model could not place, never dropped. */
export const UNPLACED_WORDS = language => ({ unplacedChapter: say(language, '其他 / 未归位', 'Other / not placed'),
  unplacedLeaf: say(language, '未归位的概念', 'Concepts not placed'),
  unplacedIntro: say(language, '清点出来、但没有归进上面任何知识点的术语与概念。', 'Terms and concepts of the inventory that no knowledge point above holds.') });

/** Where a failure happened, said both ways. */
export const WHERE = Object.freeze({
  map: (language, part) => say(language, `把资料归成知识点（第 ${part} 批）`, `grouping the materials (batch ${part})`),
  reduce: language => say(language, '排章节', 'arranging the chapters'),
  paper: language => say(language, '对照样卷', 'reading the sample paper'),
});

export const REFUSALS = Object.freeze({
  'course-outline-no-course': language => say(language, '请先选一门课程再整理总纲', 'Choose a course before organising its outline'),
  'course-outline-no-materials': language => say(language, '这门课还没有资料，没有可整理的', 'This course has no materials to organise yet'),
  'course-outline-paper-invalid': language => say(language, '选作样卷的资料不在这门课里（最多 20 份）', 'A material chosen as a sample paper is not in this course (at most 20)'),
  'course-outline-no-readable-text': language => say(language, '选作样卷的资料里没有可读的文字（只有图片？）', 'A chosen sample paper has no readable text (pictures only?)'),
  'course-outline-supersedes-invalid': language => say(language, '要替换的总纲不存在，或不是总纲', 'The course outline to replace does not exist or is not a course outline'),
  'course-outline-no-outline': language => say(language, '这门课还没有总纲，先生成总纲再标样卷', 'This course has no outline yet; generate it before marking sample papers'),
  'course-outline-book-running': language => say(language, '复习全书正在生成，会一并整理总纲；等它完成再试', 'The review book is being made and organises the outline too; try again when it is done'),
  'course-outline-book-confirm': (language, titles = []) => say(language,
    `这门课的复习全书里有你自己写的内容（${titles.length} 个知识点：${titles.slice(0, 3).map(title => `「${title}」`).join('')}${titles.length > 3 ? ' 等' : ''}）。`
      + '重新整理总纲后，它们会按页跟到新的知识点；新知识点和它们的页对不上的，会先放进「未归位」并写明最接近的知识点。确定要重新整理，请带上 confirm: true 再发一次',
    `The review book of this course holds your own text (${titles.length} knowledge point(s): ${titles.slice(0, 3).map(title => `"${title}"`).join(', ')}`
      + `${titles.length > 3 ? ', …' : ''}). Organising the outline again moves it by pages to the new knowledge points; what matches no new point waits in Not placed, `
      + 'naming the closest one. To go on, send the request again with confirm: true'),
  'course-outline-shape-invalid': (language, { field, value, max } = {}) => (field === 'granularity'
    ? say(language, `granularity 只能是 coarse、medium 或 fine（收到 ${JSON.stringify(value)}）`, `granularity is one of coarse, medium or fine (got ${JSON.stringify(value)})`)
    : say(language, `maxPoints 要是 1 到 ${max} 之间的整数（收到 ${JSON.stringify(value)}）`, `maxPoints is a whole number from 1 to ${max} (got ${JSON.stringify(value)})`)),
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能整理总纲', 'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});

/** The description of the build call in the contract (what a tool or a person reads about it). */
export const BUILD_DESCRIPTION = [
  'Organise the course outline (总纲) of one course as one background job: the course\'s materials (any number of them) are described compactly to the model ',
  '(names, chapters, question counts and topics, numbering and date hints, the syllabus text when the course has one), grouped into knowledge points in batches, ',
  'then arranged into chapters and sections (at most three levels) in learning order, with a short introduction for each. Copies and tiny notes are merged into ',
  'the knowledge point they belong to; what the model leaves out is kept under Other. Optional `papers` (document keys of the course) mark the knowledge points ',
  'a sample paper tests (样卷考过 N/M) from verbatim quotes of the paper. The outline is a reference, never course material: it cannot be used to make questions. ',
  'A rebuild replaces the course\'s current outline (kept as an archived version). `papersOnly: true` keeps the current outline\'s chapters and knowledge points ',
  '(the same ids, no regrouping) and only marks them again with `papers`. Refusals carry a code (course-outline-no-course, course-outline-no-materials, ',
  'course-outline-paper-invalid, course-outline-no-readable-text, course-outline-supersedes-invalid, course-outline-no-outline, course-outline-book-running, ',
  'course-outline-shape-invalid, course-outline-book-confirm) and cost nothing. `granularity` (coarse | medium | fine) says how big a knowledge point is; ',
  '`maxPoints` caps the knowledge points (neighbouring ones are merged, nothing dropped); unset, the outline is cut as before; both are kept for later rebuilds ',
  '(null removes one). While the review book of the course holds the own text of the learner a rebuild is refused (course-outline-book-confirm, naming those points) ',
  'until `confirm: true`: ask the learner first; their text then follows its pages, and text whose pages went mostly elsewhere waits in 未归位 of the book. ',
  'A stop or a failure saves nothing; ',
  'a retry goes on from the model calls that finished.',
].join('');
