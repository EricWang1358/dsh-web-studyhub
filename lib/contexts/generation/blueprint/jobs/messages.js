/* The wording of an exam-blueprint build, in the language the learner asked it in (Chinese is the source text; English beside it, so no entry is needed in lib/application-messages-en.js). */
const say = (language, zh, en) => language === 'en' ? en : zh;

export const BLUEPRINT_TITLE = '考试蓝图';

export const stageText = (language, stage, state) => ({
  queued: say(language, '等待开始', 'Waiting to start'),
  checking: say(language, '正在检查资料', 'Checking the materials'),
  slides: say(language, `正在读讲义 ${Math.min(state.windows.done + 1, state.windows.total)}/${state.windows.total}`, `Reading the slides ${Math.min(state.windows.done + 1, state.windows.total)}/${state.windows.total}`),
  shape: say(language, '正在读样卷的题型', 'Reading the shape of the sample paper'),
  map: say(language, '正在把样卷题对应到考点', 'Matching the paper\'s questions to the points'),
  saving: say(language, '正在检查出处并保存', 'Checking the places and saving'),
  complete: say(language, `蓝图已保存：${state.points} 个考点`, `Blueprint saved: ${state.points} exam points`),
  cancelled: say(language, '已取消，没有保存蓝图', 'Cancelled; no blueprint was saved'),
  paused: say(language, '已暂停，点「继续」接着读', 'Paused; resume to go on'),
}[stage] ?? '');

export const FAILURES = Object.freeze({
  unreadable: (language, pages) => say(language, `讲义${pages}的考点读不出来（模型两次都没有给出可用的答案），没有保存蓝图；可以重试`, `The exam points of the slides${pages} could not be read (the model gave no usable answer twice); no blueprint was saved. You can retry`),
  noPoints: language => say(language, '没有一个考点能在讲义原文里找到出处，没有保存蓝图', 'Not one exam point could be traced to the slides; no blueprint was saved'),
});

export const REFUSALS = Object.freeze({
  'blueprint-disabled': language => say(language, '考试蓝图功能还没有开放', 'The exam blueprint is not available yet'),
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能建蓝图', 'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});
