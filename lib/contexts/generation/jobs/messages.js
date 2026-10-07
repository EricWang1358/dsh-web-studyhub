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
});
