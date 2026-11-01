/* 「发给主会话」 into the DSH composer (ui/host/workspace.jsx, the hand-off plan section 1.2). The only write is the session input's setDraft, and setDraft
   REPLACES the whole draft (DSH 0.2.0-rc.2 and 0.2.1-rc.2, @deepseek-ai/dsh-client-ui-conversation SessionInputShell.setDraft: the learner's words and any @
   file chip would be lost). So the draft is read first, from the two faces both releases have: `projection.detectText` (the editor's text, a chip counted as
   one placeholder character) and the published `state` snapshot (`draft`, the clipboard projection, and `attachmentIds`). Anything there: nothing is
   written and the caller copies the prompt instead ('kept'). Nothing readable: the box is taken as empty (a newer DSH that renamed both faces still gets
   the prompt; npm run qa:dsh guards the real host). submit is never called: the learner presses send. */

/** What the learner has in the box: true when there is text, a chip or an attachment; false when empty or unreadable. */
export function composerHasContent(input) {
  const text = (value) => typeof value === 'string' && value.trim() !== '';
  try { if (text(input?.projection?.detectText)) return true; } catch { /* unreadable: empty */ }
  try {
    const snapshot = input?.state?.getSnapshot?.();
    if (text(snapshot?.draft) || (Array.isArray(snapshot?.attachmentIds) && snapshot.attachmentIds.length > 0)) return true;
  } catch { /* unreadable: empty */ }
  return false;
}

/**
 * fillComposer(conversation, actx, text) -> 'filled' (the box was empty and now holds `text`), 'kept' (the learner's own words are there: nothing written),
 * or false (no conversation, or the host refused: the caller copies).
 */
export function fillComposer(conversation, actx, text) {
  if (!conversation || !actx) return false;
  try {
    const input = conversation.input.for(actx);
    if (composerHasContent(input)) return 'kept';
    input.setDraft(text);
    return 'filled';
  } catch {
    return false;
  }
}

/* A picture for the box (#488, the page of a PDF): DSH keeps browser files as drafts (conversation.createDrafts, the composer's own way in for a dropped file)
   and the box holds their ids (input.addAttachments). Nothing is typed over and nothing is sent. DSH 0.2.1-rc.2 has both faces; a host without them keeps the screenshot way. */
export const canAttachToComposer = (conversation) => typeof conversation?.createDrafts === 'function' && typeof conversation?.input?.for === 'function';

/** attachToComposer(conversation, actx, sessionId, files) -> true when the files are in the box; false (nothing left behind) when the host cannot or the box is busy. */
export function attachToComposer(conversation, actx, sessionId, files) {
  if (!canAttachToComposer(conversation) || !actx || !files?.length) return false;
  try {
    const input = conversation.input.for(actx);
    if (typeof input?.addAttachments !== 'function') return false;
    const drafts = conversation.createDrafts(sessionId, files);
    if (input.addAttachments(drafts.map((draft) => draft.id))) return true;
    conversation.releaseDraftAttachments?.(drafts);
    return false;
  } catch {
    return false;
  }
}
