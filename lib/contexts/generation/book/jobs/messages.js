/* The wording of a 复习全书 build, in the language the learner asked it in. Chinese is the source text; English sits beside it, so no entry is needed in
   lib/application-messages-en.js. This is the only file of the folder that holds such text. */
const say = (language, zh, en) => (language === 'en' ? en : zh);

export const BOOK_JOB_TITLE = '生成复习全书';

/** The name of the notes record of a course. */
export const notesTitle = (language, course) => say(language, `复习全书 · ${course || '未分类课程'}`, `Review book · ${course || 'Uncategorised'}`);
/** The name of the task in the console. */
export const jobTitle = (language, course) => say(language, `生成复习全书 · ${course || '未分类课程'}`, `Write the review book · ${course || 'Uncategorised'}`);

const OUTLINE_STAGE = {
  map: ['整理总纲：把资料归成知识点', 'Organising the outline: grouping the materials'],
  reduce: ['整理总纲：排章节', 'Organising the outline: arranging the chapters'],
  paper: ['整理总纲：对照样卷', 'Organising the outline: reading the sample papers'],
  saving: ['整理总纲：检查', 'Organising the outline: checking'],
};

export function stageText(language, stage, state) {
  const notes = `${Math.min(state.notes.done + 1, state.notes.total)}/${state.notes.total}`, exam = `${Math.min(state.exam.done + 1, state.exam.total)}/${state.exam.total}`;
  const outline = OUTLINE_STAGE[state.outline?.stage];
  const kept = state.kept ? say(language, `，沿用 ${state.kept} 个没变的`, `, ${state.kept} unchanged kept`) : '';
  const dropped = state.dropped ? say(language, `；${state.dropped} 处引文在原文里找不到，已去掉`, `; ${state.dropped} quote(s) not found in the original were left out`) : '';
  const missed = state.missed ? say(language, `；${state.missed} 个知识点模型没有写，下次「更新全书」会补`,
    `; the model wrote nothing for ${state.missed} point(s); Update the book tries them again`) : '';
  return {
    queued: say(language, '等待开始', 'Waiting to start'),
    checking: say(language, '正在查看这门课的总纲和资料', 'Looking over the course outline and materials'),
    outline: outline ? say(language, outline[0], outline[1]) : say(language, '正在整理总纲', 'Organising the outline'),
    notes: say(language, `正在写讲解 ${notes}`, `Writing the explanations ${notes}`),
    exam: say(language, `正在写考情 ${exam}`, `Writing what the sample papers test ${exam}`),
    saving: say(language, '正在检查并保存', 'Checking and saving'),
    complete: state.unchanged ? say(language, '复习全书已是最新，没有改动', 'The review book is up to date; nothing changed')
      : `${say(language, `复习全书已保存：${state.leaves} 个知识点${kept}`, `Review book saved: ${state.leaves} knowledge points${kept}`)}${dropped}${missed}`,
    cancelled: say(language, '已取消，没有保存复习全书', 'Cancelled; no review book was saved'),
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

/** Where a failure happened, said both ways. */
export const WHERE = Object.freeze({
  notes: (language, part) => say(language, `写讲解（第 ${part} 批）`, `writing the explanations (batch ${part})`),
  exam: (language, part) => say(language, `写考情（第 ${part} 批）`, `writing what the papers test (batch ${part})`),
});

export const REFUSALS = Object.freeze({
  'course-book-no-course': language => say(language, '请先选一门课程再生成复习全书', 'Choose a course before writing its review book'),
  'course-book-no-materials': language => say(language, '这门课还没有资料，没有可讲解的', 'This course has no materials to explain yet'),
  'course-book-outline-running': language => say(language, '总纲正在整理；整理完再生成复习全书', 'The course outline is being organised; write the review book when it is done'),
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能生成复习全书', 'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});

/** The description of the build call in the contract (what a tool or a person reads about it). */
export const BUILD_DESCRIPTION = [
  'Write the review book (复习全书) of one course as one background job: for each knowledge point of the course outline (总纲) a condensed, beginner-friendly ',
  'explanation from its own materials (key points, explanation, a worked example when the materials have one, what goes beyond the materials marked as extra) with ',
  'citation marks to quotes found word for word in the original; with sample papers also what the papers test (考情). Without an outline, or when the materials ',
  'changed since it was made, the outline is organised first (the same build as generation.courseOutline.build); `papers` other than the outline\'s only mark ',
  'the outline again. A rebuild writes only what changed: a point whose texts did not change keeps its explanation without a model call, new papers rewrite ',
  'only 考情; questions are no input. The book is a reference, never course material. Refusals carry a code (course-book-no-course, course-book-no-materials, ',
  'course-book-outline-running, and the outline\'s own) and cost nothing. A stop or a failure saves nothing; a retry goes on from the model calls that finished.',
].join('');
