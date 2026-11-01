import { recordEvent } from '../../../job-calls.js';
import { STOP_REASONS, inFlightDue, owedDue, roundList, roundsDue, sectionRef, wantedUncovered } from '../../../coverage-run.js';
import { totalTokens } from '../../../token-usage.js';
import { mirrorOf } from '../coverage-runs.js';
import { transitionRunState } from '../run-state.js';

/* The bookkeeping of a coverage run: the state of the rounds and the marker go to the draft at every boundary, and the job shows the same facts live.
   One book per execution. `run`: { job, plan, runId, checkpoint, savedVersion, prep: { coverageRun }, host: { read, call } }; `savedVersion` is the run's, this book
   writes it when it saves. */

const ofRound = (list, number) => (Array.isArray(list) ? list.filter(item => item.round === number) : []);

export function createRunBook(run) {
  const { job, plan, host } = run;
  // The sections as a line of the log names them (a page, else its title): the leaves of the plan, then what each coverage view says.
  const known = new Map((run.prep.coverageRun?.leaves || []).map(section => [section.key, section]));
  const refOf = key => sectionRef(known.get(key));

  const tokensNow = () => plan.tokensBase + totalTokens(job.tokenUsage);

  /** The round in flight: what it was asked for, less what its plan could not fill, and what of it is still to come (lib/coverage-run.js inFlightDue: the points its
      planner returned that are not decided
      yet). `asks` keeps what each pass of a round this job started really makes (a round may run twice: what a press for some of its sections left): the job's own count
      is made of them. */
  const flight = () => {
    const index = plan.spec.rounds.findIndex(item => item.status === 'running');
    if (index < 0) return null;
    const number = plan.spec.rounds[index].round;
    const due = inFlightDue({ asked: plan.spec.rounds[index].questions, points: ofRound(job.planTargets?.list, number), short: ofRound(job.planTargets?.short, number),
      kept: (job.savedCount ?? 0) - (plan.cardsBefore ?? 0) });
    plan.asks.set(plan.pass ?? index, due.asked);
    return due;
  };

  const syncRun = () => {
    if (!plan?.spec) return;
    const due = roundsDue(plan.spec, { uncovered: plan.uncovered, running: flight() }), list = roundList(plan.spec);
    job.coverageRun = mirrorOf(plan.spec, plan.marker, { percent: plan.percent, cover: plan.cover, draftId: job.draftId, due, tokensBase: plan.tokensBase });
    if (!job.continued || !plan.asks.size) return;
    // (The round in flight may owe more than its pass: owedDue, its next pass in this job when the run goes on.)
    const inFlight = list.findIndex(item => item.status === 'running'), rest = inFlight >= 0 ? owedDue(plan.spec, inFlight, plan.uncovered) : 0;
    const later = plan.marker.autoComplete !== false ? due.reduce((sum, value, index) => sum + (list[index]?.status === 'pending' ? value : 0), 0) + rest : 0;
    job.askedQuestions = [...plan.asks.values()].reduce((sum, value) => sum + value, 0) + later;
  };

  /** The coverage the run shows, from a view of the draft: the percent and the sections that have a question (the progress of the job is counted in them). */
  const seen = view => {
    plan.percent = view.percentLeaves;
    plan.cover = { ...plan.cover, leaves: view.leaves, covered: view.covered };
    plan.uncovered = wantedUncovered(plan.spec, view);
  };

  /** Every change of the run's state is a move of the table (run-state.js); the executor says what happened. */
  const moved = event => { ({ marker: plan.marker, spec: plan.spec } = transitionRunState({ marker: plan.marker, spec: plan.spec }, { at: new Date().toISOString(), ...event })); };

  const persist = async () => {
    if (!plan?.spec || !job.draftId) return;
    const current = (await host.read()).drafts.find(item => item.id === job.draftId);
    if (!current) return;
    moved({ type: 'touch' });
    const editorial = { ...current.editorial, generation: { ...current.editorial.generation, runId: run.runId }, coverageSpec: plan.spec, coverageRun: plan.marker };
    const saved = await host.call('draft.save', { deck: { ...current, editorial }, requireExisting: true });
    run.savedVersion = saved.draftVersion;
    await run.checkpoint?.(saved);
  };

  const stopRun = (reason, extra = {}) => {
    const stated = STOP_REASONS[reason];
    moved({ type: 'stop', reason, round: plan.round, extra });
    recordEvent(job, { level: stated.level, code: 'run-stop', args: { reason, round: plan.round, ...extra } });
    syncRun();
  };

  return {
    tokensNow, syncRun, seen, moved, persist, stopRun, refOf,
    /** The names of `keys` for a line of the log, when there are at most `max` and all are known. */
    refsOf(keys, max) {
      const refs = keys.map(refOf);
      return refs.every(Boolean) && keys.length <= max ? refs : null;
    },
    know(sections) { for (const section of sections) known.set(section.key, section); },
  };
}
