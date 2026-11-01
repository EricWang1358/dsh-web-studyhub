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
export function canAttachToComposer(conversation, actx) {
  try { return typeof conversation?.createDrafts === 'function' && typeof conversation.input.for(actx)?.addAttachments === 'function'; } catch { return false; }
}

/* The pictures this code put in a session's box, so a second press replaces them instead of piling up (ids the learner's message already took are simply gone from the box). */
const placed = new Map();

/** attachToComposer(conversation, actx, sessionId, files) -> true when the files are in the box; false (no draft left behind) when the host cannot or the box is busy. */
export async function attachToComposer(conversation, actx, sessionId, files) {
  if (!actx || !files?.length || !canAttachToComposer(conversation, actx)) return false;
  let drafts = null;
  try {
    const input = conversation.input.for(actx);
    drafts = await conversation.createDrafts(sessionId, files);
    const ids = drafts.map((draft) => draft.id);
    if (input.addAttachments(ids)) {
      for (const id of placed.get(sessionId) || []) if (input.removeAttachment?.(id)) conversation.releaseDraftAttachment?.(id);
      placed.set(sessionId, ids);
      return true;
    }
  } catch { /* said below: false */ }
  if (drafts) try { conversation.releaseDraftAttachments?.(drafts); } catch { /* already gone */ }
  return false;
}

/** A line in the chat's own box (input.notify): the host has just shown the chat, so what the app's receipt says is out of sight there. */
export function noteInComposer(conversation, actx, text) {
  try { conversation.input.for(actx).notify?.('info', text); } catch { /* the receipt says it too */ }
}
