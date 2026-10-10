import { makeAsk } from '../../blueprint/jobs/ask.js';
import { aiPrompt } from '../prompts.js';
import { blockBody, readAi } from '../read.js';
import { AI_JOB_TITLE, FAILURES, stageText } from './messages.js';

export const COURSE_BOOK_AI_KIND = 'course-book-ai';
/* A retry asks again (a finished call is kept for it), a stop adds nothing to the book. */
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'unsupported', recoveryMode: 'none', executionModes: ['direct'],
  retryKeeps: 'completed', stopKeeps: 'nothing' });
const AI_FIELDS = Object.freeze(['runId', 'scopeHash', 'aiStage']);
const coded = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });

function present(input, state) {
  return observed => {
    const { status, error } = observed;
    const stage = status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : status === 'queued' ? 'queued' : state.stage;
    return {
      title: input.title,
      stage: { code: `course-book-ai.${stage}`, text: status === 'failed' ? error?.message ?? '' : stageText(input.language, stage, state) },
      progress: { done: status === 'complete' ? 1 : 0, total: 1, unit: 'steps', percent: null, segments: [] },
      // `course`: the book this task writes into; `block`: the block it wrote (the page shows it there).
      detail: { course: input.course, heading: input.heading, block: state.block, dropped: state.dropped },
      legacy: { runId: input.runId, scopeHash: input.scopeHash, aiStage: stage },
    };
  };
}

/**
 * One explain / add-a-paragraph of the review book: ONE model call (a Step of the gateway) over the point's materials (lib/contexts/generation/book-ai/plan.js), checked by the
 * program (read.js), then ONE write of a new block into the point's own file through the materials context (the book's writer queue and version history). The
 * queue, lifecycle, control, metering and the task console are the runtime's. Not durable: a stop or a failure adds nothing.
 */
export const courseBookAiDefinition = {
  kind: COURSE_BOOK_AI_KIND, version: 1, title: AI_JOB_TITLE, legacyFields: AI_FIELDS, capabilities: CAPABILITIES,
  legacyId: input => `course-book-ai-${input.runId}`,
  initialPresentation: input => present(input, { stage: 'queued', block: null, dropped: 0 }),

  async run(context, input, { courseBookAi: env }) {
    const { plan, kept } = env, state = { stage: 'asking', block: null, dropped: 0, reused: 0 };
    const reader = present(input, state);
    const show = () => { try { context.present(reader); } catch { /* the Attempt is over */ } };
    show();
    const ask = makeAsk(context, kept, state);
    const answer = await ask(`cba:${plan.key}`, { stage: 'ai' }, aiPrompt(plan), readAi, async read => read);
    if (!answer) throw coded('course-book-ai-unreadable', FAILURES.unreadable(input.language));
    const { body, dropped } = blockBody(answer, plan.segments, input.language);
    state.dropped = dropped; state.stage = 'saving'; show();
    context.signal.throwIfAborted();
    try {
      await env.write({ course: plan.course, leafId: plan.leaf.id, id: input.blockId, at: plan.at, about: plan.about, body,
        ...(plan.after ? { after: plan.after } : {}), ...(plan.replace ? { replace: plan.replace } : {}) });
    } catch (cause) { throw context.signal.aborted ? cause : coded('course-book-ai-save-failed', FAILURES.saveFailed(input.language), cause); }
    state.block = input.blockId; state.stage = 'complete'; show();
    return { refs: [{ kind: 'course-book', id: input.blockId, course: plan.course, heading: plan.leaf.hid }], completeness: 'complete' };
  },
};
