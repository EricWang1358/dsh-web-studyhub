/* How far a draft is from what was asked, from ONE function (the evaluation of 2026-10-06, D-1/D-2/D-12). The home banner, the 待发布 row, the 任务 console's header and strip and the draft page
   all read THIS object and say it in the same words (ui/coverage/copy.js shortfallLines), so one fact is one number and one sentence on every screen:
   the same questions, the same sections, the same round, the same next step. Pure, no I/O and no Node modules (the browser reads it too).

   shortfallOf({ draft, coverage, round, job, canTopUp }) ->
     questionsKept, questionsGoal, questionsMissing   the questions the draft holds, what its plan (else its own request) asked for, and the difference
     percent                                          the same number the 任务 console's headline says (lib/job-contract.js): the coverage (the sections that have a question) of a draft with a plan, else the questions kept over
                                                      the goal; 100 only when nothing is missing (never for a short, stopped or refused draft, and no 99 for "not done": 76 is 76), null when nothing is known
     sectionsTotal, sectionsCovered, sectionsUncovered, sectionsUnderQuota
                                                      the leaf sections of the material, those with a question, those without, and those that have fewer questions than the plan gave them
                                                      (null when the coverage view has not arrived: nothing is invented)
     roundsLeft, nextRoundSections, nextRoundQuestions, sectionsAfterNextRound
                                                      what the next round covers (lib/coverage-round.js planRound: the one the button runs) and how many sections it leaves
     state                                            running | paused | stopped | refused | cancelled | interrupted | done
     reason                                           why: null | paused | interrupted | refused | learner | manual | budget | no-progress | sections-left | round-failed | no-plan | questions-short | complete | target
     failure                                          the failure code behind a refusal (lib/generation-failure.js): credential | quota
     action                                           the ONE primary action: null | resume | continue (接着做) | topup (为没覆盖的部分补题) | model-settings (去配置模型)
     secondary                                        the other, deliberate action that stays available beside a primary one: 'topup' beside the 接着做 of a plain run (null otherwise); never a second primary
     planned                                          the draft has a plan (a coverage run's, or the rounds a top-up made): only a plan promises sections; a plain run promised a number of questions
     continueKind                                     what 接着做 continues: 'rounds' (the rounds of the plan, from the next one) or 'count' (a plain run: the questions it was asked for and still owes, `questionsMissing`)
     canContinue                                      the run can go on (接着做): a refused, interrupted or paused run, a plain run that is short of its count
     coveragePercent, afterRoundPercent, roundsToFull, questionsToFull
                                                      the way to full coverage, from the one function that plans a round: the coverage now, about what it is once the next round has run, and how many rounds
                                                      and questions it takes to reach every section (the first round included); null when the coverage view has not arrived
     ready                                            nothing is missing: all questions, every section the plan wants
     auto, level                                      自动补到完整 on, and the coverage level of the plan (null without a plan)
     units, coveragePercent, roundsDone, round, stop, pausedAfter
                                                      the unit of the material (lib/coverage.js units), the coverage in percent, the rounds done, the round that is made or comes next, the run's own stop {reason, round, left?, code?}
     repeating                                        the sections that failed again and again (the plan records `attempts`), with their reason, which a run no longer tries by itself, the rounds they were
                                                      tried in and, when the plan came back short, how many points it needed and got (`short`: { needed, got, chars, ... })
   A section's `weight.quota` is how many questions the plan gave it (lib/coverage-state.js annotateCoverage). */
import { draftRunFacts, REPEAT_LIMIT } from './coverage-run.js';
import { classifyFailure, isPermanentFailure } from './generation-failure.js';
import { isActiveJob } from './job-status.js';
import { canContinueDraft } from './draft-continuation.js';

export const SHORTFALL_STATES = Object.freeze(['running', 'paused', 'stopped', 'refused', 'cancelled', 'interrupted', 'done']);

export { REPEAT_LIMIT };

const whole = (value) => (Number.isFinite(value) ? value : null);
const OK_STOPS = new Set(['complete', 'target']);

/** The sections whose recorded failed attempts reached the limit and that still have no question, in reading order: [{ key, title, page?, n?, reason, attempts }]. */
export function repeatingSections(spec, coverage) {
  const attempts = spec?.attempts;
  if (!attempts || typeof attempts !== 'object' || !Array.isArray(coverage?.sections)) return [];
  return coverage.sections.filter((section) => section.state !== 'covered' && attempts[section.key]?.n >= REPEAT_LIMIT)
    .map((section) => ({ key: section.key, title: section.title || '', ...(section.page ? { page: section.page } : {}), ...(section.n ? { n: section.n } : {}), id: section.id,
      ...(section.sourceId ? { sourceId: section.sourceId, start: section.start } : {}), reason: attempts[section.key].reason || 'other', attempts: attempts[section.key].n,
      ...(Array.isArray(attempts[section.key].rounds) ? { rounds: attempts[section.key].rounds } : {}), ...(attempts[section.key].short ? { short: attempts[section.key].short } : {}) }));
}

export function shortfallOf({ draft, coverage, round, job, canTopUp = true } = {}) {
  const editorial = draft?.editorial || {}, spec = editorial.coverageSpec, kept = draft?.cards?.length ?? 0;
  const leaves = whole(coverage?.leaves), covered = whole(coverage?.covered);
  const known = leaves !== null && covered !== null, uncovered = known ? Math.max(0, leaves - covered) : null;
  const facts = draftRunFacts(draft, { job, percent: coverage?.percentLeaves ?? null, coverage });
  const stop = facts?.stop || null, live = !!job && isActiveJob(job);
  // The record of a run that ended before it was done (failed, or stopped by the learner): it says how it ended and whether it can be continued.
  const endedJob = job && !live && ['failed', 'cancelled'].includes(job.status) ? job : null, continuable = !!endedJob && (endedJob.contract?.actions?.retry?.available === true || endedJob.retryable === true);

  // The state: what works on the draft now, else why it stands still.
  let state, reason = null, failure = null;
  const failedJob = job?.status === 'failed' ? classifyFailure(job.stage) : null;
  if (facts?.live || (live && !facts)) { state = facts?.state === 'paused' || job?.paused ? 'paused' : 'running'; reason = state === 'paused' ? 'paused' : null; }
  else if (facts?.interrupted || job?.status === 'interrupted') { state = 'interrupted'; reason = 'interrupted'; }
  else if (facts?.state === 'complete' || (known && uncovered === 0)) { state = 'done'; reason = stop && OK_STOPS.has(stop.reason) ? stop.reason : null; }
  else if (stop?.reason === 'refused' || (failedJob && isPermanentFailure(job.stage))) {
    state = 'refused'; reason = 'refused'; failure = stop?.code || (stop?.detail ? classifyFailure(stop.detail).code : null) || failedJob?.code || 'credential';
  } else if (stop?.reason === 'learner') { state = 'cancelled'; reason = 'learner'; }
  // A plain run that the learner stopped, or that ended (the time limit, a failure): the draft keeps what passed and the record says how it ended.
  else if (!facts && endedJob?.status === 'cancelled') { state = 'cancelled'; reason = 'learner'; }
  else { state = 'stopped'; reason = stop?.reason || (facts ? 'manual' : endedJob ? (failedJob?.code === 'budget' ? 'time-limit' : 'run-failed') : 'no-plan'); }

  // The goal: what the plan asked for (the first round's own request is not the goal), else the draft's own request. A run that met its plan made exactly what it was asked for.
  const metPlan = facts?.state === 'complete' || (stop && OK_STOPS.has(stop.reason) && state === 'done');
  const asked = spec?.goal > 0 ? spec.goal : Number.isInteger(editorial.requested) ? editorial.requested : kept;
  const goal = metPlan ? kept : Math.max(asked, kept);
  const missing = Math.max(0, goal - kept);
  if (state === 'done' && !reason && missing > 0) reason = 'questions-short';
  const underQuota = known && spec && Array.isArray(coverage.sections) ? coverage.sections.filter((section) => section.state === 'covered' && Number.isInteger(section.weight?.quota) && (section.cards ?? 0) < section.weight.quota).length : known ? 0 : null;
  const ready = state === 'done' && missing === 0 && (uncovered === 0 || metPlan);

  // A plain run (no plan: it was asked for a number of questions) that is short of that number continues THAT: the questions it still owes, from the sources and with the settings it had. Sections are
  // the top-up's business, which stays beside it (`secondary`) and never competes as a second primary.
  const planned = !!spec?.rounds?.length, owes = !planned && !live && state !== 'running' && canContinueDraft(draft);
  const topUp = uncovered > 0 && canTopUp && (state === 'stopped' || state === 'cancelled' || (owes && state !== 'paused'));
  const roundsFailed = planned && continuable && state === 'stopped' && reason === 'round-failed';
  const action = state === 'paused' ? 'resume' : state === 'interrupted' ? 'continue' : state === 'refused' ? 'model-settings' : owes || roundsFailed ? 'continue' : topUp && (state === 'stopped' || state === 'cancelled') ? 'topup' : null;
  const next = round && Number.isFinite(round.sections) ? round : null;
  return {
    questionsKept: kept, questionsGoal: goal, questionsMissing: missing,
    percent: ready ? (goal > 0 ? 100 : null) : planned && known && leaves > 0 ? Math.min(99, coverage.percentLeaves ?? Math.round(covered / leaves * 100)) : goal > 0 ? Math.min(99, Math.round(kept / goal * 100)) : null,
    sectionsTotal: leaves, sectionsCovered: covered, sectionsUncovered: uncovered, sectionsUnderQuota: underQuota,
    roundsLeft: state === 'done' ? 0 : next ? whole(next.rounds) : facts ? facts.left : null,
    afterRoundPercent: known && next && leaves > 0 ? Math.min(100, Math.round((covered + next.sections) / leaves * 100)) : null, roundsToFull: next ? whole(next.rounds) : null, questionsToFull: next ? whole(next.allQuestions) : null,
    nextRoundSections: next ? next.sections : null, nextRoundQuestions: next ? next.questions : null, sectionsAfterNextRound: next ? Math.max(0, next.left ?? 0) : null,
    state, reason, ...(failure ? { failure } : {}), action, secondary: owes && action === 'continue' && topUp ? 'topup' : null, planned, continueKind: planned ? 'rounds' : 'count',
    ended: endedJob ? { status: endedJob.status, stage: String(endedJob.stage ?? '').slice(0, 400) } : null,
    canContinue: state === 'refused' || state === 'interrupted' || state === 'paused' || owes || roundsFailed, ready,
    auto: facts ? facts.auto : null, level: spec?.level ?? null, repeating: repeatingSections(spec, coverage),
    // what the sentences are made of: the unit of the material, the coverage in percent, the rounds done and the next one, why a run stopped
    units: coverage?.units ?? 'section', coveragePercent: whole(coverage?.percentLeaves), roundsDone: facts ? facts.done : null, round: facts ? facts.round : null, stop,
    ...(facts?.pausedAfter ? { pausedAfter: facts.pausedAfter } : {}),
  };
}
