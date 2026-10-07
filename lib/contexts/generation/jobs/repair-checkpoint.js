import { createHash } from 'node:crypto';

/** The checkpoint of a repair is the draft as the repair last saved it: every card it repaired is saved the moment it passes, so the draft at that version IS
 * what the repair has done. Nothing else may have changed it since (the draft's version moves with every save), and the cards must still read as they did. */
const digestOf = draft => createHash('sha256').update(JSON.stringify([draft.id, draft.draftVersion, draft.cards, draft.editorial?.rejectedIssues ?? {}])).digest('hex').slice(0, 32);

/** The checkpoint record the runtime keeps for a draft the repair just saved. */
export const repairCheckpointOf = draft => ({ version: 1, ref: `repair:${draft.id}:v${draft.draftVersion}`, digest: digestOf(draft), stepKey: `repair:${draft.id}` });

/** Whether `checkpoint` still describes `draft` as it is now (`draft` is undefined when it is gone). */
export const repairCheckpointHolds = (checkpoint, draft) => !!draft && checkpoint?.version === 1 && checkpoint.ref === `repair:${draft.id}:v${draft.draftVersion}`
  && checkpoint.digest === digestOf(draft);

/** The arguments an Attempt after the first one repairs with: the draft as it is now, which holds everything the earlier Attempt saved and still names the rest as rejected. */
export const repairResumeArgs = (args, state) => ({ id: args.id, draftVersion: state.drafts.find(draft => draft.id === args.id)?.draftVersion ?? args.draftVersion });
