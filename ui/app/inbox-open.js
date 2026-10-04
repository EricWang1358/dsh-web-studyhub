import { inboxKind, jobDomainOf, opensExplanation } from '../../lib/inbox-kinds.js';

/* Where a letter goes when it is opened (ui-consistency #93). The host answers inbox.open with what the letter points at; which
   screen shows it is read from the letter's row in lib/inbox-kinds.js (its job domain, its group), not from prefixes of its name.
   verbs: remember(from), showPage(id), openAudioSources(ids), showNote(id), enterRun(run), explain(), detour(from). */
export function openInboxResult({ item, result, from, fromReview }, verbs) {
  const domain = jobDomainOf(item.kind);
  // A finished PDF conversion or translation opens Sources at its pages; a failed one opens it where its card is.
  if (domain === 'pdf' || domain === 'translate') {
    verbs.remember(from);
    verbs.showPage('sources');
    if (result.sourceIds?.length) verbs.openAudioSources(result.sourceIds);
    return;
  }
  if (domain === 'audio') {
    verbs.remember(from);
    verbs.showPage(result.sourceIds?.length ? 'sources' : 'audio');
    if (result.sourceIds?.length) verbs.openAudioSources(result.sourceIds);
    return;
  }
  if (inboxKind(item.kind)?.group === 'note' && result.noteId) {
    verbs.remember(from);
    verbs.showNote(result.noteId);
    return;
  }
  verbs.enterRun(result);
  // Keep the way back to where the learner was, until they use it.
  if (fromReview && (result.id !== from.runId || result.index !== from.index)) verbs.detour(from);
  else if (!fromReview) verbs.remember(from);
  // Show what arrived: the Q&A and revised explanation live in 讲解.
  if (opensExplanation(item.kind) && result.revealed) verbs.explain();
}
