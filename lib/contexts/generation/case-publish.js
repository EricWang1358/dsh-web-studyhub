import { id } from '../../util.js';
import { isBlank } from '../../case-study.js';
import { recordEvent } from '../../job-calls.js';
import { publishDraft } from './jobs/publish-step.js';
import { CASE_TEXT, PUBLISH_TEXT } from './jobs/messages.js';

/* A pasted case with the learner's answers is published and graded at once (the end of a `generate { kind: 'case' }` run). Kept on disk (behind `generationPublish`), the publication
   is the same plan + runtime commit + look-again as every other publication, and every grading is found done by its attempt in the library: a run that was cut short after the
   publication is finished by a later Attempt - it neither imports the case again nor grades an answer twice. */

export const CASE_STEP = 'publish-quick';

/** The answered questions of a case deck, in order: the learner's answer with the card it answers. */
export const answeredOf = (answers, cards) => (answers || []).map((answer, index) => ({ answer, card: cards[index] })).filter(item => item.card && !isBlank(item.answer));

/** Whether this answer to this question is already graded in the library (a rubric attempt with that answer). */
const graded = (state, deckId, cardId, answer) => state.attempts.some(item => item.assessment === 'rubric' && item.deckId === deckId && item.quiz_id === cardId && item.learnerAnswer === answer);

/** Grade the answers that are not graded yet; the number graded in all (before and now) is left on the card. */
export async function gradeRemaining({ call, read, signal, job, deckId, answered }) {
  for (const [index, item] of answered.entries()) {
    signal.throwIfAborted();
    job.stage = CASE_TEXT.grading(index + 1, answered.length);
    if (graded(await read(), deckId, item.card.id, item.answer)) continue;
    await call('card.grade', { deckId, cardId: item.card.id, answer: item.answer });
  }
  job.graded = answered.length;
}

/** Publish the draft of a case and grade its answers, the way a kept run does. `draft` is the draft as saved ({ id, draftVersion, title, cards }). */
export async function publishCase({ call, read, models, signal, commit, plans, job, draft, answers }) {
  job.stage = CASE_TEXT.publishing;
  delete job.draftId;
  const receipt = await publishDraft({ call, read, models, signal, commit, plans, stepKey: CASE_STEP, quick: true, base: { id: draft.id, draftVersion: draft.draftVersion },
    draft: { id: draft.id, draftVersion: draft.draftVersion, title: draft.title }, meta: { title: draft.title, answers } });
  job.publication = { deckId: receipt.deckId || receipt.id, added: receipt.added, total: receipt.total };
  await gradeRemaining({ call, read, signal, job, deckId: job.publication.deckId, answered: answeredOf(answers, draft.cards) });
}

/** A later Attempt of a case run: the case was published (the runtime has seen the write through) and only gradings are left, or the draft is whole and only the publication and the
 * gradings are. Null when the run has to go on as a run. */
export function createCaseResume(ports, { env }) {
  const { state: storagePort, call, language } = ports;
  const { generationControllers, jobOutputs } = ports.work;
  // Only a runtime Attempt finishes this way: the runtime's session sink announces the result, so the task does not.
  const settle = job => { generationControllers.delete(job.id); jobOutputs.endJob(job.id); job.finishedAt = new Date().toISOString(); };

  return Object.freeze({ async taskFor({ args, runId, persistence }) {
    if (args.kind !== 'case' || !(args.answers || []).some(answer => !isBlank(answer))) return null;
    const state = await storagePort.read(), stored = await persistence?.store.load();
    const done = stored?.commits.find(commit => commit.stepKey === CASE_STEP && commit.status === 'complete');
    const draft = state.drafts.find(item => item.editorial?.generation?.runId === runId);
    if (!done && !draft) return null;
    const execute = async ({ job, controller, models, commit, plans }) => {
      job.status = 'running';
      try {
        const base = { call, read: storagePort.read, signal: controller.signal, job };
        if (done) {
          const deckId = done.receipt.deckId || done.receipt.id;
          job.publication = { deckId, added: done.receipt.added, total: done.receipt.total };
          const deck = (await storagePort.read()).decks.find(item => item.id === deckId);
          await gradeRemaining({ ...base, deckId, answered: answeredOf(args.answers, deck?.cards ?? []) });
        } else await publishCase({ ...base, models, commit, plans, draft, answers: args.answers });
        job.status = 'complete';
        job.stage = CASE_TEXT.imported(job.graded, language === 'en');
        if (done?.receipt.recovered) {
          job.recovered = true;
          job.stage = PUBLISH_TEXT.recoveredStage(job.stage);
          recordEvent(job, { level: 'info', code: 'publish-recovered', args: { deckId: job.publication.deckId, added: job.publication.added } });
        }
      } catch (error) {
        job.status = controller.signal.aborted && job.cancelRequestedAt ? 'cancelled' : 'failed';
        job.stage = error.message;
      } finally { settle(job); }
    };
    const seed = { id: id(), root: storagePort.root, kind: 'case', deckTitle: draft?.title ?? '', sourceIds: draft?.editorial?.generation?.sourceIds ?? args.sourceIds ?? [],
      count: args.questions?.length ?? 0, requestedTotal: draft?.cards.length ?? 0, savedCount: draft?.cards.length ?? 0, parts: 1, steps: [], messages: [],
      ...(draft ? { draftId: draft.id } : {}), status: 'running', stage: CASE_TEXT.publishing, startedAt: new Date().toISOString(), language };
    return { kind: 'generation', args, root: storagePort.root, seed, execute, models: { performance: {}, feature: env.feature } };
  } });
}
