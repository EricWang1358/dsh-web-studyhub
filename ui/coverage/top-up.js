import { uiFormat } from '../i18n.js';

/* The request of 为没覆盖的部分补题 and what is said when it starts, for the three places that offer it (the draft page, the home 待发布 card, the 任务 console). */

/** The `generate` arguments: the draft, and exactly the sections the screen showed (their keys, lib/coverage.js sectionKey). */
export const topUpArgs = (draft, sectionIds) => ({ resumeDraftId: draft.id, draftVersion: draft.draftVersion,
  // The rounds go on by themselves until every section has a question (自动补到完整 is ON), unless the learner made this draft's run a manual one: that choice is kept.
  coverage: { sectionIds, autoComplete: draft.editorial?.coverageRun?.autoComplete !== false } });

/** 接着做 of a plain run (a count, no plan): the same draft goes on, every approved question stays, the questions it still owes are made (lib/draft-continuation.js). */
export const continueArgs = (draft) => ({ resumeDraftId: draft.id, draftVersion: draft.draftVersion });

/** What is said once 接着做 of a plain run has started. */
export const continueNotice = (draft, started) => uiFormat('已接着做「{0}」：已出的题都保留，补 {1} 题。', [draft.title, started?.missing ?? 0]);

/** What is said once it has started: what it covers now (what the job says it will do, which is what the screen said). */
export const topUpNotice = (draft, started) => (started?.autoComplete && started?.plan?.rounds > 1
  ? uiFormat('已开始为「{0}」补题：先补 {1} 个小节，约 {2} 题；之后一轮接一轮自动补到每个小节都有题（共 {3} 轮，可以随时暂停或停下）。', [draft.title, started?.coverage?.sections ?? 0, started?.coverage?.questions ?? 0, started.plan.rounds])
  : uiFormat('已开始为「{0}」补 {1} 个小节，约 {2} 题；通过检查后会保存到同一份草稿。', [draft.title, started?.coverage?.sections ?? 0, started?.coverage?.questions ?? 0]));
