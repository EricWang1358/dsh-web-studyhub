/** The arguments an Attempt after the first one asks `generate` with. The draft is the checkpoint: when the earlier Attempt saved one (it marks its draft
 * with the run's id), the new Attempt continues exactly that draft, which keeps every approved question and writes only what is missing (a coverage run
 * goes on from the next round that is not done). When nothing was saved yet, the request is asked again as it was, so a top-up still names the draft
 * version it was made for: a draft the learner changed since refuses it with the usual words. */
export function resumeArgs(args, state, runId) {
  const draft = state.drafts.find(item => item.editorial?.generation?.runId === runId);
  if (!draft) return args;
  return { ...(args.deckId ? { deckId: args.deckId } : {}), resumeDraftId: draft.id, draftVersion: draft.draftVersion,
    ...(draft.editorial.coverageSpec?.rounds?.length ? { coverage: { run: true } } : {}) };
}
