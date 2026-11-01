/*
 * The request of one question of the learning panel (materials.selection.ask), and what 重试 asks again. Pure, so the panel's wiring is tested without a
 * browser: a page question names its scope, a preset chip carries its intent (lib/ask-prompt.js ASK_INTENTS), a question asked inside an answer carries
 * its term and the thread above it.
 */

/** { selection, page, question, intent, term, context, offset, language } -> the arguments of materials.selection.ask. offset: 接着读, the part of a long page this one goes on from. */
export function askRequest({ selection, page = false, question, intent = '', term = '', context = [], offset = 0, language }) {
  return { selection, ...(page ? { scope: 'page' } : {}), ...(offset ? { offset } : {}), question, ...(intent ? { intent } : {}), language, terms: true,
    ...(term ? { term } : {}), ...(context.length ? { thread: context } : {}) };
}

/** What 重试 of a failed node asks again: its own question, its term, its preset (a preset question retried stays that preset) and the part of the page it read. */
export const retryOf = node => ({ question: node.question, term: node.term || '', intent: node.intent || '', ...(node.offset ? { offset: node.offset } : {}) });

/** The key a page's unsent question is held under while the reader is open: a question typed on one page never follows to another. */
export const pageDraftKey = scope => (scope?.kind === 'page' ? `${scope.sourceId || ''}|${scope.page}` : '');
