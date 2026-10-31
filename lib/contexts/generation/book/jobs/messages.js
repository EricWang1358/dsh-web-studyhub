/* The wording of a 复习全书 build, in the language the learner asked it in. Chinese is the source text; English sits beside it, so no entry is needed in
   lib/application-messages-en.js. This is the only file of the folder that holds such text. */
import { inventoryStageText } from '../../inventory/messages.js';

const say = (language, zh, en) => (language === 'en' ? en : zh);

export const BOOK_JOB_TITLE = '生成复习全书';

/** The name of the notes record of a course. */
export const notesTitle = (language, course) => say(language, `复习全书 · ${course || '未分类课程'}`, `Review book · ${course || 'Uncategorised'}`);
/** The name of the task in the console. */
export const jobTitle = (language, course) => say(language, `生成复习全书 · ${course || '未分类课程'}`, `Write the review book · ${course || 'Uncategorised'}`);

const OUTLINE_STAGE = {
  cluster: ['整理总纲：把清点出的概念归成知识点', 'Organising the outline: grouping the inventory into knowledge points'],
  order: ['整理总纲：排章节', 'Organising the outline: arranging the chapters'],
  map: ['整理总纲：把资料归成知识点', 'Organising the outline: grouping the materials'],
  reduce: ['整理总纲：排章节', 'Organising the outline: arranging the chapters'],
  paper: ['整理总纲：对照样卷', 'Organising the outline: reading the sample papers'],
  saving: ['整理总纲：检查', 'Organising the outline: checking'],
};

/** What the model writes after anything that is not in the materials (the writing brief asks for exactly this mark). */
export const outsideMark = language => say(language, '（资料以外）', '(beyond the materials)');
/** How the writer names a must item at its first explanation, so the program finds it: the material's own name verbatim, a bilingual one as 中文（English）. */
export const namingRule = language => say(language,
  'Where a must item is first explained, write its name exactly as the checklist gives it; when the material names it in English, write it once as '
    + '中文（English）, e.g. 威胁建模（threat modelling）.',
  'Where a must item is first explained, write its name exactly as the checklist gives it (a name in another language once with its gloss in brackets).');

export function stageText(language, stage, state) {
  const { leaves } = state, exam = `${Math.min(state.exam.done + 1, state.exam.total)}/${state.exam.total}`;
  const outline = OUTLINE_STAGE[state.outline?.stage];
  const kept = state.kept ? say(language, `，沿用 ${state.kept} 个没变的`, `, ${state.kept} unchanged kept`) : '';
  const short = state.short ? say(language, `；${state.short} 个未达标（缺的概念已标出，「补漏」只补这些）`,
    `; ${state.short} short (the missing concepts are marked; Fill the gaps does only those)`) : '';
  const dropped = state.dropped ? say(language, `；${state.dropped} 处引文在原文里找不到，已去掉`, `; ${state.dropped} quote(s) not found in the original were left out`) : '';
  const missed = state.missed ? say(language, `；${state.missed} 处没写成，下次「更新全书」只补这些`, `; ${state.missed} part(s) not written; Update the book does only those`) : '';
  return {
    queued: say(language, '等待开始', 'Waiting to start'),
    checking: say(language, '正在查看这门课的总纲和资料', 'Looking over the course outline and materials'),
    inventory: inventoryStageText(language, state.inventory ?? { done: 0, total: 0, failed: 0 }),
    outline: outline ? say(language, outline[0], outline[1]) : say(language, '正在整理总纲', 'Organising the outline'),
    place: say(language, '正在把没归位的概念放进知识点', 'Placing the concepts no knowledge point holds'),
    write: say(language, `正在写、审阅、修复讲解：${leaves.done}/${leaves.total} 个知识点（达标 ${leaves.ok}，未达标 ${leaves.short}）`,
      `Writing, reviewing and repairing: ${leaves.done}/${leaves.total} knowledge points (${leaves.ok} complete, ${leaves.short} short)`),
    exam: say(language, `正在写考情 ${exam}`, `Writing what the sample papers test ${exam}`),
    saving: say(language, '正在检查并保存', 'Checking and saving'),
    complete: state.unchanged ? say(language, '复习全书已是最新，没有改动', 'The review book is up to date; nothing changed')
      : `${say(language, `复习全书已保存：${state.saved} 个知识点${kept}`, `Review book saved: ${state.saved} knowledge points${kept}`)}${short}${dropped}${missed}`,
    cancelled: say(language, '已取消，没有保存复习全书（已读的资料清点会沿用）', 'Cancelled; no review book was saved (the inventory read so far is kept)'),
    paused: say(language, '已暂停，点「继续」接着做', 'Paused; resume to go on'),
  }[stage] ?? '';
}
export const FAILURES = Object.freeze({
  unreadable: (language, where) => say(language,
    `${where}时模型两次都没有给出可用的答案，没有保存复习全书；可以重试，已完成的部分会沿用`,
    `The model gave no usable answer twice while ${where}; no review book was saved. You can retry; what was done is kept`),
  saveInvalid: language => say(language, '复习全书没能保存：写出的内容没有通过检查。没有保存任何内容；可以重试，已完成的部分会沿用',
    'The review book could not be saved: what was written did not pass the checks. Nothing was saved. You can retry; what was done is kept'),
  saveFailed: language => say(language, '复习全书没能保存到资料库。没有保存任何内容；可以重试，已完成的部分会沿用',
    'The review book could not be saved to the library. Nothing was saved. You can retry; what was done is kept'),
});

export const REFUSALS = Object.freeze({
  'course-book-no-course': language => say(language, '请先选一门课程再生成复习全书', 'Choose a course before writing its review book'),
  'course-book-no-materials': language => say(language, '这门课还没有资料，没有可讲解的', 'This course has no materials to explain yet'),
  'course-book-needs-newer': (language, { needs, running } = {}) => say(language,
    `这本书是更新版本的 StudyHub 写的：更新它至少要 ${needs}，现在是 ${running}。请升级后再更新；没有写入任何内容`,
    `This book was written by a newer StudyHub: updating it needs at least ${needs}, and this is ${running}. Please upgrade first. Nothing was written`),
  'course-book-outline-running': language => say(language, '总纲正在整理；整理完再生成复习全书', 'The course outline is being organised; write the review book when it is done'),
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能生成复习全书', 'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});

/** The description of the build call in the contract (what a tool or a person reads about it). */
export const BUILD_DESCRIPTION = [
  'Write the review book (复习全书) of one course as one background job, a quality workflow: (1) the inventory of every page range of every material (parallel at ',
  'the text concurrency, quotes checked word for word, an unchanged range never read again); (2) the course outline (总纲) built from it when it is missing, out of ',
  'date or not built from it; (3) per knowledge point a must-cover checklist of its items (by the detail level `coverage`); (4) every point written in parallel ',
  'from its own pages (a big one in passes), reviewed by an independent call and repaired at most twice; a point still missing concepts is kept and marked short, ',
  'and the job ends partial; (5) 考情 with sample papers (recognised by name and used by default; `papers` overrides: each the key, document id ',
  'or a page id of a material of the course, the pages of one material one paper); (6) one write of the notes, their ',
  'coverage and a glossary. A rebuild asks only what changed or is short; `point` fills the gaps of one point. The book is a reference, never course material. ',
  'Refusals carry a code (course-book-no-course, course-book-no-materials, course-book-outline-running, course-book-needs-newer, and the outline\'s own) and cost nothing. ',
  '`rebuildOutline: true` over the learner\'s own text in the book is refused (course-outline-book-confirm) until `confirm: true`: ask the learner first.',
].join('');
