import { useCallback } from 'react';
import { useStudy } from '../study-context.jsx';
import { bookEditPrompt } from '../agent-prompts/book.js';

/* 「发给主会话」 (docs/review-book-agent.md): the one way a book edit goes to the main chat. It builds the message (ui/agent-prompts/book.js: no book text, the chat
   reads the point itself) and hands it to askInChat, which fills the chat's input box (never sends), or copies it when the host has no chat. */

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
 * selection, instruction }) -> a promise that ends when the message was handed over.
 */
export function useSendToChat(course) {
  const { call, askInChat } = useStudy();
  return useCallback(async ({ scope, node = null, files = null, selection = '', instruction = '' }) => {
    const point = scope !== 'book' && node ? node : null;
    const coverage = point ? await coverageOf(call, course, point.hid) : null;
    await askInChat(bookEditPrompt({ course, scope, hid: point?.hid ?? '', title: point?.title ?? '', files: point ? Object.values(point.files ?? {}).filter(Boolean) : [],
      version: point ? files?.[point.files?.gen]?.version ?? null : null, coverage, selection, instruction }));
  }, [call, askInChat, course]);
}
