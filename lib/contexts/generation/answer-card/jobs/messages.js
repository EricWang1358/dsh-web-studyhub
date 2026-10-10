/* The wording of an answer-card task (分析题答案卡, 复习全书 M5), in the language the learner asked it in. Chinese is the source text; English sits beside it,
   so no entry is needed in lib/application-messages-en.js. This is the only file of the folder that holds such text. */
const say = (language, zh, en) => (language === 'en' ? en : zh);

export const CARD_JOB_TITLE = '分析题答案卡';

/** The name of the task in the console: what it does and for which question. */
export const jobTitle = (language, n, prompt) => say(language, `答题卡 · ${n ? `第 ${n} 题 · ` : ''}${prompt}`, `Answer card · ${n ? `Q${n} · ` : ''}${prompt}`);

export function stageText(language, stage, state) {
  return {
    queued: say(language, '等待开始', 'Waiting to start'),
    writing: say(language, '正在按题型写答题卡', 'Writing the card by the question type'),
    checking: say(language, '正在逐字核对引文、评分点和数字', 'Checking quotes, marks and numbers word for word'),
    reviewing: say(language, '正在独立复核', 'Independent review'),
    repairing: say(language, '复核发现问题，正在修改一次', 'The review found problems; fixing them once'),
    saving: say(language, '正在保存到这道题', 'Saving it to the question'),
    complete: state.status === 'verified' ? say(language, '答题卡已保存：已核对（已核对 ≠ 答案正确）', 'Saved: checked (checked ≠ correct)')
      : say(language, '答题卡已保存：部分未核对，标了「未核实」的地方请对照原文', 'Saved: partly unchecked; compare the parts marked "not verified" with the original'),
    cancelled: say(language, '已停止，这道题没有改动', 'Stopped; the question is unchanged'),
    paused: say(language, '已暂停', 'Paused'),
  }[stage] ?? '';
}

export const FAILURES = Object.freeze({
  unreadable: language => say(language, '模型两次都没有写出能用的答题卡，什么都没保存；可以重试', 'The model gave no usable card twice; nothing was saved. You can retry'),
  stale: language => say(language, '写的时候这道题被改过了，答题卡没有保存；请重新生成', 'The question changed while the card was written, so it was not saved; generate it again'),
  saveFailed: language => say(language, '答题卡没能保存；可以重试', 'The card could not be saved. You can retry'),
});

export const REFUSALS = Object.freeze({
  'answer-card-no-card': language => say(language, '找不到这道题，可能刚被删掉了', 'This question is not there; it may have just been deleted'),
  'answer-card-not-case': language => say(language, '只有带评分标准的分析题（大题）能生成答题卡', 'Only an analysis question with marking criteria can have an answer card'),
  'answer-card-in-exam': language => say(language, '这道题在一场还没交卷的模拟考试里，交卷后再生成答题卡', 'This question is in a mock exam that is not submitted yet; generate the card after you submit'),
  'answer-card-exists': language => say(language, '这道题已经有答题卡了', 'This question already has an answer card'),
  'answer-card-running': language => say(language, '这道题的答题卡正在生成', 'The answer card of this question is being written'),
  'executor-unavailable': language => say(language, '后台执行器暂时不可用，请稍后再试', 'The background task service is not available; try again later'),
  'capability-unverified': language => say(language, '共享的模型额度还没有验证，暂时不能开始', 'Shared provider quota is not verified for this task yet'),
  'scope-unloaded': language => say(language, '学习插件正在关闭，没有开始', 'The study plugin is shutting down, so this was not started'),
});

/** The description of the call in the contract. */
export const CARD_DESCRIPTION = [
  'Write the answer card (分析题答案卡) of one case / analysis question as one visible background job: ONE full structured answer (question type and the ',
  'stem words that signal it, stem facts with quotes, concepts with their definition quoted from the course materials, explicit assumptions, the type\'s ',
  'reasoning steps, conclusion, why it meets the goal, cost and failure handling, how to verify, pitfalls, which sentence earns which key point). The program ',
  'checks every quote word for word (else 未核实), computes rubric coverage and flags numbers found nowhere; an independent review follows and one repair ',
  'when needed (2-3 model calls). The card is saved beside the question (card.answerCard); the question\'s answer, schedule and history are never changed. ',
  'Status: verified (已核对, never "correct") or partial; 被改过 when the question changed since. Refusals (answer-card-no-card, answer-card-not-case, ',
  'answer-card-in-exam, answer-card-exists, answer-card-running) cost nothing; `again: true` writes a new card over an old one. A stop saves nothing.',
].join('');
