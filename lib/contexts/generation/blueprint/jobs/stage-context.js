import { makeAsk } from './ask.js';

/** What a place the model named becomes, once the library's own resolver has found it: the same selection every citation carries. */
export const evidenceOf = (selection, role) => ({ sourceId: selection.sourceId, quote: selection.quote, role,
  ...(selection.documentId ? { documentId: selection.documentId } : {}), ...(selection.revision ? { revision: selection.revision } : {}),
  ...(Number.isInteger(selection.page) ? { page: selection.page } : {}), start: selection.start, end: selection.end });

/** A candidate as the model is shown it: its id, title and parent, nothing else. */
export const briefOf = ({ id, title, parent }) => ({ id, title, ...(parent ? { parent } : {}) });

/** What the stages of one attempt share: the plan, the attempt's own state, how to show it, where to checkpoint, how to ask the model and how to find a place in the library. */
export function stageContext(context, input, env, state, reader) {
  const show = () => { try { context.present(reader); } catch { /* the Attempt is over: nothing is left to show */ } };
  const resolveOne = async (sourceId, quote) => {
    const answer = await env.resolve({ sourceId, quote });
    return answer?.status === 'resolved' ? answer.selection : answer?.status === 'ambiguous' ? answer.candidates?.[0] ?? null : null;
  };
  return { context, input, env, plan: env.plan, state, show, resolveOne, boundary: ref => context.checkpoint(ref), ask: makeAsk(context, env.kept, state) };
}
