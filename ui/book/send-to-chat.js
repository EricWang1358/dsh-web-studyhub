import { useCallback } from 'react';
import { useStudy } from '../study-context.jsx';
import { useHandOff } from '../hand-off/use-hand-off.js';

/* 「发给主会话」 (docs/review-book-agent.md): the one way a book edit goes to the main chat, through the shared unit (ui/hand-off/) with the registry's
   'book.edit' (ui/agent-prompts/book.js: no book text, the chat reads the point itself). The unit fills the chat's input box (never sends, never over
   what the learner typed), or copies it when the host has no chat, and says which in the app's notice. */

/** The reading figure the message names, from book.coverage (a courtesy: without it the message is sent without the figure). */
async function coverageOf(call, course, hid) {
  try {
    const answer = await call('book.coverage', { course, hid });
    return answer?.status === 'ok' && answer.totals ? { opened: answer.totals.opened, pages: answer.totals.pages,
      ...(answer.concepts ? { concepts: { covered: answer.concepts.covered, total: answer.concepts.total } } : {}) } : null;
  } catch { return null; }
}

/**
 * send({ scope: 'point' | 'selection' | 'book', node (the point: { hid, title, files: { gen, mine, qa? } }), files (course.book.open's `files`, for the version),
 * selection, instruction }) -> the outcome of the hand-off ('filled' | 'kept' | 'copied' | 'shown' | 'failed').
 */
export function useSendToChat(course) {
  const { call } = useStudy();
  const { send } = useHandOff();
  return useCallback(({ scope, node = null, files = null, selection = '', instruction = '' }) => send('book.edit', async () => {
    const point = scope !== 'book' && node ? node : null;
    const coverage = point ? await coverageOf(call, course, point.hid) : null;
    return { course, scope, hid: point?.hid ?? '', title: point?.title ?? '', files: point ? Object.values(point.files ?? {}).filter(Boolean) : [],
      version: point ? files?.[point.files?.gen]?.version ?? null : null, coverage, selection, instruction };
  }), [call, send, course]);
}
