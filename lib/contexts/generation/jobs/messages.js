/* The wording the generation family says on its own account when the runtime (not the executor) ends or stops a job. Source text is the
   English the legacy path already used; the interface translates it like every other generation message. */

/** Why a run's workers were told to stop, by the stop reason the runtime gives (lib/jobs/lifecycle/settlement.js stop). */
export const STOP_MESSAGES = Object.freeze({
  'user-cancel': 'Generation cancelled; questions already saved to the draft are kept',
  unloaded: 'Generation stopped because the plugin was unloaded; approved content retained',
});

/** What the learner is told when the runtime cannot take a run at all (nothing was started). */
export const REFUSALS = Object.freeze({
  'executor-unavailable': 'The background task service is not available, so this run was not started',
  'capability-unverified': 'Shared provider quota is not verified for question generation yet, so this run was not started',
  'scope-unloaded': 'The study plugin is shutting down, so this run was not started',
});

/** The label under which the runtime shows a generation run before the executor has said anything of its own. */
/** What the background repair of rejected cards says (Chinese: the interface has the English, lib/application-messages-en.js). */
export const REPAIR_TEXT = Object.freeze({
  noModel: '当前没有可用模型，无法后台修题',
  draftStale: '草稿已更新，请刷新后再修题',
  staleInQueue: '草稿在排队期间已更新，请重新打开',
  nothingRejected: '这份草稿没有待处理的题目',
  noSources: '待处理题目没有可定位的资料；请先在草稿中补充引用来源，再交给后台修题',
  cardNoSources: '这题没有可定位的资料；请先在草稿里添加引用来源',
  busy: '这份草稿已有后台任务，请等待完成',
  waiting: '等待前一个学习任务',
  started: '后台修复待处理题目',
  timeLimit: '后台修题超过时限，已保存通过的题目',
  card: (n, total) => `修复第 ${n}/${total} 题`,
  cardTry: (n, total, round) => `修复第 ${n}/${total} 题 · 第 ${round} 次`,
  review: cardId => `独立复审 ${cardId}`,
  changedIdentity: '修题结果改变了题目 ID 或题型',
  lastOne: '后台修题已通过独立复审，等待发布',
  working: '后台修题中，已修好的题目等待发布',
  doneAll: total => `${total} 题已修好并通过独立复审，等待发布`,
  someDone: (saved, total) => `已修好 ${saved}/${total} 题；其余题留在草稿，请查看待处理问题`,
  next: '后台子任务将逐题修复并独立复审，通过的题保留在待处理草稿中；完成后可再次发布到原题组。',
});

/** What a supplement says when its publication is all that is left of it (English source: the generation messages are translated by the interface). */
export const SUPPLEMENT_TEXT = Object.freeze({
  finishing: 'Finishing the publication of the supplement',
  added: (added, title, total) => `Added ${added} questions to ${title}; total ${total}`,
  nothingAdded: '没有题目通过发布检查，目标题组未增加；检查记录已保留',
});

export const JOB_TITLES = Object.freeze({
  generation: 'Question generation',
  supplement: 'Supplement a deck',
  'draft-repair': 'Repair rejected questions',
  'draft-publish': 'Publish a draft',
});

/** What the learner is told about a publication that was cut short (Chinese: the interface has the English, lib/application-messages-en.js). */
export const PUBLISH_TEXT = Object.freeze({
  draftChanged: '这份草稿在检查发布之后被改动或删除了，无法确认题目是否已经并入题组。请打开题组和草稿核对已有的题目；如果有缺的，请重新发布这份草稿。',
  deckChanged: '题组在检查发布之后被改动过，其中可能已经有了这次发布的部分题目。请打开题组核对；缺的题目请重新发布这份草稿。',
  recovered: '已核对：上次中断前题目已经并入题组，没有重复写入',
  recoveredStage: stage => `已核对：上次中断前题目已经并入题组，没有重复写入；${stage}`,
  draftStale: '草稿已更新，请重新打开后再发布',
  busy: '这份草稿已有后台任务，请等待完成',
  waiting: '等待前一个学习任务',
  checking: '正在检查发布条件',
  reviewing: (reviewed, total) => `发布前逐卡复审 ${reviewed}/${total}`,
  published: accepted => `已发布 ${accepted} 题`,
  publishedSome: (accepted, rejected) => `已发布 ${accepted} 题；${rejected} 题留在草稿待处理`,
});
