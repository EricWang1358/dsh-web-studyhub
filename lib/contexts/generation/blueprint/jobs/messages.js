/* The wording of a 考点清单 build (the feature the learner sees is 「备考补习」), in the language the learner asked it in. Chinese is the source text; English sits beside it, so no entry is
   needed in lib/application-messages-en.js. The words blueprint / 蓝图 are code names and never appear here. */
const say = (language, zh, en) => language === 'en' ? en : zh;

export const BLUEPRINT_TITLE = '考点清单';

export const stageText = (language, stage, state) => ({
  queued: say(language, '等待开始', 'Waiting to start'),
  checking: say(language, '正在检查资料', 'Checking the materials'),
  paper: say(language, `正在读样卷 ${Math.min(state.papers.done + 1, state.papers.total)}/${state.papers.total}：每道题考哪些考点`, `Reading sample paper ${Math.min(state.papers.done + 1, state.papers.total)}/${state.papers.total}: what each question tests`),
  merge: say(language, '正在合并几份样卷的考点', 'Uniting the exam points of the sample papers'),
  slides: say(language, `正在到课件里找出处 ${Math.min(state.windows.done + 1, state.windows.total)}/${state.windows.total}`, `Finding the places in the slides ${Math.min(state.windows.done + 1, state.windows.total)}/${state.windows.total}`),
  saving: say(language, '正在检查出处并保存', 'Checking the places and saving'),
  complete: say(language, `考点清单已保存：${state.points} 个考点`, `Exam point list saved: ${state.points} exam points`),
  cancelled: say(language, '已取消，没有保存考点清单', 'Cancelled; no exam point list was saved'),
  paused: say(language, '已暂停，点「继续」接着做', 'Paused; resume to go on'),
}[stage] ?? '');

export const FAILURES = Object.freeze({
  unreadable: (language, where) => say(language, `${where}的内容读不出来（模型两次都没有给出可用的答案），没有保存考点清单；可以重试`, `The ${where} could not be read (the model gave no usable answer twice); no exam point list was saved. You can retry`),
  noPoints: language => say(language, '没有一个考点能找到出处，没有保存考点清单', 'Not one exam point could be traced to the materials; no exam point list was saved'),
});

/** Where a failure happened, said both ways. */
export const WHERE = Object.freeze({
  slides: (language, pages) => say(language, `课件${pages ? `（${pages}）` : ''}`, `slides${pages ? ` (${pages})` : ''}`),
  paper: language => say(language, '样卷', 'sample paper'),
});

export const REFUSALS = Object.freeze({
  'blueprint-disabled': language => say(language, '备考补习还没有开放', 'Exam preparation is not available yet'),
  'blueprint-title-required': language => say(language, '请给考点清单起个名字', 'Give the exam point list a name'),
  'blueprint-input-invalid': language => say(language, '资料的选择有误：每份资料都要有用途，而且考点清单不能当作资料', 'The choice of materials is not valid: every material needs a role, and an exam point list cannot be used as a material'),
  'blueprint-needs-primary-input': language => say(language, '请选择课件（或考试大纲）：考点要从它们里列出来', 'Choose lecture slides (or a syllabus): the exam points are listed from them'),
  'blueprint-input-missing': language => say(language, '所选的某份资料不在资料库里', 'A chosen material is not in the library'),
  'blueprint-no-readable-text': language => say(language, '所选资料里没有可读的文字（只有图片？）', 'The chosen materials have no readable text (pictures only?)'),
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能建考点清单', 'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});
