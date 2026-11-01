import { supplementBudgetPublication, supplementPublication } from '../../../runtime/jobs.js';
import { STOP_REASONS, roundList, unitOfRefs } from '../../../coverage-run.js';
import { isBlank } from '../../../case-study.js';
import { describePartReport } from '../../../generation-report.js';
import { recordEvent } from '../../../job-calls.js';
import { get } from '../../../util.js';
import { publishCase } from '../case-publish.js';
import { runStageText } from '../coverage-runs.js';
import { publishDraft, resultOfReceipt } from '../jobs/publish-step.js';
import { CASE, EXECUTE, NOT_FOUND_LABEL } from './messages.js';

/* The end of a run that was not stopped: why it is over, in the marker, in the log and on the job; a supplement's publication; a pasted case's grading; the last words
    on the card. */

/** A stop that leaves sections without a question names them and says how many retry rounds were made, so the line is not a number of rounds nobody can check. */
function stopDetails({ plan, book, lastUncovered }, final) {
  const names = book.refsOf([...(lastUncovered || [])], 4);
  const left = final.left > 0 ? { unit: names ? unitOfRefs(names) : 'part', ...(names ? { names } : {}),
    fills: roundList(plan.spec).filter(item => item.fill && ['done', 'failed'].includes(item.status)).map(item => item.round) } : {};
  return { ...(final.left !== undefined ? { left: final.left } : {}), ...(final.uncredited ? { uncredited: final.uncredited } : {}), ...(final.code ? { code: final.code } : {}),
    ...(final.detail ? { detail: final.detail } : {}), ...left };
}

export async function closeRun(run, final) {
  const { job, plan, book } = run;
  if (!plan) return;
  if (final.type === 'wait') {
    book.moved({ type: 'wait' });
    recordEvent(job, { level: 'done', code: 'run-waiting', args: { round: plan.round, rounds: plan.spec.rounds.length,
      left: roundList(plan.spec).filter(item => item.status === 'pending').length } });
    book.syncRun();
  } else book.stopRun(final.reason, stopDetails(run, final));
  // What follows the last round is real work (the draft, with its plan and the marker of the run, is written once more): the log says so, with how long it took, so the
  // minutes before the job's end are not silent.
  const closing = Date.now();
  recordEvent(job, { level: 'step', code: 'run-closing', args: { cards: job.savedCount ?? 0 } });
  await book.persist();
  recordEvent(job, { level: 'step', code: 'run-closed', args: { ms: Date.now() - closing } });
  if (final.type === 'stop' && STOP_REASONS[final.reason].ok) job.requestedTotal = job.savedCount ?? job.requestedTotal;
}

/** The questions of a supplement go into the deck it was asked for. */
export async function publishIntoTarget(run, budgetReached = false) {
  const { job, controller, models, commit, plans, prep: { target }, host } = run;
  job.stage = 'Publishing reviewed questions into the requested deck';
  const asked = { id: job.draftId, draftVersion: run.savedVersion, mergeTargetId: target.id, requireReviewed: true, [supplementPublication]: job.id,
    ...(budgetReached ? { [supplementBudgetPublication]: true } : {}) };
  const result = host.publishManaged && commit
    ? resultOfReceipt(await publishDraft({ call: host.call, read: host.read, models, signal: controller.signal, commit, plans, stepKey: budgetReached ? 'publish-budget' : 'publish',
      base: asked, draft: { id: job.draftId, draftVersion: run.savedVersion, title: job.deckTitle },
      meta: { targetTitle: target.title, sourceIds: job.sourceIds, kind: job.kind, count: job.count, requestedTotal: job.requestedTotal, savedCount: job.savedCount } }))
    : await host.call('draft.publish', asked);
  job.publication = { deckId: result.deckId || null, added: result.added || 0, total: result.total ?? null,
    accepted: result.accepted, rejected: result.rejected, remainingDraftId: result.rejectedDraft?.id || null };
  if (result.deckId !== target.id) throw new Error(EXECUTE.nothingPassed);
  if (result.rejectedDraft) job.draftId = result.rejectedDraft.id;
  else delete job.draftId;
}

/** A pasted case with the learner's answers is theirs: publish it and grade the answers now. */
async function publishPastedCase(run) {
  const { job, controller, models, commit, plans, prep: { request }, host } = run;
  const answers = request.case?.answers;
  if (!answers?.some(answer => !isBlank(answer))) return;
  const draftId = job.draftId, saved = get((await host.read()).drafts, draftId, NOT_FOUND_LABEL.draft);
  if (host.publishManaged && commit) {
    await publishCase({ call: host.call, read: host.read, models, signal: controller.signal, commit, plans, job, draft: { id: draftId, draftVersion: run.savedVersion,
      title: saved.title, cards: saved.cards }, answers });
    return;
  }
  job.stage = 'Publishing the imported case';
  delete job.draftId;
  const receipt = await host.call('draft.publish.quick', { id: draftId, draftVersion: run.savedVersion });
  job.publication = { deckId: receipt.deckId || receipt.id, added: receipt.added, total: receipt.total };
  const answered = answers.map((answer, index) => ({ answer, card: saved.cards[index] })).filter(item => item.card && !isBlank(item.answer));
  for (const [index, item] of answered.entries()) {
    controller.signal.throwIfAborted();
    job.stage = `Reviewing your answers against the rubric ${index + 1}/${answered.length}`;
    await host.call('card.grade', { deckId: job.publication.deckId, cardId: item.card.id, answer: item.answer });
  }
  job.graded = answered.length;
}

function finalStage({ job, plan, deck, prep, host }, final) {
  if (job.graded) return host.say(...CASE.graded(job.graded));
  if (prep.publishTarget) return `Added ${job.publication.added} questions to ${prep.target.title}; total ${job.publication.total}`;
  if (plan) return runStageText(final, plan, job);
  if (job.savedCount < job.requestedTotal || deck.editorial.failures.length)
    return `Draft ready with ${job.savedCount}/${job.requestedTotal} questions; ${deck.editorial.failures.length} part(s) failed`;
  return 'Draft ready for review';
}

export async function finishRun(run, final) {
  const { job, controller, deck, prep, host } = run;
  await closeRun(run, final);
  controller.signal.throwIfAborted();
  // How many parts passed or failed and why, in plain words, for the card and for the agent that reads the job (lib/generation-report.js).
  if (deck?.editorial?.partReport) job.partReport = { ...deck.editorial.partReport, summary: describePartReport(deck.editorial.partReport, host.language) };
  if (prep.publishTarget) await publishIntoTarget(run);
  await publishPastedCase(run);
  job.status = 'complete';
  job.stage = finalStage(run, final);
}
