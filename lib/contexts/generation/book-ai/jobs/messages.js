/* The wording of a 弄懂 / 加一段 task of the 复习全书, in the language the learner asked it in. Chinese is the source text; English sits beside it, so no
   entry is needed in lib/application-messages-en.js. This is the only file of the folder that holds such text. */
const say = (language, zh, en) => (language === 'en' ? en : zh);

export const AI_JOB_TITLE = '复习全书 · 弄懂';

const MODE = { explain: ['弄懂', 'Explain'], write: ['写一段', 'Write'], here: ['加一段', 'Add a paragraph'], follow: ['接着问', 'Follow-up'] };
/** The name of the task in the console: what it does and where. */
export const jobTitle = (language, mode, title) => say(language, `复习全书 · ${MODE[mode]?.[0] ?? MODE.explain[0]} · ${title}`,
  `Review book · ${MODE[mode]?.[1] ?? MODE.explain[1]} · ${title}`);

export function stageText(language, stage, state) {
  return {
    queued: say(language, '等待开始', 'Waiting to start'),
    searching: say(language, '正在用检索索引找相关的页', 'Finding the relevant pages with the search index'),
    asking: state.indexCount
      ? say(language, `正在按这一节的资料和检索找到的 ${state.indexCount} 页写`, `Writing from the materials of this point and ${state.indexCount} page(s) the search index found`)
      : say(language, '正在按这一节的资料写', 'Writing from the materials of this point'),
    saving: say(language, '正在放进书里', 'Putting it into the book'),
    complete: say(language, `已放进书里${state.dropped ? `；${state.dropped} 处引文在资料里找不到，已去掉` : ''}`,
      `In the book${state.dropped ? `; ${state.dropped} quote(s) not found in the materials were left out` : ''}`),
    cancelled: say(language, '已停止，书里什么都没加', 'Stopped; nothing was added to the book'),
    paused: say(language, '已暂停', 'Paused'),
  }[stage] ?? '';
}

/** The console's line about the pages the search index added (index-pages.js): which ones, first in the materials the model saw. */
export function indexNote(language, pages) {
  const list = pages.map(item => (item.page ? say(language, `《${item.material}》第 ${item.page} 页`, `"${item.material}" p. ${item.page}`)
    : say(language, `《${item.material}》`, `"${item.material}"`)));
  return say(language, `检索索引找到的 ${pages.length} 页放在了资料最前面：${list.join('、')}`,
    `${pages.length} page(s) found with the search index were put first in the materials: ${list.join(', ')}`);
}

/** The headings of the block's parts. */
export const blockWords = language => ({
  quotes: say(language, '资料原文', 'From the materials'),
  extra: say(language, '补充（资料以外）', 'Extra (beyond the materials)'),
  /** The short tag an instruction's answer puts right after a part that comes from outside the materials. */
  outside: say(language, '（资料以外）', '(beyond the materials)'),
});

export const FAILURES = Object.freeze({
  unreadable: language => say(language, '模型两次都没有给出能用的回答，书里什么都没加；可以重试', 'The model gave no usable answer twice; nothing was added to the book. You can retry'),
  empty: language => say(language, '模型没有写出内容，书里什么都没加；可以重试', 'The model wrote nothing; nothing was added to the book. You can retry'),
  saveFailed: language => say(language, '没能放进书里；可以重试', 'It could not be put into the book. You can retry'),
});

export const REFUSALS = Object.freeze({
  'course-book-ai-no-book': language => say(language, '这门课还没有复习全书，先打开书页', 'This course has no review book yet; open the book page first'),
  'course-book-ai-no-point': language => say(language, '找不到这一节，书可能刚更新过；请刷新书页再试', 'This point is not in the book; it may have just changed. Open the book page again'),
  'course-book-ai-no-materials': language => say(language, '这一节没有资料，没有可依据的原文，所以没有开始', 'This point has no materials to work from, so nothing was started'),
  'course-book-ai-no-request': language => say(language, '请选中一段文字，或写下要 AI 写什么', 'Select some text, or write what the AI should write'),
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能开始', 'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});

/** The description of the call in the contract. */
export const AI_DESCRIPTION = [
  'Explain a passage of the review book (复习全书), or write a new paragraph for one of its knowledge points, as one visible background job: the answer comes ',
  'from the point\'s own materials (quotes are checked word for word and dropped when not found; what goes beyond the materials is marked as extra) and is ',
  'written as a NEW block into the point\'s own file, anchored to the selected words (shown right after their paragraph) or to a heading; existing text is never ',
  'edited. mode: explain (the selected words), write (an instruction about the selected words), here (an instruction under a heading); `after` continues a block, ',
  '`replace` writes a block again. The block is a reference, never course material. Refusals carry a code (course-book-ai-no-book, course-book-ai-no-point, ',
  'course-book-ai-no-materials, course-book-ai-no-request) and cost nothing. A stop saves nothing; a retry asks again.',
].join('');
