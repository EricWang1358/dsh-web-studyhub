/* The refusals of a course batch organize (批量整理前置依赖与生词, #1293), in the language the learner asked it in. Chinese is the source text; English sits
   beside it, so no entry is needed in lib/application-messages-en.js. The same words as the other generation jobs (e.g. ../../answer-card/jobs/messages.js). */
const say = (language, zh, en) => (language === 'en' ? en : zh);

export const REFUSALS = Object.freeze({
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能开始', 'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});
