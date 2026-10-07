import { createHash } from 'node:crypto';

/* The checkpoint of a generation run is its draft (S3-0: the draft is the checkpoint). */

// What a checkpoint vouches for: the questions the draft held when the run saved it (their ids and content, in order). The run's own later saves only append
// to them, so a draft that has more questions than the checkpoint is still the run's; one whose saved questions were edited, removed or reordered is not.
const digestOf = (draft, count) => createHash('sha256')
  .update(JSON.stringify([draft.id, draft.editorial?.generation?.inputRef?.hash ?? '', draft.cards.slice(0, count)])).digest('hex').slice(0, 32);

/** The checkpoint record the runtime keeps for a draft the run just saved. */
export const checkpointOf = draft => ({ version: 1, ref: `draft:${draft.id}:n${draft.cards.length}`, digest: digestOf(draft, draft.cards.length), stepKey: `draft:${draft.id}` });

/** Whether `checkpoint` still describes the start of `draft` as it is now (`draft` is undefined when it is gone). */
export function checkpointHolds(checkpoint, draft) {
  const count = Number(/:n(\d+)$/.exec(checkpoint?.ref ?? '')?.[1]);
  return !!draft && checkpoint?.version === 1 && checkpoint.ref === `draft:${draft.id}:n${count}` && draft.cards.length >= count
    && checkpoint.digest === digestOf(draft, count);
}
