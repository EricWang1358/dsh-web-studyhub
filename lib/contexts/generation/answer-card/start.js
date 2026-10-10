import { id } from '../../../util.js';
import { planAnswerCard } from './plan.js';
import { ANSWER_CARD_KIND } from './jobs/case-answer-card.js';
import { REFUSALS } from './jobs/messages.js';

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });

/**
 * `generation.answerCard.build`: check the request (no model, nothing started when it refuses) and hand it to the unified runtime as one Job, visible in
 * the task console. No estimate and no confirmation. One task per question at a time. `ports.read()` is the library as this context reads it; `ports.bank`
 * is the bank context (the card is saved by its `card.answerCard.set`, which refuses when the question changed meanwhile); `ports.runtime` is
 * `{ jobs, sharedQuota }`; `ports.work.jobs` and `ports.activeJob` find a task already running for the question.
 */
export function createAnswerCardJobs(ports) {
  const { runtime, read, bank, work, activeJob } = ports;
  async function build(args = {}, request = {}) {
    const language = args.language === 'en' || request.language === 'en' ? 'en' : 'zh';
    if (!runtime?.jobs) throw refuse('executor-unavailable', language);
    const plan = planAnswerCard(await read(), { ...args, language });
    if (runtime.sharedQuota) throw refuse('capability-unverified', language);
    if ([...(work?.jobs?.values?.() || [])].some(job => job.type === ANSWER_CARD_KIND && activeJob(job) && job.contract?.detail?.cardId === plan.cardId))
      throw refuse('answer-card-running', language);
    const input = { runId: id(), title: plan.title, language, deckId: plan.deckId, cardId: plan.cardId, scopeHash: plan.key };
    const bindings = { answerCard: { plan, kept: { results: new Map() }, save: payload => bank('card.answerCard.set', payload, request) } };
    try {
      const started = await runtime.jobs.submit(ANSWER_CARD_KIND, input, {}, bindings);
      return { jobId: started.runtime.legacyId, status: 'running', deckId: plan.deckId, cardId: plan.cardId };
    } catch (error) {
      if (REFUSALS[error?.code]) throw refuse(error.code, language);
      throw error;
    }
  }
  return { 'generation.answerCard.build': build };
}
