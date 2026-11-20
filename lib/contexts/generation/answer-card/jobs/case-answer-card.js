import { makeAsk } from '../../blueprint/jobs/ask.js';
import { checkAnswerCard, cardProblems, finishAnswerCard, normalizeAnswerCard, normalizeCardReview } from '../../../../answer-card.js';
import { repairPrompt, reviewPrompt, writePrompt } from '../prompts.js';
import { readCard, readReview } from '../read.js';
import { CARD_JOB_TITLE, FAILURES, stageText } from './messages.js';

export const ANSWER_CARD_KIND = 'case-answer-card';
/* A retry asks again (a finished call is kept for it), a stop saves nothing. */
const CAPABILITIES = Object.freeze({ cancel: true, set: false, retry: true, pauseMode: 'unsupported', recoveryMode: 'none', executionModes: ['direct'],
  retryKeeps: 'completed', stopKeeps: 'nothing' });
const CARD_FIELDS = Object.freeze(['runId', 'scopeHash', 'cardStage']);
const STEPS = 4;
const coded = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const PATCH_FIELDS = Object.freeze(['questionType', 'signals', 'facts', 'concepts', 'assumptions', 'steps', 'conclusion', 'pitfalls', 'marks']);

function parseRepairJson(text) {
  const body = String(text ?? '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const isUsableCardShape = data => !!data && typeof data === 'object' && !Array.isArray(data)
  && Array.isArray(data.steps) && data.steps.some(step => typeof step === 'string' && step.trim())
  && typeof data.conclusion === 'string' && !!data.conclusion.trim();

function cardToRaw(card) {
  return {
    questionType: typeof card?.questionType === 'string' ? card.questionType : card?.questionType?.id || 'general',
    signals: (card?.signals || []).map(({ word, quote }) => ({ word, quote })),
    facts: (card?.facts || []).map(({ text, quote }) => ({ text, quote })),
    concepts: (card?.concepts || []).map(({ name, ref, quote }) => ({ name, ...(ref ? { ref } : {}), definition: quote })),
    assumptions: [...(card?.assumptions || [])],
    steps: [...(card?.steps || [])],
    conclusion: card?.conclusion || '',
    justification: { ...(card?.justification || {}) },
    pitfalls: [...(card?.pitfalls || [])],
    marks: (card?.marksMap || card?.marks || []).map(({ point, sentence }) => ({ point, sentence })),
  };
}

/** Merge a minimal `{ patch }` repair reply onto the existing card, or accept a complete answer-card object fallback. */
export function applyAnswerCardPatch(card, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (isUsableCardShape(raw)) return raw;
  const patch = raw.patch && typeof raw.patch === 'object' && !Array.isArray(raw.patch) ? raw.patch : null;
  if (!patch || !Object.keys(patch).length) return null;
  const merged = cardToRaw(card);
  for (const key of PATCH_FIELDS) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  if (patch.marks === undefined && patch.marksMap !== undefined) merged.marks = patch.marksMap;
  if (patch.justification && typeof patch.justification === 'object' && !Array.isArray(patch.justification)) {
    merged.justification = { ...merged.justification, ...patch.justification };
  }
  return isUsableCardShape(merged) ? merged : null;
}

export const readCardRepair = (text, card) => applyAnswerCardPatch(card, parseRepairJson(text));

function present(input, state) {
  return observed => {
    const { status, error } = observed;
    const stage = status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : status === 'queued' ? 'queued' : state.stage;
    return {
      title: input.title,
      stage: { code: `case-answer-card.${stage}`, text: status === 'failed' ? error?.message ?? '' : stageText(input.language, stage, state) },
      progress: { done: status === 'complete' ? STEPS : state.done, total: STEPS, unit: 'steps', percent: null, segments: [] },
      // The question this task writes for; how its card came out (status, calls) once it is saved.
      detail: { deckId: input.deckId, cardId: input.cardId, status: state.status, calls: state.calls },
      legacy: { runId: input.runId, scopeHash: input.scopeHash, cardStage: stage },
    };
  };
}

/**
 * One answer card of a case question: the write (a Step of the gateway), the program's checks (quotes word for word, rubric coverage, invented numbers),
 * an independent review (a second Step), one repair when the program or the review found problems (a third Step), then ONE save beside the question
 * through the bank context (`card.answerCard.set`, refused when the question changed since the task began). Not durable: a stop or a failure saves nothing.
 */
export const answerCardDefinition = {
  kind: ANSWER_CARD_KIND, version: 1, title: CARD_JOB_TITLE, legacyFields: CARD_FIELDS, capabilities: CAPABILITIES,
  legacyId: input => `case-answer-card-${input.runId}`,
  initialPresentation: input => present(input, { stage: 'queued', done: 0, status: null, calls: 0 }),

  async run(context, input, { answerCard: env }) {
    const { plan, kept } = env, state = { stage: 'writing', done: 0, status: null, calls: 0, reused: 0 };
    const reader = present(input, state);
    const show = (stage, done) => { Object.assign(state, { stage, done }); try { context.present(reader); } catch { /* the Attempt is over */ } };
    const ask = makeAsk(context, kept, state, { feature: 'case' });
    const context_ = { stem: plan.stem, materials: plan.materials, criteria: plan.criteria, numbers: plan.numbers };
    const normalize = raw => normalizeAnswerCard(raw, { types: plan.types, language: plan.cardLanguage });
    const asked = async (key, labels, prompt, read, settle) => { state.calls++; return ask(key, labels, prompt, read, settle); };
    show('writing', 0);
    const written = await asked(`ac:${plan.key}:write`, { stage: 'write' }, writePrompt(plan), readCard, async raw => normalize(raw));
    if (!written) throw coded('answer-card-unreadable', FAILURES.unreadable(input.language));
    show('checking', 1);
    let card = checkAnswerCard(written, context_);
    show('reviewing', 2);
    const reviewed = await asked(`ac:${plan.key}:review`, { stage: 'review' }, reviewPrompt(plan, card), readReview, async raw => raw);
    const review = { ran: !!reviewed, issues: reviewed ? normalizeCardReview(reviewed) : [], repaired: false };
    const problems = cardProblems({ ...card, checks: { ...card.checks, review } });
    if (problems.length) {
      show('repairing', 3);
      const repaired = await asked(`ac:${plan.key}:repair`, { stage: 'repair' }, repairPrompt(plan, card, problems),
        text => readCardRepair(text, card), async raw => normalize(raw));
      if (repaired) { card = checkAnswerCard(repaired, context_); review.repaired = true; }
    }
    const done = finishAnswerCard(card, { review, basis: plan.basis });
    state.status = done.status;
    show('saving', 3);
    context.signal.throwIfAborted();
    try {
      await env.save({ deckId: plan.deckId, cardId: plan.cardId, answerCard: done, basis: plan.basis });
    } catch (cause) {
      if (context.signal.aborted) throw cause;
      throw cause?.code === 'answer-card-stale' ? coded('answer-card-stale', FAILURES.stale(input.language), cause)
        : coded('answer-card-save-failed', FAILURES.saveFailed(input.language), cause);
    }
    show('complete', STEPS);
    return { refs: [{ kind: 'card', id: plan.cardId, deckId: plan.deckId }], completeness: 'complete' };
  },
};
