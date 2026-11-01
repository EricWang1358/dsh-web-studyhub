/* What the operation `generate` says in Chinese (and in English where it has both): [zh, en], to be given to `say`. A string or a function of one language is what the interface
   translates (lib/application-messages-en.js) or what was never said in two languages. A refusal stays byte for byte: tests/generation-generate-golden.test.mjs pins each. */

export const NOT_FOUND_LABEL = Object.freeze({ draft: 'Draft', target: '目标题组', deck: '题组' });

export const EXTRA = Object.freeze({
  needsDraft: ['补题需要指定目标草稿（resumeDraftId）', 'Adding from sources needs the target draft (resumeDraftId)'],
  chooseSources: ['请选择题组可用的资料', 'Choose sources that are still in the library'],
  count: ['补题题数需在 1–30 之间', 'Choose 1–30 questions to add'],
});

export const PART = Object.freeze({
  documentId: ['documentId 需要是资料的标识', 'documentId must name a document'],
  makesNewDraft: ['为资料补题会新建一份草稿，不能同时指定草稿或目标题组', 'Topping up a document makes a new draft: it cannot be combined with resumeDraftId, extraSourceIds or mergeTargetId'],
  needsCoverage: ['为资料补题需要 coverage: { sectionIds?, autoComplete?, tokenBudget? }', 'Topping up a document needs coverage: { sectionIds?, autoComplete?, tokenBudget? }'],
  partOf: ['partOf 需要是题组的标识', 'partOf must be a deck id'],
  notFound: ['找不到这份资料', 'This document is not in the library'],
  unpublished: ['这份资料的题还没有发布到题组；请在草稿页为没覆盖的部分补题', 'No published deck holds this document\'s questions yet; top up its draft instead'],
  busy: ['这份资料正在补题，请等这一份草稿做完', 'This document is already being topped up; wait for that draft'],
  /** Which decks hold the document's questions, when the caller did not say which one it tops up. */
  several: candidates => [
    `这份资料的题在 ${candidates.length} 个题组里，请用 partOf 说明补的是哪个题组：${candidates.map(item => `「${item.title}」(${item.id})`).join('、')}`,
    `This document's questions are in ${candidates.length} decks; say which one with partOf: ${candidates.map(item => `"${item.title}" (${item.id})`).join(', ')}`,
  ],
});

export const COVERAGE = Object.freeze({
  needsDraft: ['按覆盖补题需要指定目标草稿（resumeDraftId）', 'Covering the missing sections needs the target draft (resumeDraftId)'],
  notWithExtra: ['按覆盖补题不能同时指定补题资料（extraSourceIds）', 'Covering the missing sections cannot be combined with extraSourceIds'],
  shape: ['coverage 只接受 { sectionIds: [小节的标识], run, autoComplete, tokenBudget, manual }', 'coverage takes { sectionIds, run, autoComplete, tokenBudget, manual } only'],
});

export const RUN = Object.freeze({
  notWithSections: ['接着做不能同时指定小节（sectionIds）', 'Continuing the run cannot be combined with sectionIds'],
  noPlan: ['这份草稿没有出题计划，不能接着做；请用「为没覆盖的部分补题」', 'This draft has no coverage plan to continue; use 为没覆盖的部分补题'],
  complete: ['这份草稿的出题计划已经完成，没有可以接着做的轮次', 'The coverage plan of this draft is complete: there is no round to continue'],
});

/** A draft that cannot be continued (said in one language: the interface has the English). */
export const CONTINUE = Object.freeze({
  noRecord: '这份草稿没有可继续的生成记录，请从资料重新出题',
  stale: '草稿已更新，请刷新后再继续补题',
  busy: '这份草稿正在生成，请等待当前任务完成',
  nothingLeft: '草稿已达到请求的题数，无需补题',
  sourceGone: '原出题资料已有缺失，请先恢复资料再继续补题',
});

export const GOAL = Object.freeze({
  level: ['覆盖强度只能是 lean、standard 或 full', 'coverageLevel must be lean, standard or full'],
  count: max => [`请选择 1–${max} 道题`, `Choose 1–${max} questions`],
  autoComplete: ['autoComplete 只能是 true 或 false', 'autoComplete must be true or false'],
  tokenBudget: ['tokenBudget 需要是不小于 1000 的整数', 'tokenBudget must be a whole number of at least 1000 tokens'],
  noText: ['所选资料里没有可以出题的文字', 'The selected sources have no text to write questions from'],
});

export const TARGET = Object.freeze({
  supplementNeedsDeck: '补题需要明确的目标题组 deckId',
  supplementConflict: '补题目标冲突',
  otherThanDeck: '续补草稿的目标与 deckId 不一致',
  ordinaryOnly: '只能并入未归档的普通题组',
});

export const ROUND = Object.freeze({
  covered: ['这些小节已经有题了，请刷新后再补题', 'Some of these sections already have questions; refresh and try again'],
  tooMany: ['一轮最多补 30 道题，请少选几个小节', 'One round adds at most 30 questions; choose fewer sections'],
  gone: ['资料或草稿已变化，找不到这些小节，请刷新后再补题', 'The material or the draft changed and these sections cannot be found; refresh and try again'],
  inFlight: ['没覆盖的小节正在另一份草稿里补题，请到那份草稿继续', 'The sections without a question are already being topped up in another draft; continue that draft'],
  allCovered: ['所有小节都已经有题了，无需补题', 'Every section already has questions; there is nothing to add'],
  nextGone: ['资料或草稿变了，找不到下一轮要补的小节', 'The material or the draft changed and the sections of the next round cannot be found'],
});

export const CASE = Object.freeze({
  notIntoDeck: ['案例分析题不能续补或并入已有题组', 'A case paper cannot continue a draft or merge into a deck'],
  noEarlier: ['找不到可以仿照的案例', 'No earlier case to follow'],
  sourceTitle: title => [`案例：${title}`, `Case: ${title}`],
  graded: n => [`案例已导入，${n} 道题已批改`, `Case imported; ${n} answer(s) graded`],
});

/** What the answer tells the agent that started the run (English: the agent's words, never shown to the learner). */
export const NEXT = Object.freeze({
  supplement: 'Supplementation is queued and will publish reviewed questions into the exact target. '
    + 'Saving is already authorized by this action; do not ask again or enqueue duplicates. '
    + 'Final notification reports added/total and any blocked work. Use a bounded job.wait when needed to finish the requested workflow, not a polling loop.',
  rounds: 'Generation runs in the background, round after round until the plan is covered; the learner can pause, resume or stop it in the Study workspace (任务). '
    + 'Tell the learner it is queued and where to watch it. Use job.wait only if explicitly waiting for completion; do not repeatedly poll snapshot or enqueue duplicates.',
  plain: 'Generation runs in the background. Tell the learner it is queued and open the Study workspace for progress. '
    + 'Use job.wait only if explicitly waiting for completion; do not repeatedly poll snapshot or enqueue duplicates.',
  closing: 'Every section already has its question: this only closes the run, and no model is asked.',
});

/** What the run itself says while it works or as it ends. */
export const EXECUTE = Object.freeze({
  sourcesGone: '出题资料在任务开始前已被删除，请重新选择资料',
  draftChangedInQueue: '草稿在排队期间被修改，请重新打开后再继续补题',
  nothingPassed: '没有题目通过发布检查，目标题组未增加；检查记录已保留',
  interrupted: ['宿主已停止，这次运行被中断；已通过的题已保存，点「接着做」继续。', 'The host stopped and this run was interrupted; the questions that passed are saved. 接着做 continues it.'],
});
