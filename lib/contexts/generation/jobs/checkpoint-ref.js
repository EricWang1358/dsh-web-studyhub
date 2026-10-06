import { roundList } from '../../../coverage-run.js';

/** The checkpoint of a generation run is its draft (S3-0: the draft is the checkpoint). Its reference is the draft and the version the run saved;
 * `completed` names the units of a coverage run that are done by the round prefix of their step keys (step-identity.js), so a run that continues
 * skips exactly those. A plain run has no finished rounds: it is one unit, continued from the questions the draft already holds. */
export function checkpointRefOf(draft) {
  const rounds = draft.editorial?.coverageSpec ? roundList(draft.editorial.coverageSpec) : [];
  return { ref: `draft:${draft.id}:v${draft.draftVersion}`, completed: rounds.filter(item => ['done', 'skipped'].includes(item.status)).map(item => `r${item.round}`) };
}
