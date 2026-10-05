import { uiFormat } from '../i18n.js';

/* The request of 为没覆盖的部分补题 and what is said when it starts, for the three places that offer it (the draft page, the home 待发布 card, the 任务 console). */

/** The `generate` arguments: the draft, and exactly the sections the screen showed (their keys, lib/coverage.js sectionKey). */
export const topUpArgs = (draft, sectionIds) => ({ resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds } });

/** What is said once it has started: what it covers now (what the job says it will do, which is what the screen said). */
export const topUpNotice = (draft, started) => uiFormat('已开始为「{0}」补 {1} 个部分，约 {2} 题；通过检查后会保存到同一份草稿。',
  [draft.title, started?.coverage?.sections ?? 0, started?.coverage?.questions ?? 0]);
