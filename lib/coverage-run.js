/* A coverage RUN (phase 3b of docs/plans/coverage-generation): the rounds of a plan, one after another, on the same draft. Pure, no I/O and no Node modules: the executor
   (lib/contexts/generation/operations.js), the 任务 console, the draft page and the home row all read the state of a run through THIS file, so the facts on every screen are the same facts.

   THE DRAFT IS THE CHECKPOINT. Nothing is kept in a second store:
     editorial.coverageSpec.rounds[i] = { round, questions, sectionIds, status?, fill?, planned?, kept?, covered?, tokens?, ms?, startedAt?, finishedAt?, reason? }
        status   'pending' (also: none, a plan from before rounds were run) | 'running' | 'done' | 'failed' | 'skipped'
        a FILL round (`fill: true`) is appended after the planned rounds: the sections that were planned and did not come out, written again (at most FILL_ROUNDS of them)
        `code` (a round that failed): the cause as lib/generation-failure.js names it, so every screen says it in its own words and never in the provider's English
     editorial.coverageSpec.attempts = { [section key]: { n, reason, round } }   how many times a section was asked for in a round and still had no question, why the last time, and in which round
     editorial.coverageRun = { jobId, autoComplete, state, startedAt, updatedAt, tokensUsed, tokenBudget?, fillUsed, stop?: { reason, at, ...}, estimate? }
        state    'running' (a job executes the rounds) | 'paused' (the learner paused it between rounds) | 'waiting' (manual: the round is done, the learner presses 为没覆盖的部分补题 for the next)
                 | 'stopped' (it ended for a reason: `stop`) | 'complete' (every planned section has a question, or every round ran)
   A host that stops while a run is 'running' or 'paused' leaves the draft in that state: the next start finds it, restores the job as interrupted and 接着做 continues at the next round that is
   not done. A round that was in flight is run again from its start (its partial output is not trusted: what it already saved stays, since a question that passed review is kept wherever it came from).

   The decision after each round is `stepOf` and nothing else: complete | target reached | wait for the learner | budget | the next planned round | a fill round | stop because sections are left.
   The reason a run stops is one of STOP_REASONS, in plain words on the job, in the log and on the draft (ui/coverage/copy.js). */

export const FILL_ROUNDS = 2;
/** How many failed attempts a section may have (its planned round, then one fill round) before a run stops trying it by itself: it stays on the plan's list of sections that fail again and again (`attempts`). */
export const REPEAT_LIMIT = 2;
const ATTEMPT_ROWS = 600;
export const ROUND_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);
export const RUN_STATES = Object.freeze(['running', 'paused', 'waiting', 'stopped', 'complete']);

/** Why a run stops. `level` is the log level of the line; `ok`: the plan is met (the run did what it was asked), not a problem. */
export const STOP_REASONS = Object.freeze({
  complete: { level: 'done', ok: true },
  target: { level: 'done', ok: true },
  learner: { level: 'warn', ok: false },
  budget: { level: 'warn', ok: false },
  'no-progress': { level: 'warn', ok: false },
  'sections-left': { level: 'warn', ok: false },
  refused: { level: 'error', ok: false },
  'round-failed': { level: 'error', ok: false },
});

const isStatus = value => ROUND_STATUSES.includes(value);

/** The rounds of a spec as every screen reads them: index (0-based), round (the number), the sections, the status and what the round made. `interrupted`: a round that was running is pending again. */
export function roundList(spec, { interrupted = false } = {}) {
  const rounds = Array.isArray(spec?.rounds) ? spec.rounds : [];
  return rounds.map((item, index) => {
    let status = isStatus(item?.status) ? item.status : 'pending';
    if (interrupted && status === 'running') status = 'pending';
    return { ...item, index, round: Number.isInteger(item?.round) ? item.round : index + 1, questions: Number(item?.questions) || 0, sectionIds: Array.isArray(item?.sectionIds) ? item.sectionIds : [],
      status, fill: item?.fill === true };
  });
}

/** The indexes of the rounds a stopped host left running. */
export const interruptedRounds = spec => roundList(spec).filter(item => item.status === 'running').map(item => item.index);

/** The spec with every round a stopped host left running pending again (its partial output is not trusted: the round is run from its start). */
export const resetRunning = spec => ({ ...spec, rounds: (Array.isArray(spec?.rounds) ? spec.rounds : []).map(item => (item?.status === 'running' ? { ...item, status: 'pending' } : item)) });

/** The round of the plan a set of section keys is: the first round that is not done or skipped and holds every key (a button pressed for the sections of a round runs that round); -1 for any other choice. */
export function roundOfKeys(spec, keys) {
  const wanted = new Set(keys);
  if (!wanted.size) return -1;
  const found = roundList(spec).find(item => !item.fill && item.status !== 'done' && item.status !== 'skipped' && [...wanted].every(key => item.sectionIds.includes(key)));
  return found ? found.index : -1;
}

function withRound(spec, index, patch) {
  const rounds = Array.isArray(spec?.rounds) ? spec.rounds : [];
  if (!Number.isInteger(index) || index < 0 || index >= rounds.length) throw new Error(`There is no round ${index}`);
  return { ...spec, rounds: rounds.map((item, at) => (at === index ? { ...item, ...patch } : item)) };
}

/** The spec with round `index` in this status (and the time it started, for 'running'). */
export function markRound(spec, index, status, { at = new Date().toISOString(), reason } = {}) {
  if (!isStatus(status)) throw new Error(`Unknown round status: ${status}`);
  return withRound(spec, index, { status, ...(status === 'running' ? { startedAt: at } : {}), ...(reason ? { reason } : {}) });
}

/** The spec with round `index` finished: its status, how many questions it kept, how many sections it newly covered, what it cost, and why it failed or was skipped. */
export function finishRound(spec, index, { status = 'done', kept = 0, covered = 0, tokens = 0, ms = 0, reason, code, at = new Date().toISOString() } = {}) {
  if (!isStatus(status)) throw new Error(`Unknown round status: ${status}`);
  const round = Array.isArray(spec?.rounds) ? spec.rounds[index] : null;
  return withRound(spec, index, { status, planned: round?.questions ?? 0, kept, covered, tokens: Math.max(0, Math.round(tokens)), ms: Math.max(0, Math.round(ms)), finishedAt: at, ...(reason ? { reason } : {}), ...(code ? { code } : {}) });
}

/** Whether a section has failed enough times in rounds that a run no longer tries it by itself (a manual press still may). */
export const isRepeating = (spec, key) => (spec?.attempts?.[key]?.n || 0) >= REPEAT_LIMIT;

/** The spec with one more failed attempt recorded for each of `keys` (sections a round was asked for that still have no question): `reasonOf(key)` says why, `round` which round. Bounded: a huge material keeps the first rows. */
export function recordAttempts(spec, keys, reasonOf, round) {
  const attempts = { ...(spec?.attempts || {}) };
  for (const key of keys) {
    const before = attempts[key];
    if (!before && Object.keys(attempts).length >= ATTEMPT_ROWS) continue;
    attempts[key] = { n: (before?.n || 0) + 1, reason: reasonOf?.(key) || before?.reason || 'other', round };
  }
  return { ...spec, attempts };
}

/** The spec with a fill round added at the end: these sections, written again. */
export function appendFillRound(spec, { keys, questions }) {
  const rounds = Array.isArray(spec?.rounds) ? spec.rounds : [];
  return { ...spec, rounds: [...rounds, { round: rounds.length + 1, questions, sectionIds: [...keys], fill: true, status: 'pending' }] };
}

/** The first round of the plan that is not done and still has a section without a question: `{ index, keys, skipped? }` (`skipped`: the rounds before it whose sections all have questions already), or null. */
export function nextPlannedKeys(spec, uncovered) {
  const skipped = [];
  for (const item of roundList(spec)) {
    if (item.fill || item.status === 'done' || item.status === 'skipped' || item.status === 'failed') continue;
    const keys = item.sectionIds.filter(key => uncovered.has(key));
    if (keys.length) return { index: item.index, keys, ...(skipped.length ? { skipped } : {}) };
    skipped.push(item.index);
  }
  return null;
}

/**
 * What a run does after a round (or at its start). `uncovered`: the keys of the sections the plan wants that still have no question. `run`: { autoComplete, fillUsed, tokensUsed, tokenBudget? }.
 * -> { type: 'stop', reason, ... } | { type: 'wait', next } | { type: 'round', index, keys, skipped } | { type: 'fill', keys, skipped }
 * `skipped` are the planned rounds whose sections all have questions already (the executor marks them 'skipped').
 */
export function stepOf({ spec, uncovered, run, fillRounds = FILL_ROUNDS }) {
  const list = roundList(spec), open = list.filter(item => !item.fill && item.status !== 'done' && item.status !== 'skipped' && item.status !== 'failed');
  if (!uncovered.size) return open.length ? { type: 'stop', reason: 'target', skipped: open.map(item => item.index) } : { type: 'stop', reason: 'complete' };
  const next = nextPlannedKeys(spec, uncovered);
  if (run.autoComplete === false) return { type: 'wait', next: next ? next.index : -1 };
  if (run.tokenBudget > 0 && (run.tokensUsed || 0) >= run.tokenBudget) return { type: 'stop', reason: 'budget' };
  if (next) return { type: 'round', index: next.index, keys: next.keys, skipped: next.skipped || [] };
  const skipped = open.map(item => item.index);
  if ((run.fillUsed || 0) >= fillRounds) return { type: 'stop', reason: 'sections-left', left: uncovered.size };
  // A section that has failed again and again (REPEAT_LIMIT attempts) is left to the learner: writing it again would spend the same tokens for the same answer.
  const keys = [...uncovered].filter(key => !isRepeating(spec, key));
  if (!keys.length) return { type: 'stop', reason: 'sections-left', left: uncovered.size, skipped };
  return { type: 'fill', keys, skipped };
}

/** The sections the plan wants (the keys of its quotas) that still have no question: what a run still has to do. `coverage` is lib/coverage.js's; a quota whose section is no longer in the material is ignored. */
export function wantedUncovered(spec, coverage) {
  const state = new Map((coverage?.sections || []).map(section => [section.key, section.state])), out = new Set();
  for (const item of Array.isArray(spec?.quotas) ? spec.quotas : []) if (state.has(item.sectionId) && state.get(item.sectionId) !== 'covered') out.add(item.sectionId);
  return out;
}

/** What a round did to the sections the plan wants: how many that had no question have one now. A round that gained none made no progress. */
export function progressOf(before, after) {
  let gained = 0;
  for (const key of before) if (!after.has(key)) gained += 1;
  return { gained, progress: gained > 0 };
}

const sum = (list, pick) => list.reduce((total, item) => total + (Number(pick(item)) || 0), 0);

/**
 * The facts of a run, from its rounds (roundList) and its marker: ONE function for the 任务 console's header, the draft page and the home row.
 *   round     the 1-based number of the round being run, or the next to run (n at most)       left   rounds not done yet (pending or running)
 *   done      rounds done                                                                       tokensUsed   the run's tokens so far
 *   percent   the coverage in percent (the caller's: lib/coverage.js percentLeaves)
 *   projection  { tokens, minutes, basis } for what is left: 'history' from the rounds done (per planned question), 'estimate' from the estimator (`run.estimate.tokens`: { low, high }, no minutes),
 *               or null when nothing is known. A finished run has none.
 *   pausedAfter  the number of the last round done when the run is paused; waiting  whether it waits for the learner (manual)
 */
export function runFacts({ rounds, run = {}, percent = null }) {
  const list = Array.isArray(rounds) ? rounds : [], total = list.length;
  const done = list.filter(item => item.status === 'done').length, doing = list.find(item => item.status === 'running');
  const pending = list.filter(item => item.status === 'pending' || item.status === 'running'), next = doing || list.find(item => item.status === 'pending');
  const ended = ['complete', 'stopped'].includes(run.state) || !pending.length;
  const tokensUsed = Number.isFinite(run.tokensUsed) && run.tokensUsed > 0 ? run.tokensUsed : sum(list, item => item.tokens);
  const finished = list.filter(item => item.status === 'done' && item.questions > 0 && (item.tokens > 0 || item.ms > 0));
  let projection = null;
  if (!ended) {
    const left = sum(pending, item => item.questions), planned = sum(finished, item => item.questions);
    if (finished.length && planned > 0 && left > 0) {
      const tokens = sum(finished, item => item.tokens), ms = sum(finished, item => item.ms);
      projection = { tokens: Math.round(tokens / planned * left), minutes: ms > 0 ? Math.max(1, Math.round(ms / planned * left / 60000)) : null, basis: 'history' };
    } else if (run.estimate?.tokens && Number.isFinite(run.estimate.tokens.low) && Number.isFinite(run.estimate.tokens.high)) {
      projection = { tokens: Math.round((run.estimate.tokens.low + run.estimate.tokens.high) / 2), minutes: null, basis: 'estimate' };
    }
  }
  const lastDone = [...list].reverse().find(item => item.status === 'done');
  return { total, rounds: total, done, left: pending.length, round: next ? next.round : Math.max(done, total), running: doing ? doing.round : null, percent, tokensUsed, projection, state: run.state || null,
    auto: run.autoComplete !== false, ended, waiting: run.state === 'waiting', ...(run.state === 'paused' && lastDone ? { pausedAfter: lastDone.round } : {}), ...(run.tokenBudget > 0 ? { tokenBudget: run.tokenBudget } : {}),
    ...(run.stop ? { stop: run.stop } : {}) };
}

/**
 * The facts of the run a DRAFT is (its plan, `editorial.coverageSpec`, and its marker, `editorial.coverageRun`), for the draft page and the home row. While a job works on it, the job's live copy
 * (`job.coverageRun`: lib/contexts/generation/coverage-runs.js mirrorOf) is the newest word, so the same fact reads the same on the 任务 console, the draft page and the home row. `percent`: the coverage in percent.
 * null for a draft that has no plan.
 */
export function draftRunFacts(draft, { job, percent = null, coverage } = {}) {
  const spec = draft?.editorial?.coverageSpec, marker = draft?.editorial?.coverageRun;
  if (!spec?.rounds?.length) return null;
  const mirror = job?.coverageRun;
  if (mirror && Array.isArray(mirror.list) && mirror.list.length) return { ...runFacts({ rounds: roundList({ rounds: mirror.list }), run: mirror, percent: percent ?? mirror.percent ?? null }), live: ['queued', 'running'].includes(job.status), interrupted: job.status === 'interrupted' };
  const interrupted = !!marker && ['running', 'paused'].includes(marker.state);
  // A plan from phase 3a kept no round states: the run made its first round (the draft holds its questions) and nothing else.
  const legacy = !marker && spec.rounds.every(item => !item?.status) && (draft.cards?.length || 0) > 0;
  let rounds = roundList(spec, { interrupted }).map(item => (legacy && item.index === 0 ? { ...item, status: 'done' } : item)), run = marker || {};
  // Every section the plan wants has a question (the learner pressed the button for sections of several rounds, say): the rounds that never ran are not owed, the plan is complete (the run's own stop 'target').
  if (coverage?.sections?.length && spec.quotas?.length && !interrupted && rounds.some(item => item.status === 'pending') && !wantedUncovered(spec, coverage).size) {
    rounds = rounds.map(item => (item.status === 'pending' ? { ...item, status: 'skipped', reason: 'covered' } : item));
    run = { ...run, state: 'complete' };
  }
  return { ...runFacts({ rounds, run, percent }), live: false, interrupted };
}

/** A token budget as people type it: 800K, 2.5M, 1,200,000 or plain digits. Null for nothing, nonsense, or fewer than a thousand tokens. */
export function parseTokenBudget(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 1000 ? Math.round(text) : null;
  const match = /^\s*(\d[\d,]*(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(text ?? ''));
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, '')) * ({ '': 1, k: 1e3, m: 1e6 })[match[2].toLowerCase()];
  return Number.isFinite(value) && value >= 1000 ? Math.round(value) : null;
}
