import { recordEvent } from '../../../job-calls.js';
import { roundOfKeys, unitOfRefs, wantedUncovered } from '../../../coverage-run.js';
import { coverageForDraft, sourcesOfDraft } from '../../../coverage-state.js';
import { get } from '../../../util.js';
import { partPlanFor, partsFor } from './job-seed.js';
import { NOT_FOUND_LABEL } from './messages.js';

/* The start of a round: `ctx` is what it is asked for, and what the plan and the job say about it before the model is asked. */

const planIndex = ({ plan, prep }) => {
  if (prep.coverageRun) return 0;
  if (plan.first) return plan.first.type === 'round' ? plan.first.index : null;
  return prep.coverageAsked?.manual ? null : roundOfKeys(plan.spec, prep.covering.request.sectionKeys);
};

function mergeSourcesOf({ extraIds, covering, sources }, latest, base) {
  if (extraIds) return latest.sources.filter(source => base.editorial.generation.sourceIds.includes(source.id) || extraIds.includes(source.id));
  return covering ? sourcesOfDraft(latest, base) : sources;
}

/** What the first round is asked for. The deck's coverage list names every source it was written from, the added ones too. */
export function firstContext(run, { base, latest, count, assignments }) {
  const { prep, plan } = run, { covering, reuse, sources } = prep;
  return { base, mergeSources: mergeSourcesOf(prep, latest, base), sources, count, assignments, reuse, titles: covering?.request.titles, covering: !!covering, first: true,
    questions: covering ? covering.round.questions : count, index: plan ? planIndex(run) : null, keys: covering?.request.sectionKeys };
}

/** A retry round says which earlier rounds left its sections without a question (the rounds the plan recorded for them), and a small round names its sections. */
function logRoundStart({ job, plan, book }, { round, asked, unit, rerun }) {
  const rounds = plan.spec.rounds.length;
  if (rerun) recordEvent(job, { level: 'warn', code: 'round-rerun', args: { round: round.round, rounds } });
  const from = round.fill ? [...new Set(asked.flatMap(key => (plan.spec.attempts?.[key]?.rounds || []).map(item => item.round)))].sort((a, b) => a - b).slice(0, 4) : [];
  const names = book.refsOf(asked, 4);
  recordEvent(job, { level: 'done', code: 'round-start', args: { round: round.round, rounds, sections: asked.length, questions: round.questions, fill: !!round.fill, unit,
    ...(names ? { names } : {}), ...(from.length ? { from } : {}) } });
}

/** A later round's card: its questions and parts. */
function showNextRound({ job, prep, host }, ctx) {
  const planned = partsFor(prep.request, { sources: ctx.sources, count: ctx.count, reuse: ctx.reuse || [], assignments: ctx.assignments });
  Object.assign(job, { count: ctx.questions, parts: planned.length, partPlan: partPlanFor(planned, host.language, prep.fullSources),
    coverage: { sections: ctx.keys?.length ?? 0, questions: ctx.questions } });
  delete job.partReport;
}

/** A round that is not one of the plan (the sections the learner chose, the sections a run retries) is a fill round: it is written down as one, so the draft says what was run. */
function onPlan({ plan, book }, ctx) {
  if (ctx.index !== null && ctx.index >= 0) return;
  book.moved({ type: 'fill-append', keys: ctx.keys || [], questions: ctx.questions });
  ctx.index = plan.spec.rounds.length - 1;
}

/** A round that was in flight when the host stopped is run again once; a later pass of it (what it still owes) is not a re-run. */
function takeRerun(plan, index) {
  const rerun = plan.rerun.includes(index);
  if (rerun) plan.rerun = plan.rerun.filter(item => item !== index);
  return rerun;
}

const startingUncovered = (spec, viewNow) => viewNow ? wantedUncovered(spec, viewNow) : new Set((spec.quotas || []).map(item => item.sectionId));

/** Where the round starts from: what it finds uncovered, what it finds saved, when its clock starts. */
function measureFrom({ job, plan, book, clock }, ctx, round, before) {
  plan.uncovered = before;
  plan.before = before; plan.cardsBefore = ctx.base?.cards.length ?? 0; plan.t0 = Date.now(); clock.restartMeasure(); plan.tokensBefore = book.tokensNow();
  job.coveragePlan = { ...(job.coveragePlan || {}), round: round.round, rounds: plan.spec.rounds.length };
}

/** The draft says "running" before the model is asked (a restart finds the round in flight and runs it again); the first round of a new run has no draft yet, its first
    save says it.
    (Saving it makes a new version of the draft: the round is written on top of that one.) */
async function writeRunning({ job, host, book }, ctx, fresh) {
  if (!ctx.base) return fresh;
  await book.persist();
  const read = await host.read();
  ctx.base = get(read.drafts, job.draftId, NOT_FOUND_LABEL.draft);
  return read;
}

/** `fresh`: the library as the round reads it. For a coverage run, the round is written down as started: `before` the sections it finds without a question, `asked` what
    this pass is asked for. */
export async function beginRound(run, ctx) {
  const { plan, host, book } = run;
  const fresh = ctx.base ? await host.read() : run.latest;
  if (!plan) return { fresh, before: null, round: null, asked: [] };
  onPlan(run, ctx);
  plan.round = plan.spec.rounds[ctx.index].round;
  plan.pass = (plan.pass ?? 0) + 1;
  const rerun = takeRerun(plan, ctx.index);
  const viewNow = ctx.base ? coverageForDraft(fresh, ctx.base) : null;
  if (viewNow) book.know(viewNow.sections);
  // What this pass is ASKED for: the sections the job chose or what fits of the round (`ctx.keys`), else the whole round (the first round of a new run). Every count of the
  // round below is of these: a section of the round that was not asked for was not tried (no failed attempt, lib/coverage-run.js finishRound keeps the round owing it).
  const asked = Array.isArray(ctx.keys) ? [...ctx.keys] : [...plan.spec.rounds[ctx.index].sectionIds];
  const unit = unitOfRefs(asked.map(book.refOf));
  book.moved({ type: 'round-start', index: ctx.index, unit, questions: ctx.questions, asked });
  const round = plan.spec.rounds[ctx.index], before = startingUncovered(plan.spec, viewNow);
  measureFrom(run, ctx, round, before);
  if (!ctx.first) showNextRound(run, ctx);
  logRoundStart(run, { round, asked, unit, rerun });
  book.syncRun();
  return { fresh: await writeRunning(run, ctx, fresh), before, round, asked };
}
