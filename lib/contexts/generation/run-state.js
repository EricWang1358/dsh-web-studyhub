/* The one place a coverage run's state changes: `transitionRunState({ marker, spec }, event) -> { marker, spec }`. Pure, no I/O; the clock comes in on the event.

   `marker` is the draft's editorial.coverageRun and `spec` its editorial.coverageSpec (lib/coverage-run.js says what they hold), so a run's state is what is already on the learner's disk: there is no
   second record and no field a release that is rolled back to would not know. The status of the JOB is not here: on the unified runtime the kernel owns it (lib/jobs/contract-schema.js).
   docs/plans/coverage-generation/run-state.md is this table in words, with the glossary.

   A move this table does not allow is a mistake in the executor, not a state of the world, and throws `illegal-run-transition`. What is read from a draft is never refused: `resume` and `recover` take any
   marker a library holds, and a state this release does not know is simply not one that comes back by itself (coverage-runs.js interruptedRuns). */
import { STOP_REASONS, appendFillRound, finishRound, markRound, owedKeys, resetRunning, roundList } from '../../coverage-run.js';
import { newMarker, resumedMarker } from './coverage-runs.js';

const refuse = (event, why) => Object.assign(new Error(`A coverage run cannot "${event.type}": ${why}`), { code: 'illegal-run-transition' });
const metPlan = reason => reason === 'complete' || reason === 'target';
const inFlight = spec => roundList(spec).filter(round => round.status === 'running').map(round => round.index);
const stateIs = (run, event, ...states) => { if (!states.includes(run.marker?.state)) throw refuse(event, `the run is ${run.marker?.state}`); };
const roundAt = (run, event) => { const round = run.spec?.rounds?.[event.index]; if (!round) throw refuse(event, `there is no round ${event.index}`); return round; };
const marked = (run, patch) => ({ ...run, marker: { ...run.marker, ...patch } });

const MOVES = Object.freeze({
  start(run, event) {
    if (run.marker) throw refuse(event, 'it has started');
    return { ...run, marker: newMarker(markerOptions(event)) };
  },
  resume: (run, event) => ({ ...run, marker: resumedMarker(run.marker, markerOptions(event)) }),
  'round-start'(run, event) {
    stateIs(run, event, 'running');
    roundAt(run, event);
    if (inFlight(run.spec).length) throw refuse(event, 'another round is in flight');
    return { ...run, spec: markRound(run.spec, event.index, 'running', event) };
  },
  'round-finish'(run, event) {
    if (roundList(run.spec)[event.index]?.status !== 'running') throw refuse(event, `round ${event.index} is not in flight`);
    return { ...run, spec: finishRound(run.spec, event.index, event) };
  },
  // The run stops with a round in flight. A round that owes sections no pass asked for (an earlier pass of it settled, or this pass was asked for part of it) goes back to pending, owing them: the stopped pass
  // counts nothing as tried (`asked: []`), and 接着做 asks them. A first pass that was asked for the whole round is failed (its sections are the top-up's and the fill rounds').
  'round-stopped'(run, { tokens, ms, reason, uncovered, at }) {
    const index = run.spec.rounds.findIndex(round => round.status === 'running');
    if (index < 0) return run;
    const stopped = run.spec.rounds[index], pass = new Set(stopped.askedKeys || []);
    const owes = uncovered instanceof Set && (Array.isArray(stopped.triedKeys) || owedKeys(stopped).some(key => uncovered.has(key) && !pass.has(key)));
    return { ...run, spec: finishRound(run.spec, index, { status: 'failed', kept: 0, covered: 0, tokens, ms, reason, at, ...(owes ? { asked: [], left: uncovered } : {}) }) };
  },
  // A round that owes nothing any more: done when a pass of it ran (what that pass tried and did not get is a fill round's), else skipped.
  'round-skip'(run, event) {
    const round = roundAt(run, event);
    if (round.status === 'running') throw refuse(event, `round ${event.index} is in flight`);
    return { ...run, spec: Array.isArray(round.triedKeys) ? markRound(run.spec, event.index, 'done') : markRound(run.spec, event.index, 'skipped', { reason: 'covered' }) };
  },
  'fill-append': (run, event) => ({ ...run, spec: appendFillRound(run.spec, event) }),
  pause(run, event) {
    stateIs(run, event, 'running');
    if (inFlight(run.spec).length) throw refuse(event, 'a round is in flight: the run stands between rounds only');
    return marked(run, { state: 'paused' });
  },
  unpause(run, event) { stateIs(run, event, 'paused'); return marked(run, { state: 'running' }); },
  wait(run, event) { stateIs(run, event, 'running'); return marked(run, { state: 'waiting' }); },
  // From 'waiting' too: a job that was stopped just after its last round had reached the learner's turn.
  stop(run, event) {
    stateIs(run, event, 'running', 'paused', 'waiting');
    if (run.marker.stop) throw refuse(event, 'it has stopped');
    if (!STOP_REASONS[event.reason]) throw refuse(event, `no such reason: ${event.reason}`);
    return marked(run, { state: metPlan(event.reason) ? 'complete' : 'stopped', stop: { reason: event.reason, at: event.at, round: event.round, ...event.extra } });
  },
  usage: (run, event) => marked(run, { tokensUsed: event.tokensUsed }),
  auto: (run, event) => marked(run, { autoComplete: event.autoComplete }),
  touch: (run, event) => marked(run, { updatedAt: event.at }),
  recover: run => ({ ...run, spec: resetRunning(run.spec) }),
});
const markerOptions = ({ jobId, autoComplete, tokenBudget, estimate, at }) => ({ jobId, autoComplete, tokenBudget, estimate, startedAt: at });

export const RUN_EVENTS = Object.freeze(Object.keys(MOVES));

export function transitionRunState(run, event) {
  const move = Object.hasOwn(MOVES, event?.type) ? MOVES[event.type] : null;
  if (!move) throw refuse(event ?? {}, 'there is no such event');
  return move(run, event);
}
