/* The final reply of a DSH session, read on demand (2.6.1). The 任务 console shows what an ended call wrote: the tail (about 8 KB) stays in memory (lib/job-output.js);
   when a DSH sub-agent wrote more than that, or its tail is gone (older than the finished calls that are kept, or the host restarted), the full final reply is in the
   child's own session, so it is read from there, once, when someone opens that call. Only the last reply is read, only for a call that has ended, and what comes
   back is bounded.

   The session is read through DSH's session query (`ctx.get('sessionQuery')`) with the same lease pattern as lib/token-usage.js `readSessionUsage`: `observeSession(id)`
   hands out an observation whose `events` are the session's events, and the lease is released with Symbol.dispose. The reply is the text blocks of the LAST
   `assistant/message` event that has any (an assistant message that only calls tools, or says nothing, is not a reply). */

/** The longest reply handed back (characters); a longer one is cut at the end and says so. */
export const SESSION_REPLY_LIMIT = 200 * 1024;

const textOf = (event) => {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
};

/**
 * @param sessionQuery `ctx.get('sessionQuery')`
 * @returns `{ text, clipped }` (text is '' when the session was readable but said nothing), or null when the session cannot be read: no query, no id, a session
 *   that is gone or a store that fails. Never throws.
 */
export async function readSessionReply(sessionQuery, sessionId, { limit = SESSION_REPLY_LIMIT } = {}) {
  if (!sessionId || typeof sessionQuery?.observeSession !== 'function') return null;
  let observed;
  try {
    observed = await sessionQuery.observeSession(sessionId);
    const events = observed?.events;
    if (!events || typeof events.length !== 'number') return null;
    let text = '';
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'assistant/message') continue;
      text = textOf(event);
      if (text) break;
    }
    return text.length > limit ? { text: text.slice(0, limit), clipped: true } : { text, clipped: false };
  } catch { return null; }
  finally { try { observed?.[Symbol.dispose]?.(); } catch { /* a lease that will not release changes nothing */ } }
}
